# Ledger

Double-entry bookkeeping. Every movement of value is recorded twice, the two sides sum to zero, and
a posted journal is never edited.

- [Why double-entry](#why-double-entry)
- [Posting](#posting)
- [Account classes and the sign problem](#account-classes-and-the-sign-problem)
- [Correcting a mistake](#correcting-a-mistake)
- [The trial balance](#the-trial-balance)
- [What the database enforces](#what-the-database-enforces)
- [Idempotency](#idempotency)
- [Reading a balance](#reading-a-balance)
- [Closing a period](#closing-a-period)
- [Data model](#data-model)
- [Extension guide](#extension-guide)

---

## Why double-entry

Not accounting tradition. It is the only property that makes an error _findable_.

A single-entry system that loses a transaction has a wrong balance and no way to detect it. A
double-entry system that loses one side has a trial balance that does not balance, and the
discrepancy names the account. Every other integrity check in this phase reduces to that one.

## Posting

```ts
import { credit, debit } from '@trustsystem/ledger';

const journal = await ledger.post({
  organizationId,
  description: 'Card payment for ORD-1001',
  reference: 'ORD-1001',
  entries: [
    debit(customerAccount.id, money('102.50', 'USD'), { description: 'Payment' }),
    credit(merchantAccount.id, money('100.00', 'USD'), { description: 'Sale' }),
    credit(feeAccount.id, money('2.50', 'USD'), { description: 'Processing fee' }),
  ],
  idempotencyKey: `payment:${transaction.id}`,
});
```

Four things happen, in order, and all four before anything is durable:

1. **Validate** — every entry parses, every currency is permitted on this ledger.
2. **Balance** — debits equal credits, per currency. First, because it is the common mistake and
   should fail in microseconds.
3. **Hash** — SHA-256 over the entries, the effective date and the description.
4. **Write** — one insert, with the idempotency key.

### Amounts are always positive

An entry carries a `direction` and a positive amount. `debit(account, money('-1.00', 'USD'))` is
refused, and the message says a negative debit is a credit written backwards.

The reason is not tidiness. A ledger that accepts both has two representations of every posting, so
a report that groups by direction is wrong in a way nothing detects.

### Balancing is per currency

```ts
// Refused: 100 USD against 400,000 KHR does not balance, however close the rate.
entries: [debit(cash, usd('100.00')), credit(revenue, khr('400000'))];

// Correct: an exchange goes through an FX account with its own two entries.
entries: [
  credit(cashUsd, usd('100.00')),
  debit(fx, usd('100.00')),
  credit(fx, khr('400000')),
  debit(cashKhr, khr('400000')),
];
```

Netting across currencies inside one journal hides the rate that was used, which is the number
somebody will need.

### Effective date is not posting date

A settlement received on Monday for Friday's trading is effective Friday. Reports run on
`effectiveAt`; the audit trail uses `postedAt`. Conflating them makes a month-end report change
after the month has ended.

## Account classes and the sign problem

The ledger reports `debits − credits` and refuses to interpret it. What that number _means_ depends
on the account, and this is the part people get backwards.

| Class     | Increases with | Examples                                                    |
| --------- | -------------- | ----------------------------------------------------------- |
| asset     | debit          | bank accounts, cash, settlement receivables                 |
| expense   | debit          | fees paid, write-offs                                       |
| liability | **credit**     | **customer wallets**, merchant balances, reserves, suspense |
| equity    | credit         | retained earnings                                           |
| revenue   | credit         | fees earned                                                 |

> **A customer wallet is a liability.** Money a customer deposited is money the business owes them.
> The wallet account is _credited_ when they deposit and _debited_ when they spend, and its raw
> ledger balance is negative when it holds money.

A system that models a customer balance as an asset reports its own obligations as its own money.
Everything looks right until somebody asks how much the business actually has.

`@trustsystem/accounts` handles the sign:

```ts
const raw = await ledger.balances({ organizationId, accountIds: [wallet.accountId] });
// raw[0].balance  →  -100.00 USD

const balance = await accounts.balance(customerAccount);
// balance         →   100.00 USD    ← "there is this much in it", whatever the class
```

The schema refuses an account whose declared class contradicts its type, because that one mistake
reports every balance in it with the wrong sign — and the report looks like a ledger bug.

### The account types

| Type         | Class     | For                                                           |
| ------------ | --------- | ------------------------------------------------------------- |
| `customer`   | liability | A customer's balance                                          |
| `merchant`   | liability | A merchant's balance awaiting payout                          |
| `system`     | asset     | The business's own money: a bank account, a float             |
| `settlement` | liability | Instructed to a counterparty, not yet paid                    |
| `suspense`   | liability | Money that arrived and has not been identified                |
| `fee`        | revenue   | Fees earned                                                   |
| `reserve`    | liability | Withheld against chargebacks — still the counterparty's money |
| `general`    | declared  | Anything else                                                 |

**Open a suspense account before you need one.** Every real financial system receives money it
cannot identify, and a system without a suspense account puts it somewhere it does not belong —
usually revenue, where it is very hard to get back out. A suspense balance that is not zero at
close is a queue of work, which is exactly what it should be.

## Correcting a mistake

There is no `update` and there will not be one.

### Reversal — "this did not happen"

```ts
const { original, reversal } = await ledger.reverse({
  journalId,
  organizationId,
  reason: 'Charged in error — customer never received the goods.',
});
```

Posts the mirror image. Both journals remain and net to zero. The reason is required: it is the
only record of why the money moved back, and a year later the amounts alone do not say.

The reversal is dated **now**, not when the original was effective. A reversal posted in March for
a January journal belongs in March, or January's closed period changes after it closed.

Reversing twice is refused. The second reversal balances on its own, posts cleanly, and leaves the
account off by the original amount in the other direction.

### Adjustment — "this happened, and this much more"

```ts
await ledger.adjust({
  journalId,
  organizationId,
  reason: 'Fee under-charged by 0.10.',
  entries: [debit(customer, usd('0.10')), credit(feeAccount, usd('0.10'))],
});
```

A fee under-charged by 0.10 is an adjustment. Reversing and re-posting the whole fee makes the
customer's statement show a charge, a refund and a charge, which they read as an error.

## The trial balance

```ts
const trial = await ledger.trialBalance({ organizationId });

if (!trial.balanced) {
  // Every journal balances at posting, so this state is unreachable through the service.
}
```

The single most useful integrity check in the system, and the message says so:

> USD: debits 130.00 USD against credits 129.99 USD, out by 0.01 USD. Every journal balances at
> posting, so a trial balance that does not balance means the ledger was changed outside the
> application.

Run it nightly. A trial balance that has never been run is a trial balance that will not balance
the first time somebody runs it, and by then nobody knows when it started.

## What the database enforces

The service refuses these. So does PostgreSQL, because the application's own credentials can write
whatever they like.

| Guarantee                                  | Mechanism                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Debits equal credits, per currency         | `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, checked at commit |
| A posted journal cannot be edited          | `BEFORE UPDATE` trigger, permitting only the reversal marker              |
| A posted journal cannot be deleted         | `BEFORE DELETE` trigger                                                   |
| Entries of a posted journal are frozen     | `BEFORE UPDATE OR DELETE` trigger                                         |
| Amounts are positive                       | `CHECK (amount > 0)`                                                      |
| One posting per idempotency key per tenant | Partial unique index with `COALESCE` on the organization                  |

The balancing trigger is deferred deliberately: a non-deferred one fires after the first entry and
refuses every journal ever written, because one entry never balances.

`trustos financial doctor` checks that these are in your migrations. An application that copied the
schema and generated its own migration has the tables and none of the guarantees — everything
works, and the one thing the ledger is for quietly does not.

## Idempotency

```ts
await ledger.post({ /* … */ idempotencyKey: `payment:${transactionId}` });
```

A retried posting that posts twice doubles a movement of money, and the second posting is
indistinguishable from a legitimate second transaction for the same amount.

A duplicate-key conflict is a **success**: the caller retried, the first attempt won, and the
service returns that journal. Rethrowing would make the caller retry again.

The key is scoped to the tenant. Without that, one organization's retry collides with another's
first attempt and returns the wrong tenant's journal as a successful replay.

## Reading a balance

`LedgerStore.balances` aggregates **in the database**, not by summing journals in memory. A busy
account has millions of entries, and a balance query that reads them all times out at exactly the
moment somebody needs it.

```ts
const balances = await ledger.balances({
  organizationId,
  accountIds: [account.id],
  asOf: endOfJanuary, // a closed period does not move
});
```

## Closing a period

A closed period is one nothing may post into.

```ts
const march = await ledger.openPeriod({
  organizationId,
  code: '2026-03',
  startsAt: new Date('2026-03-01T00:00:00Z'),
  endsAt: new Date('2026-04-01T00:00:00Z'), // half-open: [start, end)
});

await ledger.closePeriod({ id: march.id, organizationId, actorId, note: 'Month-end close.' });
```

The failure this prevents: a report run in April for March, sent to somebody who acted on it, and
then a journal posted with a March effective date. The report is now wrong and nobody knows,
because reports are run on demand and nobody re-runs March.

**Closing is about the effective date, not the posting date.** A journal posted today with a March
effective date is exactly what closing prevents; a journal posted today with today's date is fine
however many periods are closed behind it. Checking the posting date would be useless — it is
always now — and freezing the whole ledger is the other way to get it wrong.

Three properties worth knowing:

- **The window is half-open**, so consecutive periods tile without a gap and without an overlap. An
  inclusive end makes midnight on the last day belong to two periods.
- **Closing records the trial balance**, rather than recomputing it later. Recomputing gives a
  different answer the moment anything is posted into a reopened period, and the number people need
  is the one the report they acted on was based on.
- **A period that does not balance cannot be closed** without `force`. Closing a broken period
  freezes the break, and the report everybody then works from is the wrong one.

### Reopening

```ts
await ledger.reopenPeriod({
  id: march.id,
  organizationId,
  reason: 'A supplier invoice arrived three weeks late and belongs in March.',
  actorId,
});
```

Loud on purpose: a reason is required and every reopening is kept on the period.

Refusing outright sounds stricter and is worse in practice. The correction still has to happen, so
it happens as a journal dated after the close with a description explaining that it belongs in
March — which is the same lie, told less legibly.

Periods are optional. Without a `PeriodStore` nothing is ever closed, which is the honest default:
a framework that invented periods would refuse postings for a reason nobody configured.

## Data model

```
  LedgerJournal ──1:n──▶ LedgerEntry
    id                     id
    organizationId         journalId ────┐
    ledgerId               accountId ────┼──▶ FinancialAccount
    reference              direction     │      id
    description            amount  ◀─────┘      code        (unique per tenant)
    status                 currency             name
    effectiveAt   ◀── periods check this        type        customer│merchant│system│
    postedAt                                    class       settlement│suspense│fee│
    reversedByJournalId                         currency    reserve│general
    reversesJournalId                           status
    contentHash   ◀── SHA-256, checked on read  ownerId
    idempotencyKey ◀── unique per tenant        allowNegative
                                                overdraftLimit

  AccountingPeriod
    code            '2026-03'
    startsAt        ─┐
    endsAt          ─┴─ half-open [start, end)
    status          open│closed
    closingTotals   the trial balance at the moment of closing
    reopenings      every reopen, with who and why
```

| Column                      | Type             | Note                                                              |
| --------------------------- | ---------------- | ----------------------------------------------------------------- |
| `LedgerEntry.amount`        | `Decimal(28, 8)` | Never `Float`. Always positive; `direction` carries the sign      |
| `LedgerJournal.effectiveAt` | `timestamp`      | When it is effective, not when it was written                     |
| `LedgerJournal.contentHash` | `text`           | Over the entries, effective date and description — not the status |
| `FinancialAccount.class`    | `text`           | Derived from `type`; the schema refuses a contradiction           |

## Extension guide

### A ledger store

```ts
export class PrismaLedgerStore implements LedgerStore {
  async insert(journal: Journal, idempotencyKey: string | null): Promise<Journal> {
    // Must be one transaction, and must let the unique index decide the winner.
    // A read-then-write passes every single-threaded test and posts twice under two workers.
  }

  async balances(input): Promise<AccountBalance[]> {
    // Must aggregate in the database. A busy account has millions of entries, and a balance query
    // that reads them all times out at exactly the moment somebody needs it.
  }
}
```

Three requirements, all of them load-bearing:

1. `insert` enforces the idempotency key with a **unique index**, scoped to the tenant with
   `COALESCE` on the organization.
2. `balances` aggregates in the database.
3. The migration carries the balancing and immutability triggers. `trustos financial doctor`
   checks this, because an application that copied the schema and generated its own migration has
   the tables and none of the guarantees.

### A currency

```ts
registry.register({
  code: 'POINTS',
  name: 'Loyalty points',
  exponent: 0,
  isFiat: false,
});
```

The exponent is the number of decimal places, and it is not cosmetic: every amount in the currency
is stored at that scale. KHR at exponent 2 carries two digits the currency does not have, and they
will be non-zero after a percentage fee.

### An account type

The eight shipped types cover what a payment platform needs. Anything else is `general` with an
explicit class:

```ts
await accounts.open({
  code: 'general.rounding.usd',
  name: 'Rounding differences',
  type: 'general',
  class: 'expense', // declared, because `general` implies nothing
  currency: 'USD',
});
```

## Related

- [wallet.md](wallet.md) — the view customers see
- [reconciliation.md](reconciliation.md) — checking the ledger against somebody else
- [financial-security.md](financial-security.md) — ledger tampering and what stops it
- [financial-architecture.md](financial-architecture.md) — where the ledger sits

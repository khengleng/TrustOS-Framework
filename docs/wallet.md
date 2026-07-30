# Wallets

A wallet is a **view over a ledger account**, not a balance of its own.

- [Why there is no balance column](#why-there-is-no-balance-column)
- [Three balances](#three-balances)
- [Holds](#holds)
- [Moving money](#moving-money)
- [Freezing](#freezing)
- [Statements](#statements)
- [Operating wallets](#operating-wallets)

---

## Why there is no balance column

A wallet with its own `balance` column has two sources of truth. They agree on the day they are
written and disagree within a month — a failed transaction that decremented the column and rolled
back the journal, a manual correction applied to one and not the other, a race between two workers.

By the time anybody notices, nobody knows which one is right, and the one everybody reads is the
cached one.

So the balance is computed from the ledger, every time. It is slower than reading a column and it
is correct, and the wallet and the ledger cannot disagree because there is only one of them.

A deployment that needs it faster caches it _beside_ the ledger with the journal id it was computed
at — which is a cache, and can be rebuilt.

## Three balances

```ts
const balance = await wallets.balance(walletId, organizationId);
// { total: 1000.00 USD, held: 300.00 USD, available: 700.00 USD, holdCount: 1 }
```

| Balance     | Meaning                                                                |
| ----------- | ---------------------------------------------------------------------- |
| `total`     | Everything the ledger says is in the wallet                            |
| `held`      | Placed against pending operations — an authorization, a pending payout |
| `available` | `total − held`. What can actually be spent                             |

**Every check is against `available`, never `total`.** A system with only a total authorizes the
same money twice: the first authorization has not moved anything, so the second one sees the whole
balance.

The error says so:

> 800.00 USD exceeds the available balance of 200.00 USD by 600.00 USD. The wallet holds 1000.00 USD
> in total, of which 800.00 USD is held against 1 pending operation(s).

## Holds

A hold moves nothing. The money stays in the wallet and stops being available, which is what an
authorization is: a promise that this much will be there when the capture arrives.

```ts
const { hold } = await wallets.hold({
  walletId,
  organizationId,
  amount: money('102.50', 'USD'),
  reason: 'Card authorization for ORD-1001',
  reference: transaction.id,
  expiresAt: addDays(now, 7),
});
```

### Every hold expires

`expiresAt` is required and there is no "no expiry" option.

A hold with no expiry against a process that died is money the customer cannot spend and nobody is
coming back for. The balance is simply wrong, permanently, and every support conversation about it
ends in a manual fix.

Run the sweeper:

```ts
await wallets.sweepExpiredHolds({ organizationId });
```

### Capture

```ts
await wallets.capture({
  holdId: hold.id,
  organizationId,
  amount: money('98.00', 'USD'), // less than authorized: the rest stays held
  toAccountId: merchantAccount.id,
  description: 'Final amount',
});
```

A partial capture leaves the remainder held rather than releasing it, because the common case — an
authorization for an estimate, captured for the final amount — usually has a second capture coming.
`release` gives the rest back when it does not.

Capturing more than was authorized is refused: that is a second transaction, not a capture.

One subtlety worth knowing: the hold being captured is added _back_ to availability for the
capture's own balance check. Otherwise every capture fails on a wallet whose whole balance is
authorized, which is the normal case.

## Moving money

```ts
await wallets.credit({
  walletId,
  organizationId,
  amount: money('100.00', 'USD'),
  fromAccountId: bankAccount.id, // no default — see below
  description: 'Deposit',
  idempotencyKey: `deposit:${externalId}`,
});
```

`fromAccountId` and `toAccountId` have no default. The other side of a deposit is a real decision —
a bank account, a provider float, a suspense account — and a default would be one of them chosen
for everybody.

Three things are refused:

- **A negative amount.** A negative credit is a debit written backwards, and it would skip the
  available-balance check on the way through.
- **The wrong currency.** A wallet holds one currency. Convert first and record the rate.
- **A debit the available balance cannot cover.** Against `available`, not `total`.

Limits are consumed on the way through, when the wallet declares any.

## Freezing

| State     | Money in | Money out |
| --------- | -------- | --------- |
| `active`  | yes      | yes       |
| `frozen`  | **no**   | yes       |
| `blocked` | no       | no        |
| `closed`  | no       | no        |

Frozen and blocked are different on purpose. A frozen customer can still be paid out and can still
have a settlement completed against them; a blocked one cannot, and their money is stuck until
somebody decides. Conflating the two means every freeze is the harsher one.

Freezing a wallet freezes the account behind it, so the two cannot disagree. The reason is
required: it is the only record of why somebody could not spend their own money, and a year later
the timestamp alone does not say.

## Statements

```ts
const report = await reporting.generalLedger({ organizationId, accountId, period });
const statement = toStatement(report, 'liability');
```

A statement signs amounts from the **holder's** point of view, not the accountant's. A customer
reading "debit 50.00" on their own statement reads it as money arriving, because that is what a
bank statement means to them — and the accounting sense is the opposite.

The running balance is what makes a statement useful: it turns "the balance is out by 12.50" into
"it was right until this line".

## Operating wallets

```bash
trustos financial doctor      # checks that a limit engine is wired, among other things
```

Four numbers to watch:

| Number                                   | Moving means                                                     |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Total held, as a share of total balances | Rising: something is authorizing and not capturing               |
| Holds released by the sweeper            | Rising: a process is dying between authorize and capture         |
| Oldest active hold                       | An authorization nobody is coming back for                       |
| Wallets frozen                           | Worth knowing; each one is somebody who cannot spend their money |

The sweeper number is the one to alert on. It is zero in a healthy system, and every hold it
releases was money a customer could not spend for as long as the hold lived.

## Related

- [ledger.md](ledger.md) — why a customer wallet is a liability
- [financial-security.md](financial-security.md) — double spending and what stops it
- [financial-architecture.md](financial-architecture.md) — where wallets sit

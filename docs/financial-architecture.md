# Financial architecture

Phase 8 is a reusable financial foundation: a ledger, accounts, wallets, transactions, settlement
and reconciliation, with nothing in it that belongs to one product.

> **This is not a bank and it is not a payment gateway.** It ships no scheme integration, no
> provider, no chart of accounts and no jurisdiction's rules. What it ships is the part every
> financial product needs and none of them should build twice.

- [The four rules](#the-four-rules)
- [How the pieces fit](#how-the-pieces-fit)
- [Money](#money)
- [The packages](#the-packages)
- [A payment, end to end](#a-payment-end-to-end)
- [What is deliberately absent](#what-is-deliberately-absent)
- [Choosing where to start](#choosing-where-to-start)
- [Running it](#running-it)

---

## The four rules

Everything in this phase follows from four rules, and each is enforced rather than documented.

**1. Money is never a float.** An amount is a bigint of scaled units plus a scale — see
[Money](#money). The dangerous failure is not `0.1 + 0.2`; it is a 2.5% fee on 1,234.56 computed in
a double, which is wrong in the fifteenth decimal place, rounds to the expected value, passes every
test somebody wrote, and disagrees with the provider once in ten thousand transactions.

**2. Every journal balances.** Debits equal credits, per currency, before anything posts — and the
database checks it again at commit with a deferred constraint trigger. This is the property that
makes an error _findable_: a single-entry system that loses a transaction has a wrong balance and
no way to know.

**3. A posted journal is immutable.** No edit, no delete. A correction is a reversal or an
adjustment, both of which post a new journal and leave the original standing. Enforced by a
database trigger, because the application's own credentials can `UPDATE` a row.

**4. Every movement is idempotent.** Every operation that moves money takes a key, and the store
enforces it with a unique constraint. A client with a 30-second timeout against a service with a
35-second p99 retries a meaningful fraction of everything, so "retried" is the normal case.

## How the pieces fit

```
                       application
                            │
   ┌────────────────────────┼─────────────────────────────┐
   │                        │                             │
   ▼                        ▼                             ▼
 wallet              transactions                    payments
 available/held      authorize → capture             payment requests
 holds, freeze       → complete → reverse            expiry, idempotency
   │                   │  │  │  │
   │                   │  │  │  └──▶ financial-risk    (AML, fraud, KYC — hooks only)
   │                   │  │  └─────▶ limits            (daily, monthly, velocity)
   │                   │  └────────▶ fees              (versioned schedules)
   │                   └───────────▶ fx                (rates, spread — no live feed)
   │                   │
   └───────────────────┴──────────────┐
                                      ▼
                                  accounts
                          customer · merchant · system
                          settlement · suspense · fee · reserve
                                      │
                                      ▼
                                   ledger
                        journals · entries · reversal
                        ┌───────────────────────────┐
                        │ debits == credits, always │
                        │ posted == immutable       │
                        └───────────────────────────┘
                                      │
       ┌──────────────────────────────┼──────────────────────────────┐
       ▼                              ▼                              ▼
  settlement                   reconciliation              financial-reporting
  batches, windows             matching, exceptions        GL, trial balance, CSV
  in-transit account           tolerance, queue            balance sheet, statements
```

Three couplings surprise people, so they are named here:

1. **A wallet has no balance.** It is a view over a ledger account, computed every time. A wallet
   with its own balance column has two sources of truth, they disagree within a month, and the one
   everybody reads is the wrong one.
2. **A customer wallet is a liability.** Money a customer deposited is money the business owes, so
   the account is _credited_ when they deposit. A system that models it as an asset reports its own
   obligations as its own money. See [ledger.md](ledger.md).
3. **Settlement goes through an intermediate account.** Money leaves the merchant and sits in a
   settlement account until the counterparty confirms. A system that debits the merchant and
   credits the bank directly cannot represent Friday-to-Monday and has no number to reconcile.

## Money

```ts
import { money, addMoney, allocateMoney, formatMoney } from '@trustos/financial-core';

const price = money('1234.56', 'USD'); // a string, never a number
const fee = multiplyMoney(price, parseDecimal('0.025')); // 30.86 USD, exactly
```

| Rule                                                      | Why                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Amounts are `{ currency, amount }` — never a bare number  | The most expensive bug in financial software is adding two currencies. It does not throw and the result is meaningless.         |
| A `Decimal` is `{ units: bigint, scale }`                 | Exact. 2^53 is reached by a national-currency total in minor units.                                                             |
| Division takes a rounding mode, explicitly                | It is the only lossy operation, and losing information silently is how a rounding policy becomes an accident.                   |
| The default is banker's rounding                          | Rounding halves upward adds half a minor unit of bias per tie. Over a million fees that is a real number in a suspense account. |
| `allocate` distributes remainders                         | 100 split three ways is 33.34/33.33/33.33. A system that loses the cent has an unbalanced ledger.                               |
| The registry ships eight currencies and no ISO 4217 table | Minor units vary by jurisdiction and the list changes. A partial list that looks complete is worse than none.                   |

There is a `unsafeToNumber`, named to be uncomfortable, for a display layer that cannot take a
string. Never use the result in a calculation.

## The packages

| Package               | What it is                                                                 |
| --------------------- | -------------------------------------------------------------------------- |
| `financial-core`      | Money, currencies, fixed-point decimals, rounding, allocation, identifiers |
| `ledger`              | Journals, entries, posting, reversal, adjustment, trial balance            |
| `accounts`            | The account tree and what each balance _means_                             |
| `wallet`              | Ledger-backed balances: total, held, available; holds with expiry          |
| `transactions`        | The lifecycle, as a declared state machine, with idempotency               |
| `payments`            | Payment requests: expiry, partial payment, callbacks                       |
| `fees`                | Flat, percentage, tiered, capped, tax, discount — versioned                |
| `limits`              | Per-transaction, daily, monthly, rolling; per currency and timezone        |
| `fx`                  | Rates with source and timestamp, spread, historical lookup                 |
| `settlement`          | Batches, instructions, windows, partial confirmation                       |
| `reconciliation`      | Matching, tolerance, an exception queue                                    |
| `financial-events`    | The event catalog. Amounts as strings, never numbers                       |
| `financial-policy`    | Allowed currencies, overdraft, approval thresholds                         |
| `financial-risk`      | AML, fraud, sanctions, KYC — extension points only                         |
| `financial-reporting` | GL, trial balance, balance sheet, statements, CSV                          |

## A payment, end to end

```
  customer                 platform                          merchant
     │                        │                                  │
     │  pay(request)          │                                  │
     ├───────────────────────▶│                                  │
     │                        ├─ risk.assess()      approve      │
     │                        ├─ fees.calculate()   2.50 USD     │
     │                        ├─ limits.consume()   within       │
     │                        │                                  │
     │                        ├─ wallet.hold(102.50)             │   authorized
     │                        │     ledger: nothing posted       │
     │                        │                                  │
     │                        ├─ wallet.capture()                │   captured
     │                        │     ledger: DR customer 102.50   │
     │                        │             CR merchant  100.00  │
     │                        │             CR fee         2.50  │
     │                        │                                  │
     │                        ├─ transaction.complete()          │   completed
     │                        │                                  │
     │                        │        ... end of day ...        │
     │                        ├─ settlement.send()               │   sent
     │                        │     ledger: DR merchant  100.00  │
     │                        │             CR settlement 100.00 │
     │                        │                                  │
     │                        │        ... bank confirms ...     │
     │                        ├─ settlement.confirm()            │   settled
     │                        │     ledger: DR settlement 100.00 │
     │                        │             CR bank       100.00 │
     │                        │                                  │
     │                        ├─ reconciliation.run()            │
     │                        │     bank statement vs the ledger │
```

Between "sent" and "settled" the settlement account holds exactly 100.00 — money that has been
instructed and not paid. That number is what a bank statement is checked against.

## What is deliberately absent

| Not here                                           | Where it belongs                                            |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Card schemes, bank rails, national payment schemes | A product built on this                                     |
| A chart of accounts for any jurisdiction           | The deployment                                              |
| Tax computation and filing                         | A tax product                                               |
| Fraud, AML and sanctions engines                   | A vendor, behind `RiskProvider`                             |
| KYC rules for any regulator                        | A vendor, behind `KycProvider`                              |
| Live exchange rate feeds                           | The deployment — which rate to use is a commercial decision |
| Interest, lending, savings products                | A product                                                   |
| Blockchain and stablecoin settlement               | Not in this phase                                           |
| Statement formats (MT940, CAMT, BAI2)              | A product                                                   |

The list is not a roadmap. A framework that shipped a card integration would be making a commercial
decision for every deployment, and the deployments that disagreed would carry it anyway.

## Choosing where to start

| You want to         | Install                     | Read                                   |
| ------------------- | --------------------------- | -------------------------------------- |
| Keep books          | `trustos add-module ledger` | [ledger.md](ledger.md)                 |
| Hold customer money | `+ wallet`                  | [wallet.md](wallet.md)                 |
| Move money          | `+ transactions`            | this document                          |
| Pay counterparties  | `+ settlement`              | [settlement.md](settlement.md)         |
| Check the books     | `+ reconciliation`          | [reconciliation.md](reconciliation.md) |

Everything depends on `ledger`.

## Running it

```bash
trustos add-module ledger
trustos financial doctor        # wiring, schema, triggers, currencies, precision — all offline
```

`trustos financial doctor` checks three things that a working application passes and should not: a
ledger with the tables and none of the database triggers, a monetary column declared `Float`, and a
zero-decimal currency configured with decimals. Each produces a system that works and is wrong.

## Related

- [ledger.md](ledger.md) — double-entry, account classes, reversal
- [wallet.md](wallet.md) — balances, holds, freeze
- [settlement.md](settlement.md) — batches and the in-transit account
- [reconciliation.md](reconciliation.md) — matching and the exception queue
- [financial-security.md](financial-security.md) — the threat model

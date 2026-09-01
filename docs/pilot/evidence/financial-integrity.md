# Financial integrity evidence

## The invariants

| Invariant                            | How it is held                                                   | Test                                                      |
| ------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------- |
| The wallet balance equals the ledger | Balance is _derived_ from the account's journals, never stored   | `keeps the wallet balance equal to what the journals say` |
| No journal for a refused payment     | The posting is the last step; a refusal returns before it        | `posts no journal for a refused payment`                  |
| Every journal balances               | `@trustsystem/ledger` refuses an unbalanced one                  | `refuses an unbalanced journal`                           |
| A posted journal is immutable        | There is no `update` and no `delete` on the ledger               | `offers no way to update a posted journal`                |
| No float on the payment path         | Amounts are strings; arithmetic is `@trustsystem/financial-core` | `never floats the money`                                  |

## The measurement

Five payments of 100.00 with a 0.50% fee:

```text
gross   500.00
fee       2.50
net     497.50   ← the wallet balance, to the minor unit
```

The test asserts `balance.total.amount.units === totals.net.amount.units` and separately that it
equals `money('497.50')`. Two assertions because the first would pass if both sides were wrong in
the same way.

## The journal

One journal per payment, three entries:

```text
debit   clearing        10.00     gross received
credit  merchant wallet  9.95     net proceeds
credit  fee revenue      0.05     merchant service fee
```

**One journal, not two.** Posting the payment and the fee separately means a window in which the
merchant's balance is wrong, and that window is where a reconciliation exception is born.

**And no separate credit.** The wallet balance is derived from the ledger, so calling
`WalletService.credit` _as well_ would post a second journal and count the money twice. The pilot's
first version did exactly that, and the balance assertion caught it — see the productivity report,
finding 3.

## The fee

From `@trustsystem/fees`, priced by a schedule that lives in configuration.

| Amount   | Fee  | Why                                    |
| -------- | ---- | -------------------------------------- |
| 200.00   | 1.00 | 0.50%                                  |
| 10.00    | 0.05 | 0.50% is 0.05, which is also the floor |
| 1.00     | 0.05 | 0.50% is 0.005, below the 0.05 floor   |
| 1,000.00 | 2.00 | Against a schedule with a 2.00 ceiling |

The specification requires that the fee not be hardcoded in a controller. A test changes the
schedule to 1.00% and asserts the fee changes with no code change.

## What happens when the posting fails

The payment fails. The limit has already been consumed under the same idempotency key, and that is
the correct direction to be wrong in: the merchant can retry with the same reference and the limit
will not double-count, whereas a payment confirmed without a journal is money the platform believes
it holds and cannot account for.

## Idempotency

| Test                                                  | Result                                             |
| ----------------------------------------------------- | -------------------------------------------------- |
| A repeated reference                                  | **Replays** — same journal id, one payment counted |
| A repeated reference, eight requests concurrently     | **One journal**                                    |
| A repeated reference does not consume the limit twice | **Pass**                                           |
| A different reference                                 | **A second payment**                               |
| The same reference in another tenant                  | **A second payment**                               |

The concurrent case is the one that is actually hard. A client whose connection drops retries
immediately, and the two requests overlap.

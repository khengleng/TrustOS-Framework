# Financial security

The threat model for the financial platform, and which control actually holds for each threat.
Read [threat-model.md](threat-model.md) for the platform underneath.

> **Every financial action is audited.** Every posting with its accounts and amounts, every
> reversal with its reason, every status change, every limit refusal, every reconciliation
> resolution.

- [The threats](#the-threats)
- [Double spending](#double-spending)
- [Duplicate transactions and replay](#duplicate-transactions-and-replay)
- [Ledger tampering](#ledger-tampering)
- [Balance corruption](#balance-corruption)
- [Cross-tenant access](#cross-tenant-access)
- [Unauthorized reversal](#unauthorized-reversal)
- [Precision, overflow and underflow](#precision-overflow-and-underflow)
- [What is audited](#what-is-audited)
- [Incident playbook](#incident-playbook)

---

## The threats

| Threat                | The control that holds                                                 | Supporting                         |
| --------------------- | ---------------------------------------------------------------------- | ---------------------------------- |
| Double spending       | Holds, and checks against `available` not `total`                      | Limits, database constraints       |
| Duplicate transaction | Idempotency key with a unique index                                    | Returning the original on conflict |
| Replay attack         | Same, plus tenant scoping in the key                                   | Audit trail                        |
| Ledger tampering      | `BEFORE UPDATE/DELETE` triggers, content hash                          | Trial balance                      |
| Balance corruption    | No balance column; balances computed from the ledger                   | Deferred balancing trigger         |
| Cross-tenant access   | `organizationId` on every store call, `COALESCE` in every unique index | Per-record checks                  |
| Journal modification  | Database trigger; only the reversal marker may change                  | Content hash on read               |
| Unauthorized reversal | Separate permission; policy requires approval by default               | Reason required and audited        |
| Precision errors      | Fixed-point decimals; `Float` refused in review and by the doctor      | Explicit rounding modes            |
| Overflow              | `bigint` units, `Decimal(28, 8)` columns                               | —                                  |
| Underflow             | Allocation distributes remainders exactly                              | Sum-back tests                     |

## Double spending

**The control is the hold, and the rule that every check is against `available`.**

```
   balance 1000, authorization A for 800 held
      │
      └─ authorization B for 800
             available = 1000 − 800 = 200
             refused: "exceeds the available balance of 200.00 USD by 600.00 USD"
```

A system that checks `total` sees 1000 for both authorizations, because the first has not moved
anything yet. Both succeed, the second capture fails at settlement, and the customer has spent
money twice.

Three supporting controls:

- **Limits are consumed, not just checked.** `check` is a read; two concurrent callers both see
  room. `consume` records, and the store must do it atomically inside the same database transaction
  as the posting.
- **The account may not go negative.** Off by default and for almost everything. A customer balance
  that can go negative is an unsecured loan nobody decided to make.
- **The database refuses a negative entry amount.** A negative credit would be a debit that skipped
  the balance check.

## Duplicate transactions and replay

Every operation that moves money takes an idempotency key, and the store enforces it with a
**unique index** — not a check.

```ts
await ledger.post({ /* … */ idempotencyKey: `payment:${transactionId}` });
```

A read-then-write implementation passes every single-threaded test and posts twice the moment two
workers retry together. The database decides the winner; the loser reads the winner's journal and
returns it as a success.

**The key is scoped to the tenant.** `COALESCE("organizationId", '')` in the index, because
PostgreSQL treats NULL as distinct from NULL — a plain unique constraint accepts unlimited
platform-level duplicates. Without the scope, one organization's retry collides with another's
first attempt and returns the wrong tenant's transaction as a successful replay.

**A key reused with different parameters is a conflict, not a replay:**

> The idempotency key "idm_1" was already used for a payment of 100.00 USD, and this request is a
> payment of 500.00 USD. Returning the earlier result would tell you a different payment succeeded.

## Ledger tampering

Three layers, and the third is the one that matters.

1. **The service** has no `update` and no `delete`. There is no code path.
2. **The database** refuses `UPDATE` and `DELETE` on a posted journal and its entries, by trigger.
   A `BEFORE` trigger applies to the table owner, which a `REVOKE` does not — and the application
   usually _is_ the owner.
3. **The content hash** is verified on every read that matters. SHA-256 over the entries, the
   effective date and the description — not the status, because marking a journal reversed is a
   legitimate change.

A mismatch refuses to return the journal:

> Journal jrn_abc does not match its content hash. A posted journal is immutable, so this means the
> row was changed outside the application. Do not use this journal; investigate before anything else.

**What this does not protect against:** a superuser can drop the trigger. It is a control against
application bugs, a compromised application role and well-meaning manual edits. Defending against a
compromised database administrator requires shipping journals off-host to append-only storage.

## Balance corruption

The strongest control here is an absence: **there is no balance column**.

A wallet with one has two sources of truth. They disagree within a month — a failed transaction
that decremented the cache and rolled back the journal, a manual correction applied to one and not
the other — and the one everybody reads is the cached one.

Supporting:

- **Every journal balances**, checked at commit by a deferred constraint trigger.
- **The trial balance** is the system-wide check, and the message says what a failure means:
  the ledger was changed outside the application.
- **A journal line that cancels itself out is refused.** A debit and a credit to the same account
  for the same amount balances perfectly and moves nothing — usually a transfer where both sides
  resolved to the same account, and invisible in every balance because it nets to zero.

## Cross-tenant access

The quietest failure in the phase. Nothing throws, nothing looks wrong, and the balance is a number.

| Surface                     | Control                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| Journals and entries        | `organizationId` on every query; indexes lead with it                    |
| Accounts                    | Unique code per tenant, with `COALESCE`                                  |
| Wallets                     | Unique per `(tenant, owner, currency)`, with `COALESCE`                  |
| Idempotency keys            | Scoped to the tenant in the index                                        |
| Balance queries             | A mixed-tenant batch is refused rather than silently scoped to the first |
| Limits, fees, rates, policy | Every lookup takes the tenant                                            |

**Null is a tenant, not a wildcard.** The platform organization is `''` in a `COALESCE` index and a
query for `organizationId: null` returns platform rows only. Treating null as "match everything"
turns one careless default into a full leak.

## Unauthorized reversal

A reversal moves money back on one person's decision, and it is the one operation in the phase that
can be used to hide another.

- **A separate permission.** `ledger.journal.reverse` is not `ledger.journal.post`.
- **The tenant policy requires approval by default.** `requireApprovalForReversal` is `true`, and
  turning it off should be a conversation.
- **A reason is required**, and it is the only record of why the money moved back.
- **Reversing twice is refused.** The second reversal balances on its own, posts cleanly, and
  leaves the account off by the original amount in the other direction.

## Precision, overflow and underflow

| Risk                               | Control                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Floating-point error               | Fixed-point decimals throughout. `Decimal(28, 8)` columns. `trustos financial doctor` fails on a `Float` monetary column or `parseFloat` near an amount       |
| Rounding bias                      | Banker's rounding by default. Rounding halves upward adds half a minor unit of bias per tie, which over a million fees is a real number in a suspense account |
| Silent rounding                    | Division takes a rounding mode explicitly. It is the only lossy operation                                                                                     |
| Overflow                           | `bigint` units. 2^53 is reached by a national-currency total in minor units; `Number` would have lost it                                                      |
| Underflow in allocation            | `allocate` distributes remainders one minor unit at a time, deterministically. 100 split three ways is 33.34/33.33/33.33 and sums back exactly                |
| Precision a currency does not have | Amounts are stored at the currency's own scale. KHR at scale 2 carries two digits the currency does not have, and they are non-zero after a percentage fee    |
| Wrong-currency arithmetic          | `Money` refuses it. No operation combines two currencies                                                                                                      |

## What is audited

| Action                                                       | Records                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `ledger.journal.posted`                                      | Every account, direction and amount that moved            |
| `ledger.journal.reversed`                                    | The reversal journal and the reason                       |
| `ledger.account.opened` / `.frozen` / `.blocked` / `.closed` | Type, class, currency, and the reason                     |
| `wallet.credited` / `.debited`                               | Amount, description, journal                              |
| `wallet.hold.placed` / `.captured` / `.released`             | Amount, reason, expiry                                    |
| `wallet.frozen` / `.unfrozen`                                | The reason somebody could not spend their money           |
| `transactions.transaction.*`                                 | Every state change with the amount and the journal        |
| `transactions.request.*`                                     | Payment requests raised, settled and cancelled            |
| `settlement.batch.*`                                         | Every transition with the total and the instruction count |
| `reconciliation.run.completed`                               | Counts, difference and the tolerance applied              |
| `reconciliation.exception.resolved` / `.written_off`         | The explanation and any correcting journal                |

An auditor asks two questions: what moved, and who decided. Every record above answers both.

## Incident playbook

**The trial balance does not balance.**
Stop posting. Every journal balances at posting, so this state is unreachable through the service —
the data was changed outside the application. Find the journal whose content hash fails, and check
the audit log for the window. Do not "fix" the balance with a correcting entry until you know what
happened; a correction hides the evidence.

**A customer was charged twice.**
Check the two transactions' idempotency keys. Same key means the store's unique index is missing or
the retry did not carry the key. Different keys means two genuinely different requests, and the
question is at the caller. Refund, do not reverse: reversing erases a transaction that happened.

**A wallet balance looks wrong.**
Run the general ledger for its account. The running balance turns "out by 12.50" into "it was right
until this line". If the ledger is right and a cached figure is wrong, the cache is the bug — and
if there is a cache, that is worth revisiting.

**A settlement account is not zero.**
There is a batch nobody confirmed. `settlement.inTransit` lists them. Each one is money that has
left a merchant and not reached a bank.

**A rate feed stopped.**
Conversions fail rather than using last week's number — that is what `maxRateAgeMs` is for. If
conversions are _succeeding_ on a dead feed, the tolerance is too generous, and every conversion
since the feed died is wrong by however much the rate has moved.

**Money arrived that nobody expected.**
A `missing_internal` reconciliation exception. Post it to suspense, not to revenue. Suspense is
where unidentified money belongs, and revenue is where it becomes very hard to get back out.

## Related

- [ledger.md](ledger.md) — what the database enforces
- [wallet.md](wallet.md) — holds and available balance
- [reconciliation.md](reconciliation.md) — the exception queue
- [threat-model.md](threat-model.md) — the platform threat model
- [integration-security.md](integration-security.md) — the same discipline, phase 6

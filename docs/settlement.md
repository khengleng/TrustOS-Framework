# Settlement

Paying counterparties in batches, on a schedule, and knowing afterwards exactly which transactions
were in which batch.

- [Asynchronous by construction](#asynchronous-by-construction)
- [The settlement account](#the-settlement-account)
- [The lifecycle](#the-lifecycle)
- [Partial confirmation](#partial-confirmation)
- [Failure](#failure)
- [Adjustments](#adjustments)
- [The settlement report](#the-settlement-report)
- [Operating settlement](#operating-settlement)
- [Data model](#data-model)
- [Sequence: a batch, end to end](#sequence-a-batch-end-to-end)
- [Extension guide](#extension-guide)

---

## Asynchronous by construction

A batch is created, closed, sent and confirmed. Two of those involve waiting for somebody else.

The most common design mistake here is a synchronous `settle()` that assumes the counterparty
answers, and it produces a system that cannot represent the ordinary case: a batch sent on Friday
afternoon and confirmed on Monday morning. Everything about how the money is modelled follows from
being able to represent that weekend.

## The settlement account

This is the whole mechanism.

```
  before        merchant  600.00        bank  1000.00        settlement  0.00

  send          merchant    0.00        bank  1000.00        settlement  600.00
                └─ DR merchant 600, CR settlement 600

  confirm       merchant    0.00        bank   400.00        settlement  0.00
                └─ DR settlement 600, CR bank 600
```

Between the two, the settlement account holds exactly what has been **instructed and not paid**.
That number is checkable against a bank statement, and a settlement account that is not zero after
every batch has confirmed is a batch nobody confirmed.

A system that debits the merchant and credits the bank directly has no way to represent
Friday-to-Monday and no number to reconcile.

### It is a liability, not an asset

Worth stating, because the other model is defensible and incompatible.

"Cash in transit" is an asset: money that has left your bank and not arrived. This is settlement
_payable_: you have instructed the bank, the cash is still in your bank account, and you owe it to
the counterparty until it leaves.

The platform instructs rather than moving cash itself, so payable is the accurate model — and the
journals are written to match. Changing the account class without changing the journals reports
every in-transit balance with the wrong sign.

## The lifecycle

```
   open ──▶ pending ──▶ sent ──▶ settled
     │         │          │
     └─────────┴──▶ cancelled
                          └──▶ failed
```

```ts
const batch = await settlement.openBatch({
  organizationId,
  currency: 'USD',
  windowStart,
  windowEnd,
  settlementAccountId,
});

await settlement.addInstruction({
  batchId: batch.id,
  organizationId,
  counterpartyId: 'mer_a',
  sourceAccountId: merchantAccount.id,
  amount: money('600.00', 'USD'),
  transactionIds: ['txn_1', 'txn_2'], // what this settles
});

await settlement.closeBatch({ id: batch.id, organizationId });
await settlement.sendBatch({ id: batch.id, organizationId, externalReference: 'FILE-2026-03-01' });
```

Four rules:

- **Instructions go into an open batch only.** Adding to a sent batch means the counterparty
  received a file that no longer matches what the platform thinks it sent, and the difference is
  discovered during reconciliation weeks later.
- **One batch, one currency.** A mixed batch has a total that means nothing.
- **An empty batch is refused.** An empty file to a counterparty is at best noise and at worst a
  signal that something upstream failed to produce instructions — and the batch still appears on
  the settlement report as if it did something.
- **The window has both ends.** "Everything completed between these two instants" is reproducible;
  a batch defined only by when it ran cannot be rebuilt.

## Partial confirmation

A counterparty returning three instructions out of two hundred is ordinary.

```ts
await settlement.confirmBatch({
  id: batch.id,
  organizationId,
  destinationAccountId: bankAccount.id,
  returned: [{ instructionId: 'sti_9', reason: 'Account closed at the bank.' }],
});
```

Returned money goes back to **the account it came from**, per instruction. A lump sum landing
somewhere for somebody to allocate is how a merchant's balance ends up wrong for a week.

Each returned instruction keeps its reason, which is what the merchant asks for when they notice
they were not paid.

A system that can only accept a batch wholly has to reverse and re-send the entire thing for three
rejections.

## Failure

```ts
await settlement.failBatch({ id: batch.id, organizationId, reason: 'The bank rejected the file.' });
```

Reverses the send. Every merchant is back where they were, the settlement account returns to zero,
and the trial balance still balances.

## Adjustments

The batch confirmed on Monday. On Thursday the bank's statement shows 4.50 less, because they
deducted a fee nobody modelled.

```ts
await settlement.adjustBatch({
  id: batch.id,
  organizationId,
  kind: 'counterparty_fee',
  amount: money('-4.50', 'USD'), // signed: negative means they paid less
  reason: 'The bank deducted a 4.50 processing fee not modelled in the batch.',
  counterAccountId: bankChargesAccount.id,
});
```

**Never by editing the batch.** A settled batch is what the counterparty was told and what the
reconciliation ran against. Editing it to match the statement makes the two agree by destroying the
evidence of the disagreement, and the fee the counterparty deducted becomes invisible.

The amount is **signed**, and it is the one place in the phase where an amount is. Positive means
the counterparty paid more than the batch said; negative means less. A direction field would need
every reader to know whose point of view it is from, and an adjustment is read by whoever is
holding a bank statement.

| Kind                | For                                                       |
| ------------------- | --------------------------------------------------------- |
| `counterparty_fee`  | A fee they deducted                                       |
| `amount_difference` | Any other difference between instructed and received      |
| `fx_difference`     | An exchange difference between instruction and settlement |
| `chargeback`        | A return arriving after the batch settled                 |
| `other`             | Described in the reason                                   |

An adjustment against a batch that has not been sent is refused: no money has moved, so there is
nothing to correct — change the instruction while the batch is open.

## The settlement report

```ts
const report = await settlement.report({ id: batch.id, organizationId });
// { instructionCount, total, settled, returned, failed, pending,
//   adjusted, netSettled, counterparties, instructions, adjustments }
```

`netSettled` is `settled + adjusted` — what the counterparty **actually paid**, which is not the
batch total once anything has been adjusted. `settlementDifference` compares against it, because
comparing the unadjusted total would report the same difference every month until somebody noticed
the adjustment existed.

The `transactionIds` on each instruction are what make a batch explicable afterwards. Six months
later the question is "why was this merchant paid 4,182.15 on the third", and the answer is a list
of transactions.

## Operating settlement

| Number                           | Meaning                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| Settlement account balance       | What has been instructed and not paid. Should be zero between batches. |
| Oldest batch in `sent`           | A batch nobody confirmed. Every one is money in limbo.                 |
| Returned instructions, by reason | A counterparty's rejections cluster; the cluster names the problem.    |
| Batches with no instructions     | Something upstream is not producing them.                              |

The first is the one to reconcile daily. It is a single number, it should match a bank statement,
and when it does not the difference is the batch that went wrong.

## Data model

```
  SettlementBatch ──1:n──▶ SettlementInstruction
    id                        id
    reference                 batchId
    currency                  counterpartyId
    status   open→pending→    sourceAccountId ──▶ FinancialAccount (a merchant balance)
             sent→settled     amount
    windowStart ─┐            status  pending→sent→settled│returned│failed
    windowEnd  ──┴─ what      transactionIds ◀── what this settles; makes a batch
                   makes a                       explicable six months later
                   batch      externalReference
                   rebuildable
    settlementAccountId ──▶ FinancialAccount (liability: instructed, not yet paid)
    totalAmount
    journalIds     send, confirm, and every adjustment
       │
       │ 1:n
       ▼
  SettlementAdjustment
    kind        counterparty_fee│amount_difference│fx_difference│chargeback│other
    amount      SIGNED — the only signed amount in the phase
    reason      required
    counterAccountId    where the difference is booked
    journalId           the correcting posting
    instructionId       when it is attributable to one
```

## Sequence: a batch, end to end

```
  platform                    ledger                         counterparty
     │                          │                                  │
  openBatch                     │                                  │
  addInstruction × 2            │                                  │
  closeBatch                    │                                  │
     │                          │                                  │
  sendBatch ───────────────────▶│  DR merchant A 600               │
     │                          │  DR merchant B 400               │
     │                          │  CR settlement 1000              │
     │                          │                                  │
     │            settlement account now holds 1000 ───────────────┤ file sent
     │                          │                                  │
     │                    ... Friday to Monday ...                 │
     │                          │                                  │
  confirmBatch ◀────────────────┼──────────────────────────────────┤ B returned:
     │                          │  DR settlement 1000              │ account closed
     │                          │  CR bank        600              │
     │                          │  CR merchant B  400  ◀── back to where it came from,
     │                          │                          per instruction, not as a lump sum
     │            settlement account back to zero                  │
     │                          │                                  │
     │                    ... Thursday, the statement ...          │
     │                          │                                  │
  adjustBatch ─────────────────▶│  DR bank charges 4.50            │
     │                          │  CR settlement   4.50            │
     │                                                             │
  report().netSettled = 595.50 ── reconciles clean against the statement
```

## Extension guide

### A settlement store

Nothing unusual — batches, instructions and adjustments, each scoped by tenant. The one thing worth
indexing carefully is `listBatches({ status: 'sent' })`, because that is the in-transit query an
operator runs every morning.

### The file a counterparty receives

The framework produces the instructions and the totals; the format belongs to whoever is being
paid. There is no `SettlementFileWriter` interface, deliberately: every counterparty's format
differs in ways an interface would have to model badly, and a bad abstraction over four bank
formats is worse than four small writers.

```ts
const report = await settlement.report({ id: batch.id, organizationId });
const rows = settlementReportRows(report); // from @trustsystem/financial-reporting
// …then write whatever the bank asked for.
```

### Netting across counterparties

Not supported, and it is not an oversight. Netting means one instruction paying several
counterparties' positions against each other, which changes who is owed what — a commercial
arrangement with legal consequences, not a technical feature. A deployment that nets does it by
producing net instructions before the batch, where the arithmetic is visible.

## Related

- [ledger.md](ledger.md) — the journals settlement posts
- [reconciliation.md](reconciliation.md) — checking a batch against a bank statement
- [financial-architecture.md](financial-architecture.md) — where settlement sits

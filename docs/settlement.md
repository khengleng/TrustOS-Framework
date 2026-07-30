# Settlement

Paying counterparties in batches, on a schedule, and knowing afterwards exactly which transactions
were in which batch.

- [Asynchronous by construction](#asynchronous-by-construction)
- [The settlement account](#the-settlement-account)
- [The lifecycle](#the-lifecycle)
- [Partial confirmation](#partial-confirmation)
- [Failure](#failure)
- [The settlement report](#the-settlement-report)
- [Operating settlement](#operating-settlement)

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

## The settlement report

```ts
const report = await settlement.report({ id: batch.id, organizationId });
// { instructionCount, total, settled, returned, failed, pending, counterparties, instructions }
```

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

## Related

- [ledger.md](ledger.md) — the journals settlement posts
- [reconciliation.md](reconciliation.md) — checking a batch against a bank statement
- [financial-architecture.md](financial-architecture.md) — where settlement sits

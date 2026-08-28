# Reconciliation

Comparing what the platform believes against what somebody else believes, and producing a list a
person can work through.

- [The output is a queue](#the-output-is-a-queue)
- [Running one](#running-one)
- [How matching works](#how-matching-works)
- [The exception kinds](#the-exception-kinds)
- [Tolerance](#tolerance)
- [The queue](#the-queue)
- [Operating reconciliation](#operating-reconciliation)
- [Data model](#data-model)
- [Sequence: a daily run](#sequence-a-daily-run)
- [Extension guide](#extension-guide)

---

## The output is a queue

A reconciliation that reports "£3.42 out" has told nobody anything actionable.

What is needed is: these four records are on the statement and not in the ledger, these two are in
the ledger and not on the statement, and these three match on reference but differ on amount. Each
of those is a different investigation, and one of them is urgent in a way the others are not.

So the result is a **run** with a difference and an **exception per discrepancy**, each with enough
detail that whoever picks it up does not have to re-derive what happened.

## Running one

Both sides are supplied by the caller. The platform cannot know how to read a counterparty's file,
and which ledger accounts are in scope is a deployment decision. What the framework owns is the
comparison — the part that is the same everywhere and easy to get subtly wrong.

```ts
const { run, exceptions } = await reconciliation.run({
  organizationId,
  key: 'bank.usd',
  kind: 'external',
  currency: 'USD',
  windowStart,
  windowEnd,
  internal: ledgerRows.map(toRecord),
  external: bankStatement.map(toRecord),
  tolerance: {
    amount: '0.01',
    reason: 'The card network rounds each conversion leg to the cent.',
  },
});
```

A record from either side reduces to the same shape:

```ts
{ reference: 'ORD-1001', amount: { currency: 'USD', amount: '100.00' }, at, sourceId, description }
```

## How matching works

**By reference first, amount second.**

Amount-only matching pairs two unrelated £50 payments and reports a clean reconciliation, which is
worse than reporting two exceptions — a clean run nobody investigates is how a difference survives
to the next month, and the next.

The comparison is pure: two lists in, a result out, the same answer on every machine. The most
common question about a reconciliation is "why did it match last month and not this month", and a
comparison that depended on anything but its inputs could not answer it.

## The exception kinds

| Kind                 | Meaning                                       | Usually                                                     |
| -------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `missing_internal`   | On the statement, not in the ledger           | **The most urgent.** Money the platform does not know about |
| `missing_external`   | In the ledger, not on the statement           | A posting that never reached the counterparty               |
| `amount_mismatch`    | Both present, amounts differ beyond tolerance | A fee, a rounding rule, or a genuine error                  |
| `date_mismatch`      | Match on amount, far apart in time            | Settlement timing. Not a failure                            |
| `duplicate_internal` | Two ledger records, one reference             | A double posting                                            |
| `duplicate_external` | Two statement records, one reference          | The counterparty sent it twice                              |

A duplicate is reported **before** matching is attempted. Matching one of them would leave the
other looking like an orphan and hide the duplication, which is almost always a double posting.

`date_mismatch` still counts as matched: the money is there and the timing is the observation.
Settlement genuinely takes days; a gap that grows month over month is a counterparty whose
processing is slipping.

## Tolerance

A one-cent difference on a card settlement is rounding. A one-cent difference on an internal
transfer is a bug. A single global tolerance means either the first floods the queue or the second
never appears.

So tolerance is per run, and **the reason is required**:

```ts
tolerance: { amount: '0.01', reason: 'The card network rounds each conversion leg to the cent.' }
```

That is not decoration. A tolerance is a decision to stop looking at differences below a size, and
in a year the only question anybody asks about it is why.

The default is exact matching, and it says so: _"Exact matching: no difference is tolerated."_

## The queue

```ts
await reconciliation.assign({ id, organizationId, assignTo: 'usr_ops' });

await reconciliation.resolve({
  id,
  organizationId,
  resolution:
    'A deposit we had not recorded. Posted to suspense and identified from the reference.',
  correctionJournalId: journal.id,
});
```

An exception queue that nobody owns is a list that grows. Assignment is the difference between a
queue and a graveyard.

**A resolution needs an explanation.** A closed ticket with no reason means the same difference
appears next month with nobody knowing it was already looked at — so the second person spends the
same two hours the first one did.

A **write-off** is distinct from a resolution:

```ts
await reconciliation.resolve({
  id,
  organizationId,
  resolution: 'Two cents. Below the cost of investigating.',
  writeOff: true,
});
```

Both close the item; they mean different things on a report, and a report that cannot tell them
apart cannot say how much was investigated and how much was given up on.

## Operating reconciliation

```ts
const health = await reconciliation.queueHealth(organizationId);
// { open, investigating, oldestOpenAgeMs, byKind }
```

| Number                    | What it means when it moves                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Oldest open exception** | The number to watch. A six-week-old item is a queue where somebody has decided, without saying so, that one difference is not worth investigating |
| Open count                | Rising steadily: the queue is not staffed for the volume                                                                                          |
| `missing_internal` count  | Money arriving that the platform does not know about. Investigate first, always                                                                   |
| Run difference over time  | A difference that grows by roughly the same amount each period is a systematic error, not a series of mistakes                                    |

Run reconciliation daily, not monthly. A daily run finds a difference against one day of
transactions; a monthly one finds the same difference against thirty.

## Data model

```
  ReconciliationRun ──1:n──▶ ReconciliationException
    id                         id
    key      bank.usd          runId
    kind     internal│external kind      missing_internal│missing_external│
    currency                             amount_mismatch│date_mismatch│
    windowStart ─┐                       duplicate_internal│duplicate_external
    windowEnd  ──┴─ what makes  status    open│investigating│resolved│written_off
                    a run          reference   what both sides should agree on
                    reproducible   internalAmount ─┐
    internalCount                  externalAmount ─┼─ both sides, so the exception
    externalCount                  difference     ─┘   is readable without re-deriving
    matchedCount                   internalId / externalId
    exceptionCount                 detail        written once, read by whoever picks it up
    internalTotal                  assignedTo    a queue nobody owns is a list that grows
    externalTotal                  resolution    required to close
    difference   external − internal
    tolerance    { amount, dateMs, reason }   ◀── the reason is required
```

| Column                           | Type             | Note                                                                      |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| `ReconciliationRun.difference`   | `Decimal(28, 8)` | `external − internal`                                                     |
| `ReconciliationRun.tolerance`    | `jsonb`          | Carries the _reason_, which is the only thing anybody asks about it later |
| `ReconciliationException.detail` | `text`           | Written at detection, with enough to act on                               |

## Sequence: a daily run

```
  scheduler        application            reconciliation           queue
     │                  │                       │                    │
  06:00 ───────────────▶│                       │                    │
     │            read the ledger side          │                    │
     │            read the bank file            │                    │
     │                  ├──────────────────────▶│                    │
     │                  │   compare(internal, external, tolerance)   │
     │                  │                       │                    │
     │                  │   index by reference, not by amount        │
     │                  │   ├─ duplicates first (before matching)    │
     │                  │   ├─ amount within tolerance? matched      │
     │                  │   ├─ dates far apart? matched + observed   │
     │                  │   └─ unmatched on either side? exception   │
     │                  │                       ├───────────────────▶│ 4 exceptions
     │                  │◀── run + exceptions ──┤                    │
     │                                                               │
  08:30   an operator opens the queue, oldest first                  │
             ├─ assign  ─────────────────────────────────────────────▶ investigating
             └─ resolve with an explanation, and a correcting journal
                where one was needed
```

## Extension guide

### Supplying the two sides

Both are the caller's, and that is deliberate: the platform cannot know how to read a
counterparty's file, and which ledger accounts are in scope is a deployment decision.

```ts
const internal = (await ledger.list({ organizationId, accountId: bankAccount.id, from, to })).map(
  (journal) => ({
    reference: journal.reference ?? journal.id,
    amount: totalFor(journal, bankAccount.id),
    at: journal.effectiveAt,
    sourceId: journal.id,
  }),
);

const external = parseStatement(file); // yours
```

The one rule: **the reference must be the thing both sides agree on**. If the bank echoes your
payment reference, use it. If it does not, the reconciliation is amount-and-date matching wearing a
reference's clothes, and it will pair two unrelated payments the first month you have two of the
same size.

### A tolerance

```ts
tolerance: { amount: '0.01', reason: 'The card network rounds each conversion leg to the cent.' }
```

Per run, because a one-cent difference on a card settlement is rounding and a one-cent difference on
an internal transfer is a bug. The reason is required and is not decoration: a tolerance is a
decision to stop looking at differences below a size, and in a year the only question anybody asks
about it is why.

### An automatic resolver

There is no hook for one, deliberately. A rule that closes exceptions automatically is a rule that
closes the one that mattered, and the failure is silent — the queue looks healthy because the
difference was resolved by a machine that could not read a bank statement.

What is supported is a **correcting journal recorded against the resolution**:

```ts
const journal = await ledger.post({/* the correction */});

await reconciliation.resolve({
  id: exception.id,
  organizationId,
  resolution:
    'A deposit we had not recorded. Posted to suspense and identified from the reference.',
  correctionJournalId: journal.id,
});
```

## Related

- [ledger.md](ledger.md) — one side of every reconciliation
- [settlement.md](settlement.md) — the batch a bank statement is checked against
- [financial-architecture.md](financial-architecture.md) — where reconciliation sits

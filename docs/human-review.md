# Human review

The escape hatch that makes the rest of the platform honest. Guardrails reduce the rate of bad
output; they do not eliminate it, and no configuration of them ever will. So anything whose cost of
being wrong is high goes through a person first, and this is where it waits.

- [The rule](#the-rule)
- [Queueing something](#queueing-something)
- [Deciding](#deciding)
- [Who may decide](#who-may-decide)
- [SLA is a report, not a timer](#sla-is-a-report-not-a-timer)
- [Suspending a workflow](#suspending-a-workflow)
- [Operating a review queue](#operating-a-review-queue)
- [What to send for review](#what-to-send-for-review)

---

## The rule

> **Pending output is not readable through this API.**

```ts
await reviews.result(id, organizationId);
// ApiError: This output is still awaiting review and must not be used yet.
```

Not a flag beside the text. Not `{ content, pending: true }`. A thrown error.

The difference matters more than it looks. A flag gets ignored on a Friday afternoon, and the
record afterwards still says the output was reviewed. An error cannot be ignored without somebody
writing a line of code that says so, and that line shows up in review.

`isUsable(id, organizationId)` exists for a caller deciding what to render — it returns a boolean
and never the content.

## Queueing something

```ts
const request = await reviews.request({
  organizationId,
  subjectType: 'agent_run',
  subjectId: run.runId,

  content: run.output!,
  prompt: ticket.body, // so the reviewer is not guessing at context

  agentId: run.agentId,
  modelId: run.steps.at(-1)?.modelId,

  reason: run.reviewReason ?? 'This agent requires every output to be reviewed.',
  signals: ['groundedness 0.41', 'cites a source that does not exist'],

  priority: 'high',
  requestedBy: actor.id,
  requiredPermission: 'ai.review.support',
});
```

`signals` is what makes a queue workable. A reviewer shown the automated findings sees what the
machine was unsure about; a reviewer shown only the text re-derives it, slowly, for every item.

## Deciding

Four decisions, and only one of them closes the item without a reason:

| Decision          | Result                               | Needs a note |
| ----------------- | ------------------------------------ | ------------ |
| `approve`         | usable, optionally with a correction | no           |
| `reject`          | never usable                         | **yes**      |
| `request_changes` | back to the author, still open       | **yes**      |
| `escalate`        | reassigned, still open               | **yes**      |

```ts
await reviews.decide({
  id: request.id,
  organizationId,
  actor: { actorId: reviewer.id, permissions: reviewer.permissions },
  decision: 'approve',
  correctedContent: 'We have received your refund request and are checking it.',
});
```

A rejection with no reason is not a review. It tells the next person nothing and the model nothing,
so the same output comes back tomorrow. Approvals are exempt: "this is fine" is a complete thought.

**A correction is returned in place of the original.** `result()` returns `correctedContent` when
there is one, with `corrected: true`. A correction that is filed and unused is the reviewer's time
wasted and the original text still shipping.

Escalation keeps the item **open** and reassigns it. It is not a decision about the content, and
closing it there would lose the work.

## Who may decide

Two rules, both refusals:

1. **Not the person who raised it.** Review exists to add a second judgement; approving your own
   output is the first judgement with extra steps, and the record afterwards says it was reviewed.
   `allowSelfReview: true` exists, and changing it should require a conversation — a single-person
   team is the usual argument for it and exactly where the control is doing the most work.
2. **`requiredPermission`, when set.** A security finding and a marketing draft need different
   reviewers.

A machine-raised request has no author, so the first rule does not apply — treating null as "same
person" would make an automatic request unreviewable by anyone.

A decided review cannot be decided again. Reopening one would lose the record of the first
decision; raise a new request instead.

## SLA is a report, not a timer

```ts
const breached = await reviews.overdue(organizationId);
```

Nothing here escalates on a schedule. `overdue()` returns what has breached, and a job in
[`@trustos/scheduler`](scheduler.md) decides what to do with it.

The reason is short: the only automatic action a review queue could take on timeout is approving
the items nobody had time to look at. Every other action — alerting, escalating, reassigning —
belongs to the deployment, and the ones that matter differ per queue.

Default deadlines:

| Priority | Deadline   |
| -------- | ---------- |
| `urgent` | 15 minutes |
| `high`   | 1 hour     |
| `normal` | 8 hours    |
| `low`    | 3 days     |

## Suspending a workflow

A workflow step that waits for a person **suspends**; it does not block.

```ts
const result = await step.execute({
  workflowId,
  stepId: 'draft-reply',
  organizationId,
  actor,
  state: { ticketId, customerId }, // carried across the suspension
  run: async () => {
    /* the agent run */
  },
});

if (result.status === 'awaiting_review') {
  return { suspended: true, reviewId: result.reviewId };
}
```

The step ends. Later, possibly on a different pod, possibly next week:

```ts
const resumed = await step.resume({ reviewId, organizationId, actor });

if (resumed.status === 'completed') {
  await send(resumed.output!); // the correction, when there was one
} else {
  // reason: 'review_not_approved' — a business outcome, not an error
}
```

A step that awaits a human decision _inside_ the process holds a connection, a thread and an
in-memory continuation for hours. A deploy in the middle loses all three, and the work vanishes
with no record of what it was waiting for. Suspension puts the continuation in the review request,
where a restart cannot touch it — and the continuation is deliberately small and serialisable, so a
step needing a live object to resume is a step that cannot be written.

`resume` reads the decision from the review store rather than taking it as an argument. A caller
passing "approved" in is a caller who can pass it in wrongly.

## Operating a review queue

```ts
const stats = await reviews.stats(organizationId);
// { pending, overdue, oldestPendingAgeMs, byPriority }
```

Four numbers, and what each means when it moves:

| Number             | Moving means                                                             |
| ------------------ | ------------------------------------------------------------------------ |
| Pending count      | Rising steadily: the queue is not staffed for the volume.                |
| Overdue count      | The SLA is aspirational. Either staff it or change the SLA.              |
| Oldest pending age | The item everybody is avoiding. Usually the hardest and most important.  |
| Approval rate      | Above ~95%: the threshold is too low and reviewers have stopped reading. |

That last one is the failure mode to watch. A review queue where everything is approved is a queue
that has become a formality, and it will keep looking healthy right up until it approves the thing
that mattered.

## What to send for review

| Send                                                               | Do not send                            |
| ------------------------------------------------------------------ | -------------------------------------- |
| Anything that commits the business — a refund, a deadline, a price | Every answer, on principle             |
| Anything a customer reads unedited, at first                       | Internal drafts nobody acts on         |
| Anything a guardrail marked `needs_review`                         | Output already checked by a person     |
| Anything an evaluation scored below its threshold                  | High-volume, low-stakes classification |

Reviewing everything is the same as reviewing nothing, arrived at more slowly and more expensively.
Start with the outputs where being wrong costs money, and let the numbers above tell you when to
widen or narrow.

## Related

- [guardrails.md](guardrails.md) — where `needs_review` comes from
- [agents.md](agents.md) — `requiresReview` on a definition
- [evaluation.md](evaluation.md) — corrections are the best evaluation data you have
- [ai-security.md](ai-security.md) — review as the last control

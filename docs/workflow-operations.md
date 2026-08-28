# Workflow operations

Running the engine: task queues, SLAs, escalation, the two sweeps, monitoring and recovery.

- [The two sweeps](#the-two-sweeps)
- [Task queues](#task-queues)
- [SLAs](#slas)
- [Escalation](#escalation)
- [Metrics](#metrics)
- [Health checks](#health-checks)
- [Performance](#performance)
- [Recovery procedures](#recovery-procedures)
- [Configuration](#configuration)

---

## The two sweeps

The engine needs a scheduler for exactly two things. Both are HTTP routes rather than internal
timers, so the schedule lives where the deployment's other schedules live and either can be
triggered by hand during an incident without restarting anything.

```
POST /workflow/operations/sweeps/sla     # claim crossed thresholds, fire escalations
POST /workflow/operations/sweeps/tasks   # expire tasks past their deadline
```

Every five minutes is a reasonable starting point. Both are **idempotent**, so a cron that fires
twice, a retry after a timeout, or two schedulers running concurrently all do the work once.

An SLA's _status_ is recomputed on every read, so a sweep being late delays the notification
without making any dashboard wrong. That is the whole reason status is derived rather than stored:
a scheduler that is down for two hours does not produce a screen that confidently says "active"
about something that breached.

Both accept `?limit=` (default 200, maximum 500). Bounded, so one sweep cannot hold a transaction
open across an entire backlog — a scheduler that needs more calls again, which is cheaper than a
lock held for a minute.

## Task queues

Three lists, and the difference between them is the model:

| Route                           | Who reads it                               |
| ------------------------------- | ------------------------------------------ |
| `GET /workflow/tasks/mine`      | a person: assigned to me, or claimed by me |
| `GET /workflow/tasks/available` | a person: the pool I am eligible for       |
| `GET /workflow/tasks/overdue`   | a supervisor: past due and still open      |

All three are paginated with a hard ceiling of 100. There is no unpaginated variant: a task list is
the query most likely to run on every page load, and an organization with 50,000 open tasks would
otherwise return all of them to a UI that renders twenty.

Ordering is **priority, then due date, then age** — not age alone. The most urgent thing closest to
its deadline is what somebody should pick up next; ordering by creation time means the oldest
low-priority item sits at the top of the queue forever.

### Claiming

A pooled task is eligible to everyone holding its role until one person claims it. The claim
narrows it to the claimant, which is what makes a shared queue workable rather than a race
everybody re-runs.

Two users claiming simultaneously produce one success and one 409 naming the claimant. An
unattributed "already claimed" in a shared queue is the start of a conversation on a group chat.

### When a claimant disappears

Nothing expires a claim. A task claimed by somebody who then goes on leave is held until released,
which is why `release` accepts either the claimant **or** somebody with
`workflow.task.reassign`:

```bash
POST /workflow/tasks/:taskId/release   {"reason":"holder unavailable"}
POST /workflow/tasks/:taskId/reassign  {"toRole":"workflow_checker","reason":"rebalancing"}
```

Reassignment clears the claim, because leaving it would mean the new assignee cannot act. It emits
a security event as well as a history entry — moving an approval task from one reviewer to another
is how a decision gets steered.

### Assignment produces no eligible holder

Three ways this happens, and all three are visible:

| Symptom                                  | Cause                                                            | Fix                                   |
| ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `assignment_unresolvable` on start       | nobody holds the role, or the named user is not an active member | grant the role, or fix the definition |
| Task created, appears in nobody's queue  | assigned by group, and the framework has no group table          | use a role, or register a resolver    |
| `task_has_no_assignment` on every action | the step has no assignment                                       | fix the definition                    |

The last is refused for **everybody**, including platform staff. A task anybody could act on is a
task the definition failed to assign, and treating it as open to all would turn an authoring bug
into a permanent hole that nobody notices because everything appears to work.

## SLAs

Four kinds — `time_to_acknowledge`, `time_to_claim`, `time_to_complete`, `total_duration` — and six
states:

```
pending ──▶ active ──▶ warning ──▶ breached
              │  ▲
              ▼  │
            paused        ──▶ completed  (from any running state)
```

Status is **derived from the timestamps** on every read. `warnedAt` and `breachedAt` record that a
_side effect_ fired, which is a different thing from the status and is what makes the sweep
idempotent.

### Pausing

For a workflow legitimately waiting on somebody outside the organization — a customer sending a
document, a regulator responding. Without it, "waiting for information" breaches an SLA that
measures the team's responsiveness, which teaches everyone to ignore the SLA.

```bash
POST /workflow/operations/sla/:slaId/pause   {"reason":"awaiting customer documents"}
POST /workflow/operations/sla/:slaId/resume
```

Paused time **accumulates** in `pausedSeconds` rather than moving the deadline, so several cycles
are additive and the original `dueAt` stays as a record of what was promised. Overwriting would let
a workflow pause repeatedly and never breach.

Requires `workflow.sla.pause` and a reason, and is audited. Pausing an SLA is how a target is met
on paper, so it has to be visible.

### Calendars

`elapsed` is the only calendar the framework ships. Wall-clock time is correct for most
operational SLAs: an incident does not pause overnight, and a customer waiting for an approval does
not care that it is Sunday.

A working-hours calendar registers through `CalendarRegistry`. A definition naming an unregistered
one **fails validation** rather than falling back — a silent fallback is an SLA that looks correct
and is wrong by a factor of three.

`SimpleWorkingHoursCalendar` is a worked example, deliberately unregistered, and its own
description says it is not suitable for a contractual SLA: no holidays, no DST.

## Escalation

Seven actions:

| Action              | Needs                                    |
| ------------------- | ---------------------------------------- |
| `notify_assignee`   | a notifier                               |
| `notify_supervisor` | an `EscalationRecipients` implementation |
| `reassign_task`     | `EscalationEffects`                      |
| `add_approver`      | `EscalationEffects`                      |
| `increase_priority` | `EscalationEffects`                      |
| `create_incident`   | `EscalationEffects` (opens a case)       |
| `callback`          | a registered handler                     |

### Idempotency is the whole design

A breached SLA stays breached — time does not un-pass — so a sweep that escalated every breach it
found would escalate the same one every minute until somebody cleared the queue. At three in the
morning that is a pager firing sixty times an hour, and the response is to silence the pager, which
is worse than never having built escalation.

The key is a hash of `(organization, instance, task, sla, trigger, rule, action)` with **no
timestamp** — a timestamp would make every attempt unique, which is the same as no key at all. It
is a unique index in the database, not a check in code, because a check-then-insert has a window
and two schedulers hit it.

A manual escalation passes an `occurrence` discriminator, so escalating the same task twice on
purpose is two acts while an accidental double-submit of one is still collapsed.

### A failed escalation keeps its row

Status `failed`, with the reason, and it is **not retried on the next sweep**. Two reasons: the
failure was almost certainly deterministic — a missing resolver, an unregistered callback — and
retrying it every minute is the pager problem again. "The pager did not fire and there is no record
of why" is the worst possible state, so the row and its reason remain.

Read them: `GET /workflow/operations/instances/:instanceId/escalations`.

### Defaults are honest

Without an `EscalationRecipients` implementation, `notify_supervisor` **fails** with "the framework
has no org chart". It does not quietly succeed. An escalation that believes it told a supervisor
when it told nobody is how a breach goes unnoticed for a week.

Without a notifier, `LoggingEscalationNotifier` writes a log line and reports
`delivered: true` — because a log line genuinely is a delivery to whoever reads logs, and claiming
otherwise would make the record say failed when nothing failed.

The example application's SLA sweep claims thresholds and reports that no rules ran, because wiring
the resolver is a deployment decision. That is stated in the response rather than looking like
success.

## Metrics

Recorded through `MetricsRecorder`:

| Metric                            | Type                                         |
| --------------------------------- | -------------------------------------------- |
| `workflow.started`                | counter, labelled by definition and version  |
| `workflow.transitioned`           | counter, labelled by definition and action   |
| `workflow.completed`              | counter                                      |
| `workflow.rejected`               | counter                                      |
| `workflow.transition.duration_ms` | distribution, labelled by action and outcome |
| `workflow.task.created`           | counter, labelled by definition and step     |

Derivable from the tables rather than counted separately, because a counter that drifts from the
table it describes is worse than a query:

- task backlog — `WorkflowTask` where status is open, assigned, claimed or in progress
- overdue tasks — the same, with `dueAt < now()`
- SLA breaches — `WorkflowSla` where `breachedAt is not null`
- approval latency — `WorkflowDecision.decidedAt` minus the task's `createdAt`
- authorization denials — the security event trail, `authz.denied` and the workflow reasons
- escalation count — `WorkflowEscalation`, grouped by status

Two worth alerting on:

**`workflow.definition_tampering_detected`** — critical. Something wrote to the version table
outside the application.

**A rising count of `self_approval_forbidden`** — not critical individually, because it is usually
somebody who does not know the policy. A burst from one actor is worth looking at.

## Health checks

| Check            | Question                                           | Critical |
| ---------------- | -------------------------------------------------- | -------- |
| database         | can the engine read a definition?                  | yes      |
| workflow runtime | is a published definition loadable and compilable? | yes      |
| scheduler        | when did the last sweep run?                       | no       |
| notification     | is a notifier registered?                          | no       |
| document         | is a document port registered?                     | no       |

The last three are **not critical**, deliberately. A workflow engine with no notifier still
governs decisions correctly — it just does not tell anybody about a breach. Failing readiness for
that would take an application out of service for a degradation, and readiness should mean "should
traffic come here", not "is everything ideal".

The scheduler check is the one to watch. An engine whose sweeps have not run for a day has SLAs
that show as breached (correctly, since status is derived) and escalations that never fired.

## Performance

Measured against a local PostgreSQL 14 from one Node 20 process. Reported as what it is — a
laptop, not a load test of a deployment.

| Operation                                    | p50    | p95    | p99    |
| -------------------------------------------- | ------ | ------ | ------ |
| Start an instance                            | 2.1 ms | 2.4 ms | 2.7 ms |
| Transition (`submit`, plus an automatic hop) | 3.8 ms | 4.8 ms | 5.2 ms |
| Transition (`approve`, full maker-checker)   | 2.7 ms | 3.2 ms | 3.7 ms |
| Read instance + available actions + approval | 0.8 ms | 1.0 ms | 1.5 ms |
| Task list, page of 25                        | 0.5 ms | 0.5 ms | 0.6 ms |
| History page, 25 events                      | 0.3 ms | 0.3 ms | 0.4 ms |

Against a 500 ms p95 target for a transition, with ~100× headroom. The heaviest path is `submit`,
because it follows an automatic transition and therefore writes twice.

Under concurrency:

| Scenario                              | Result                                          |
| ------------------------------------- | ----------------------------------------------- |
| 100 concurrent instance starts        | 100 succeeded, 0 conflicts, 77 ms wall clock    |
| 100 concurrent claims on **one** task | **1 succeeded, 99 conflicts**, 30 ms wall clock |

The second is the number that matters: the concurrency control holds under real contention, and it
holds by losing 99 requests cleanly rather than by letting two people work the same item.

### What these numbers do not tell you

A managed Postgres across a network adds 1–3 ms per round trip, and a transition makes several. A
deployment on Railway should expect single-digit to low-double-digit milliseconds, not the numbers
above. Table sizes here were small (≈550 instances, ≈1,900 events); the indexes are chosen for the
queries the engine runs, but nothing here was measured at a million rows.

Benchmark it yourself before quoting a figure to anybody.

## Recovery procedures

### The sweeps have not run

Call them by hand. Both are idempotent, so catching up is safe:

```bash
curl -X POST "$API/workflow/operations/sweeps/sla?limit=500"   -H "Authorization: Bearer $TOKEN"
curl -X POST "$API/workflow/operations/sweeps/tasks?limit=500" -H "Authorization: Bearer $TOKEN"
```

Repeat until both report zero. Escalations that were already claimed do not re-fire.

### An instance is stuck

```bash
curl "$API/workflow/instances/$ID" -H "Authorization: Bearer $TOKEN"
```

`availableActions` is the answer. If it is empty and the instance is not in a final state, one of:

- **the state has no outgoing transition** — a dead end the validator would have caught, so the
  definition was published before that check existed. Cancel the instance and publish a fixed
  version.
- **every transition's condition is false** — instance data does not match any branch. Look at
  `data` against the conditions; `trustos workflow simulate` prints them as sentences.
- **the approval is not satisfied and nobody is eligible** — check `approval.outstanding` and
  whether anybody holds the permission.

### An escalation failed

```bash
curl "$API/workflow/operations/instances/$ID/escalations" -H "Authorization: Bearer $TOKEN"
```

`lastError` says why. Common causes: no `EscalationRecipients` for `notify_supervisor`, no
`EscalationEffects` for a reassignment, an unregistered `callbackKey`.

Fix the wiring, then trigger manually with a fresh `occurrence` — the automatic key is spent, which
is what stopped the retry loop.

### A definition is tampered with

`workflow.definition_tampering_detected` at critical, and every instance on that version refuses
to transition.

1. Do not "fix" the hash. The hash is the evidence.
2. Find who wrote to the table. Application audit will not show it, because the application did
   not do it.
3. Compare the stored document against the last approved version in your definition repository.
4. Publish a new version with the correct content. Instances on the tampered version can then be
   cancelled and restarted, or left for manual resolution — they cannot be migrated, by design.

### Resetting a development database

Drop it. A workflow instance cannot be deleted while it has history — `onDelete: Cascade` reaches
`WorkflowEvent` and the append-only trigger refuses the cascaded delete.

That is the guarantee working, and it is worth knowing before writing a cleanup script:

```bash
dropdb myapp_dev && createdb myapp_dev && npm run db:deploy
```

## Configuration

The engine is configured by its definitions rather than by environment variables. What is
environment-level:

| Variable                             | Default | Meaning                                                                                                        |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW_SWEEP_LIMIT`               | 200     | Records per sweep call                                                                                         |
| `WORKFLOW_IDEMPOTENCY_TTL_HOURS`     | 24      | How long a key is remembered                                                                                   |
| `WORKFLOW_ALLOW_UNVALIDATED_OBJECTS` | false   | Development only. True disables the only check that a workflow is about a real record in its own organization. |

Everything else — SLA durations, approval models, escalation rules, rework limits — belongs in a
definition, because those are governance decisions that need review, versioning and an audit trail.
An environment variable has none of those.

---

**See also:** [workflow-architecture.md](workflow-architecture.md) ·
[workflow-security.md](workflow-security.md) ·
[workflow-versioning.md](workflow-versioning.md) ·
[incident-response.md](incident-response.md)

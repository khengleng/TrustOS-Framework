# Workflow architecture

A reusable engine for governed business processes: configurable definitions, maker-checker
approval, task queues, SLAs, escalation and a complete audit history.

- [The shape of it](#the-shape-of-it)
- [Ten packages](#ten-packages)
- [The six-step request path](#the-six-step-request-path)
- [Persistence](#persistence)
- [Events](#events)
- [Integration points](#integration-points)
- [Two workflow modules](#two-workflow-modules)
- [What is deliberately absent](#what-is-deliberately-absent)

---

## The shape of it

A **definition** is an immutable document describing states, transitions, approvers, SLAs and
escalations. An **instance** is one running process, pinned to one version of one definition
for its whole life. A **task** is a unit of work a person can find and claim. A **case** is
the container a workflow runs inside, for work whose shape is not known in advance.

The design decision everything else follows from: **a published definition never changes.** A
running instance reads its rules from a version row, so editing that row would retroactively
change the rules a decision was made under — which would make the audit trail a record of what
the workflow says _now_ rather than what it said then. Three things enforce it: the service
refuses the edit, the runtime verifies a stored hash on every compile, and a database trigger
refuses the `UPDATE`.

That immutability is also what makes the engine fast. A compiled definition can be cached with
no invalidation logic, because version 1.0.0 can never become stale.

## Ten packages

Layered so that nothing depends on the runtime except the runtime.

```
workflow-core          types, errors, the actor projection, permissions
   │
   ├── workflow-definition   the document format, its validator, conditions, versioning
   │      │
   │      ├── workflow-approvals   six approval models, as pure functions
   │      ├── workflow-sla         SLA state and the calendar abstraction
   │      │      └── workflow-escalation   idempotent escalation actions
   │      └── workflow-policy      separation of duty, on the phase 4 policy engine
   │
   ├── workflow-tasks       assignment strategies and concurrency-safe claiming
   ├── workflow-history     append-only events, comments, attachments
   │
   └── workflow-runtime     the state machine and the engine that drives it
          └── case-management   case records over the same history
```

`workflow-core` holds **no logic** — types plus a handful of pure functions. Nine packages
depend on it, and a runtime dependency there would make all nine depend on the runtime.

| Package               | What it owns                                     | Read first             |
| --------------------- | ------------------------------------------------ | ---------------------- |
| `workflow-core`       | Entities, errors, `WorkflowActor`, permissions   | `entities.ts` header   |
| `workflow-definition` | Schema, validator, condition language, simulator | `conditions.ts` header |
| `workflow-approvals`  | The six models, derived from the decision trail  | `models.ts` header     |
| `workflow-tasks`      | Assignment, eligibility, claiming                | `service.ts` header    |
| `workflow-sla`        | SLA evaluation, calendars                        | `sla.ts` header        |
| `workflow-escalation` | Escalation, idempotency                          | `escalation.ts` header |
| `workflow-policy`     | Separation of duty as policies                   | `policies.ts` header   |
| `workflow-history`    | Append-only history, comments, attachments       | `history.ts` header    |
| `workflow-runtime`    | State machine, engine, definition lifecycle      | `engine.ts` header     |
| `case-management`     | Cases                                            | `service.ts` header    |

### The state machine is separate from the engine

`machine.ts` is pure: given a definition, a state, an action and data it returns the same
answer every time, with no clock and no database. `engine.ts` orchestrates persistence,
authorization, tasks, SLAs and history around it.

That split is why "is this transition legal" is testable without a transaction — and why
"legal" and "permitted" cannot be confused. A transition can be legal and refused, and a
machine that returned "not allowed" for both would make the distinction invisible.

## The six-step request path

Every externally triggered operation follows the same order, and the order is the security
model:

```
1. Load       the instance, scoped to the actor's organization
2. Verify     the definition against its recorded hash
3. Resolve    the transition against the state machine
4. Authorize  through the policy engine, with the loaded record
5. Check      the step's requirements: fields, evidence, approval progress
6. Write      conditionally on the version the load saw, then record history
```

Two of those are worth dwelling on.

**Steps 3 and 4 are in that order deliberately.** Asking "may you approve?" before "is
approval available from here?" leaks the shape of the workflow to anybody who can enumerate
actions. An illegal action is refused before any authorization question is asked.

**Step 6 is conditional.** The write carries the version the read saw, so a decision made
against a page loaded ten minutes ago updates zero rows rather than being applied to whatever
the instance has since become. Zero rows is a 409 with both version numbers, which is what
tells a client whether to reload or to give up.

### Approval progress is derived, never stored

`evaluateApproval` is a pure function of the decisions already recorded. There is no counter
on the step.

The alternative — increment a counter per approval — is the design that produces "the instance
says 2 of 3 but only one decision exists". Recomputing means the trail _is_ the truth, which
is also what an auditor reads.

## Persistence

Fourteen tables. Three carry a guarantee beyond ordinary constraints, and all three are
enforced by the database rather than by the application:

| Guarantee                        | How                                                                                                                                | Why the application alone is not enough                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| History is append-only           | trigger refusing `UPDATE`/`DELETE` on `WorkflowEvent`, `WorkflowDecision`, `WorkflowCommentAmendment`                              | The application has write access to its own database. A `REVOKE` does nothing when it connects as the table's owner, which is the default on Railway. |
| A published version is immutable | trigger refusing changes to `definition`, `definitionHash`, `version`, `initialState`, `finalStates` on a published or retired row | Same reason. The runtime's hash check catches it too; this stops it happening.                                                                        |
| An escalation fires once         | unique index on `(organizationId, idempotencyKey)`                                                                                 | A check-then-insert has a window, and two schedulers hit it.                                                                                          |

Two more properties are worth knowing:

- **`WorkflowEvent.sequence` is monotonic per instance**, with a unique index. Two events
  written in one transaction share a millisecond, so ordering by timestamp is not ordering.
- **Every tenant-owned index leads with `organizationId`**, because every query filters on it.
  An index leading with anything else is one Postgres cannot use for the common case.

### One consequence to know about

A workflow instance **cannot be deleted** while it has history: `onDelete: Cascade` reaches
`WorkflowEvent` and the append-only trigger refuses the cascaded delete. That is correct — the
record of what was decided must outlive the record it was about — and it means a development
database is reset by dropping it rather than by deleting rows.

## Events

Thirty-two internal event types, all recorded in `WorkflowEvent`. No Kafka, no external broker:
the events go to the same Postgres as everything else, so an instance and its history are
consistent without a distributed transaction.

`AUDITABLE_WORKFLOW_EVENTS` is an **allow-list** of the events that also cross into the audit
trail. A customer's audit trail full of `task.claimed` is a trail nobody reads, and the entries
that matter get buried — so the mechanics stay in history and the decisions cross over.

The two trails answer different questions for different readers:

|         | Workflow history                        | Audit trail                           |
| ------- | --------------------------------------- | ------------------------------------- |
| Answers | what happened to this request, in order | who changed what in this organization |
| Scope   | one instance or case                    | every subsystem                       |
| Read by | a participant                           | an auditor                            |

`HistoryRecorder.record` writes both in one call, so a caller cannot write one and forget the
other — the failure that produces a complete history and an audit trail with a hole in it,
discovered during an audit rather than in a test.

A transactional outbox is not implemented. The hook is the `SecurityEventSink` interface, which
a deployment can point at one.

## Integration points

Every external dependency is a narrow port with a working default, so the engine runs in a
deployment that has installed none of the optional modules.

| Port                      | Default                   | What a deployment supplies                         |
| ------------------------- | ------------------------- | -------------------------------------------------- |
| `MemberDirectory`         | refuses everything        | the membership tables                              |
| `AssigneeResolver`        | absent                    | an org chart, a workload index, an ownership model |
| `EscalationNotifier`      | logs                      | `@trustos/module-notification`                     |
| `EscalationRecipients`    | nobody                    | an org chart                                       |
| `DocumentPort`            | finds nothing             | `@trustos/module-document`                         |
| `BusinessCalendar`        | elapsed time              | a working-hours or holiday calendar                |
| `BusinessObjectValidator` | **refuses in production** | one per object type                                |

The last is the one that matters. Without a validator, `objectType` and `objectId` are strings
nobody has checked, and an instance started against a record in another organization puts that
record's id into this organization's history where every participant can read it. So a missing
validator is a refusal rather than a pass.

The defaults refuse rather than permit, throughout. A permissive default is a control that is
off in every deployment that has not thought about it.

## Two workflow modules

There are two things called "workflow" in this framework, and choosing wrongly wastes a week.

**`@trustos/module-workflow`** (phase 3) is a linear approval chain: an ordered list of steps,
each with a permission and a required approval count. Installed with
`trustos add-module workflow`. Choose it when the process is "N people approve in order" and
will stay that way.

**The `workflow-*` packages** (phase 5) are a state machine: branching, conditions, rework
loops, parallel and threshold approval, SLAs, escalation, cases. Choose it when the process has
a shape — when a request can come back, take a different path depending on its data, or need
different reviewers.

Migrating from the first to the second means writing a definition; the module's data does not
carry over, because a linear chain has no states to map.

## What is deliberately absent

No BPMN, no Camunda, no Temporal, no external workflow engine. No visual designer. No AI
generation of workflows.

Definitions are typed JSON, which is reviewable in a diff, testable in CI and diffable between
versions — and a canvas is none of those. The `compareDefinitions` output, organised by
consequence with control-weakening in its own bucket, is a review artefact a canvas cannot
produce.

No Kafka and no Kubernetes. The engine is a library inside an application, not a service:
`docs/workflow-operations.md` covers the two scheduled sweeps it needs, which are HTTP routes a
cron calls.

SLA calendars are elapsed time only. A real holiday calendar is per-country, per-region,
per-year with weekend-substitution rules and has to be maintained forever; guessing at one
produces a calendar that is wrong in some jurisdiction and trusted anyway.

---

**See also:** [workflow-definition-guide.md](workflow-definition-guide.md) ·
[maker-checker.md](maker-checker.md) ·
[workflow-security.md](workflow-security.md) ·
[workflow-operations.md](workflow-operations.md) ·
[workflow-versioning.md](workflow-versioning.md)

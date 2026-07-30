# Workflow definition guide

How to write, validate and publish a workflow definition.

- [The document](#the-document)
- [States and transitions](#states-and-transitions)
- [Steps](#steps)
- [Approval](#approval)
- [Conditions](#conditions)
- [SLAs and escalation](#slas-and-escalation)
- [Validation](#validation)
- [Simulation](#simulation)
- [Publishing](#publishing)
- [A worked example](#a-worked-example)

---

## The document

Typed JSON. `.strict()` at every level, so an unrecognised key is an error rather than a
silently ignored field — a typo that is ignored is a control the author believes exists.

```json
{
  "id": "change-request-approval",
  "version": "1.0.0",
  "name": "Change Request Approval",
  "description": "A manager reviews every request; compliance reviews high-risk ones.",
  "businessObjectType": "ChangeRequest",

  "initialState": "draft",
  "states": ["draft", "submitted", "manager_review", "approved", "rejected"],
  "finalStates": ["approved", "rejected"],

  "steps": [ ... ],
  "transitions": [ ... ],

  "rejection": { "behaviour": "final" },
  "cancellation": { "requiresReason": true },
  "rework": { "maxCycles": 3, "onLimitReached": "escalate" },

  "startPermission": "workflow.instance.start",
  "defaultPriority": "normal",
  "sla": [],
  "labels": { "owner": "platform-team" }
}
```

`id` and every state name are lowercase with dots, underscores or hyphens. Uppercase and spaces
are excluded because `Pending Approval`, `pending_approval` and `PendingApproval` would
otherwise be three states that look like one.

Durations are **minutes** in a definition, because a human writes them, and seconds
everywhere internal. The conversion happens once, at the schema boundary.

YAML is not read by the CLI. Adding a YAML parser means a parser reachable from a file path,
and the two common ones have both had deserialization vulnerabilities — convert first
(`npx js-yaml file.yaml > file.json`), which keeps the parser in your dependency tree rather
than in the framework's.

## States and transitions

A **state** is where an instance sits. A **transition** is a named action that moves it.

```json
{
  "action": "submit",
  "from": "draft",
  "to": "submitted",
  "permission": "workflow.instance.transition",
  "requiresReason": false,
  "automatic": false,
  "isRework": false,
  "isRejection": false,
  "isCancellation": false
}
```

The `(action, from)` pair must be unique, not the action alone: `approve` legitimately exists
from `manager_review` _and_ from `compliance_review`. Two transitions with the same action from
the same state make the engine's choice arbitrary, so validation refuses it.

The four flags are what the engine reads to decide what a transition _means_:

| Flag             | Effect                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `automatic`      | The engine takes it with no actor, immediately on entering `from` |
| `requiresReason` | A reason code is mandatory                                        |
| `isRework`       | Increments the rework counter and starts a new approval cycle     |
| `isRejection`    | The instance ends as `rejected` rather than `completed`           |
| `isCancellation` | The instance ends as `cancelled`                                  |

`isRejection` and `isCancellation` both end an instance and are reported separately, because
"a reviewer refused this" and "somebody withdrew it" are different facts and reporting them as
one number makes a rejection rate depend on how many requests were abandoned.

### Automatic transitions

An `automatic` transition is the engine's, not an actor's. It is how `submitted` routes straight
to `manager_review` without a second request.

Validation refuses a **cycle** of them, because the runtime follows the chain until it reaches a
state with none — and `a -auto-> b -auto-> a` never stops. Catching it at publication is much
better than an iteration cap in the runtime, which turns an authoring mistake into a mysterious
error. It also refuses two _unconditional_ automatic transitions from one state, since which one
the engine took would be arbitrary.

## Steps

One step per state, describing what happens while an instance is there.

```json
{
  "state": "manager_review",
  "kind": "approval",
  "name": "Manager review",
  "description": "A manager reviews every request.",
  "assignment": { "strategy": "role", "role": "workflow_checker" },
  "approval": { ... },
  "sla": [ ... ],
  "escalations": [ ... ],
  "requiredFields": [],
  "requireAttachment": false,
  "requireAttachmentWhen": { "field": "riskRating", "operator": "eq", "value": "high" },
  "editableFields": []
}
```

`kind` is `task` (a person acts), `approval` (approvers decide), `automatic` (the engine moves
on) or `terminal` (nothing happens).

### Assignment

Four strategies are implemented; five more are declarable through an `AssigneeResolver`.

| Strategy                                                                                          | Behaviour                                                                           |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `named_user`                                                                                      | One person. `${initiator}` resolves to whoever started the instance.                |
| `role`                                                                                            | Pooled to everyone holding the role. Not resolved to an individual.                 |
| `group`                                                                                           | Pooled to a group's members.                                                        |
| `round_robin`                                                                                     | Rotates across the role's holders, using a persisted cursor.                        |
| `organizational_unit`, `least_loaded`, `requester_manager`, `resource_owner`, `external_resolver` | Need an application resolver. Validation refuses one without a registered resolver. |

`role` is deliberately _not_ resolved to a person at creation: resolving it would make the task
invisible when that person is on leave. It sits in the pool until somebody claims it.

### Required fields and evidence

`requiredFields` and the attachment requirement are checked on **exit**, not on entry. A step's
whole purpose is for somebody to supply what it requires, so requiring it on entry would make
the step impossible to enter.

An empty string counts as missing — a required justification submitted as `""` is not a
justification.

Use `requireAttachmentWhen` rather than `requireAttachment` where you can. An unconditional
requirement gets satisfied with a screenshot of nothing; a conditional one asks for evidence
where evidence changes the decision.

### Editable fields

`editableFields` is what a maker may change while in that state, and it is what a rework cycle
permits. Fields outside it are **reported as rejected**, not silently dropped: silently dropping
would let the maker believe the change was saved.

Be careful what you make editable in a rework state. If `riskRating` drives the approval path,
letting the maker change it after a rejection is a way to route around compliance.

## Approval

Six models. All are pure functions of the decision trail.

| Model         | Behaviour                                                 |
| ------------- | --------------------------------------------------------- |
| `single`      | One decision settles it                                   |
| `parallel`    | Several may review at once; the first decision settles it |
| `sequential`  | A defined order; approver N cannot act before N−1 has     |
| `unanimous`   | Every listed approver must approve                        |
| `threshold`   | K of N **distinct actors** must approve                   |
| `conditional` | The required set depends on instance data                 |

```json
{
  "model": "threshold",
  "threshold": 2,
  "approvers": [
    { "key": "ops", "name": "Operations", "permission": "ops.approve", "slaMinutes": 480 },
    { "key": "finance", "name": "Finance", "permission": "finance.approve", "slaMinutes": 960 },
    { "key": "risk", "name": "Risk", "permission": "risk.approve", "slaMinutes": 960 }
  ],
  "allowSelfApproval": false,
  "allowSameActorMultipleSlots": false,
  "rejectionReasonCodes": ["out_of_policy", "insufficient_evidence"]
}
```

Approvers are identified by **permission**, not by user id. A workflow that names individuals
stops working the first time somebody leaves.

Three properties are not configurable, and all three matter:

- **A rejection settles a step immediately**, whatever the model requires. "Three must approve
  but one may veto" is how every real approval chain works; a model where a refusal could be
  outvoted would make it advisory.
- **`allowSelfApproval` defaults to false.** Setting it true is reported as a warning by the
  validator every time, so it appears in review.
- **`allowSameActorMultipleSlots` defaults to false.** With it true, "2 of 3" is satisfiable by
  one person clicking twice — which is not two approvals.

Validation refuses an impossible threshold (4 of 3), a gap in a sequential order, and a
conditional model where every approver can be skipped — the last because a request could
otherwise reach "approved" with nobody having looked at it.

## Conditions

A **structured predicate tree**, not an expression string:

```json
{
  "all": [
    { "field": "amount", "operator": "gte", "value": 100000 },
    {
      "any": [
        { "field": "riskRating", "operator": "in", "value": ["high", "critical"] },
        { "field": "region", "operator": "eq", "value": "apac" }
      ]
    }
  ]
}
```

Eleven operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `contains`, `exists`,
`missing`. Composition with `all`, `any`, `not`, bounded at five levels deep.

### Why not an expression language

A condition is **untrusted input that influences an authorization outcome**, written by an
administrator and evaluated against caller-supplied data. Every convenient option is a
code-execution primitive: `eval` and `new Function` run arbitrary code with the process's
privileges, and a general expression library is a large parser most of which offer property
access or function calls — `constructor.constructor('return process')()` is the classic escape.

This has no parser. The shape is a zod schema and evaluation is a `switch` over eleven
operators. The language cannot call a function because it has no syntax for one.

### The rules that catch real mistakes

- **No coercion in an ordering comparison.** `"90000" > 100000` is false and so is
  `"90000" > 10`, which is how a silently wrong approval path happens. A non-numeric value fails
  the comparison rather than being treated as zero, and the validator refuses a `gt` against a
  string at publication time.
- **Own properties only.** `__proto__`, `constructor` and `prototype` are refused by name, and
  `readField` uses `hasOwnProperty` — two independent defences, because this is the boundary
  between a definition document and the process.
- **Strict equality.** Loose equality would make `0 == false` true, which in an approval path
  means a missing amount matching a zero threshold.
- **No array indices.** A condition that depends on the third element of a list breaks when the
  list is reordered, and an approval path that changes when a list is reordered is not a control.

`describeCondition` renders one as `amount >= 100000 AND riskRating in [high, critical]`, which
is what the portal and the simulator show an auditor.

## SLAs and escalation

```json
"sla": [
  { "kind": "time_to_complete", "minutes": 480, "warningAtPercent": 75, "severity": "medium", "calendar": "elapsed" }
],
"escalations": [
  { "key": "warn", "trigger": "sla_warning", "action": "notify_assignee", "templateKey": "workflow.sla.warning" },
  { "key": "breach", "trigger": "sla_breach", "action": "notify_supervisor", "templateKey": "workflow.sla.breach" }
]
```

`warningAtPercent` is a percentage rather than an absolute time, so changing the duration does
not silently move the warning past the deadline.

`calendar` must be registered. `elapsed` is the only one the framework ships; naming an
unregistered one fails validation rather than falling back, because a silent fallback is an SLA
that looks correct and is wrong by a factor of three.

An escalation `action` is one of `notify_assignee`, `notify_supervisor`, `reassign_task`,
`add_approver`, `increase_priority`, `create_incident`, `callback`. A `callback` names a
**registered key**, never a URL — a definition that could name a URL would be a server-side
request forgery primitive writable by anybody who can author a workflow.

An SLA with no escalation is reported as a warning: the clock runs, a status turns red on a
dashboard, and nothing happens.

## Validation

```bash
trustos workflow validate workflows/change-request-approval.json
trustos workflow validate workflows/change-request-approval.json --strict-permissions
trustos workflow validate workflows/change-request-approval.json --permissions payments.release,payments.read
```

Findings are **errors** (publication refused) or **warnings** (publication allowed, review
required). Warnings do not block, deliberately: a validator that refused everything questionable
would be one whose output people learn to bypass, and the bypass would take the errors with it.

What is an error:

| Code                                                                 | Meaning                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `missing_initial_state`                                              | The initial state is not in `states`                            |
| `initial_state_is_final`                                             | Every instance would be complete on creation                    |
| `duplicate_state`, `duplicate_transition`                            | Ambiguous                                                       |
| `unreachable_state`                                                  | Usually a review step somebody believes exists                  |
| `dead_end_state`                                                     | A non-final state with no way out — where a request goes to die |
| `automatic_cycle`                                                    | The runtime would never stop                                    |
| `ambiguous_automatic_transition`                                     | The engine's choice would be arbitrary                          |
| `transition_from_final_state`                                        | The state is final and has an outgoing action                   |
| `step_without_assignment`                                            | The task would appear in nobody's queue                         |
| `unknown_permission`                                                 | A misspelled approver permission is a step nobody can act on    |
| `unregistered_resolver`, `unknown_calendar`, `unregistered_callback` | Named something that does not exist                             |

What is a warning:

| Code                         | Meaning                                       |
| ---------------------------- | --------------------------------------------- |
| `self_approval_permitted`    | The maker-checker control is off on that step |
| `same_actor_multiple_slots`  | One person can meet a threshold alone         |
| `single_point_of_approval`   | One person is the whole control               |
| `sla_without_escalation`     | A deadline nobody is told about               |
| `condition_field_undeclared` | Probably a typo, so the branch is never taken |
| `permissions_unchecked`      | No catalog was supplied                       |
| `state_without_step`         | No task, no SLA, nothing prompting anybody    |

`--strict-permissions` is off by default because a definition on disk may reference product
permissions the CLI knows nothing about, and a tool that reports false errors on every real
definition is one people stop reading. The validator warns when the check is skipped, so it is
never silent.

## Simulation

```bash
trustos workflow simulate workflows/change-request-approval.json
```

Walks the graph — no database, no instance, no notification — and reports what a JSON document
does not show:

```
Paths: 11
    draft -> submitted -> manager_review -> compliance_review -> approved
      approvals: manager_review(sequential, 1), compliance_review(sequential, 1)
      when: escalate_to_compliance: riskRating = "high"
      SLA total: 1440 min

Separation-of-duty concerns:
  - "workflow.approval.decide" approves at 2 steps (manager_review, compliance_review).
    One person holding it could satisfy several supposedly independent reviews.

SLA exposure (longest first):
  - returned_for_rework time_to_complete: 2880 min
  - compliance_review time_to_complete: 960 min
```

It exits **non-zero** when a path reaches a success outcome with no approval at all. That is the
one finding a reviewer cannot get from reading a forty-state document, and it is almost always a
shortcut transition added for testing and left in.

Cancellation and rejection paths are excluded from that check: a withdrawal needs no approval and
a rejection _is_ a decision. An earlier version counted them and reported three findings on the
framework's own correct example — and a check that fires on correct definitions is one people
learn to ignore.

## Publishing

```
draft ──submit──▶ under_review ──approve──▶ approved ──publish──▶ published ──retire──▶ retired
  ▲                    │                        │
  └────withdraw────────┴────────────────────────┘
```

Three grants, held by three people, and `definitionGovernancePolicy` enforces that they are
three different _people_: the author cannot approve, and the approver cannot publish. See
[maker-checker.md](maker-checker.md).

Editing stops at `under_review`, not at `approved`. A definition under review is one somebody is
reading, and letting the author edit it underneath the reviewer means the reviewer approves
something other than what they read — withdraw to draft first, which is visible.

## A worked example

`packages/workflow-definition/src/examples.ts` holds two:

- **`SIMPLE_APPROVAL`** — one submission, one approval. The smallest useful workflow, and the
  place to start.
- **`CHANGE_REQUEST_APPROVAL`** — a manager reviews everything, compliance reviews high-risk
  requests, with conditional evidence, bounded rework and escalation on both thresholds.

`trustos workflow list` prints both with their path counts and required permissions.
`templates/workflow-enabled-saas` generates an application with the second one as a file you
own.

---

**See also:** [workflow-architecture.md](workflow-architecture.md) ·
[maker-checker.md](maker-checker.md) ·
[workflow-versioning.md](workflow-versioning.md) ·
[workflow-security.md](workflow-security.md)

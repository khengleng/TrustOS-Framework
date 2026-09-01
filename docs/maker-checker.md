# Maker-checker

The control that makes a governed workflow worth having: the person who asks for something is
not the person who agrees to it.

- [The rule](#the-rule)
- [Maker and checker](#maker-and-checker)
- [Where it is enforced](#where-it-is-enforced)
- [Separation of duties](#separation-of-duties)
- [Approval models](#approval-models)
- [Definitions are governed too](#definitions-are-governed-too)
- [Exceptions](#exceptions)
- [Rework](#rework)
- [What this does not prevent](#what-this-does-not-prevent)

---

## The rule

**The actor who submits a controlled request cannot be its approver.**

It is the framework's default, it is not opt-out per request, and turning it off is a property of
a published workflow definition that the validator reports every single time.

A workflow whose submitter can approve their own request is not a control; it is a log entry that
looks like one. That is the whole argument, and everything below is a consequence of it.

## Maker and checker

They are **grants**, not job titles. The framework's suggested roles keep them apart:

| Role                     | Holds                                                                                                               | Deliberately does not hold                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `workflow_maker`         | `instance.start`, `instance.transition`, `task.*`, `comment.*`, `attachment.write`                                  | `approval.decide`                          |
| `workflow_checker`       | `approval.decide`, `task.*`, `comment.write`, `sla.read`                                                            | `instance.start`                           |
| `workflow_author`        | `definition.create`, `definition.update`, `definition.submit`                                                       | `definition.approve`, `definition.publish` |
| `workflow_administrator` | `definition.approve`, `definition.publish`, `definition.retire`, `task.reassign`, `sla.pause`, `escalation.trigger` | `definition.create`, `approval.decide`     |

`INCOMPATIBLE_GRANT_PAIRS` names the four pairs no single role should hold, and
`findIncompatibleGrants` reports a role that holds one. The framework's own test runs it over the
suggested roles, so an edit that gave `workflow_author` the approve grant would fail a test
rather than ship.

It **reports** rather than refusing. A two-person team may knowingly accept one role doing both,
and an engine that made it impossible would be one somebody worked around by inventing a third
role that holds both — which is the same hole with less visibility.

## Where it is enforced

Three layers, and the redundancy is deliberate because each covers a different gap.

### 1. The policy engine — every route

`selfApprovalPolicy` runs inside `PolicyAuthorizationGuard`, so it applies to every route that
declares an approval action, including ones written next year by somebody who has not read this
document.

```ts
if (isSameActor(actor.userId, instance.initiatedById)) {
  return { effect: 'deny', reason: 'self_approval_forbidden' };
}
```

`initiatedById` is read from the instance row. A client-supplied `submittedBy` would make this
bypassable in one line — which is why `WorkflowActor` deliberately has no such field.

Every workflow policy can only _refuse_; none returns `allow`. So adding one can only make the
system stricter, and the set is safe to extend.

### 2. The approval evaluator — the slot

`checkApproverEligibility` decides which approver slot an actor would fill, and refuses first on
self-approval — **before** checking permissions.

That order matters more than it looks. Telling a maker "you lack the approval permission" sends
them to an administrator for a grant that will not help; telling them "you submitted this" is a
complete explanation.

### 3. The definition — the model

An approval step declares `allowSelfApproval: false`, and that is what the policy reads. A
definition is the only place the rule can be relaxed, and relaxing it is visible in a diff, in
the validator's warnings and in the version comparison's control-weakening bucket.

## Separation of duties

Self-approval is one rule in a family. The framework implements these:

| Rule                                              | Enforced by                               |
| ------------------------------------------------- | ----------------------------------------- |
| The requester cannot approve                      | `selfApprovalPolicy`                      |
| One actor approves a step once                    | `duplicateApprovalPolicy`                 |
| The definition's author cannot approve it         | `definitionGovernancePolicy`              |
| The approver cannot publish it                    | `definitionGovernancePolicy`              |
| A delegate must be independently eligible         | `TaskService.delegate`                    |
| A task's holder is the only one who may act on it | `taskOwnershipPolicy`                     |
| A role cannot be granted above the granter's own  | `roleGrantPolicy` (phase 4)               |
| A service account is never platform staff         | `@trustsystem/service-accounts` (phase 4) |

`duplicateApprovalPolicy` is worth distinguishing from self-approval: that actor _is_ a
legitimate approver who has already voted. It matters for threshold models, where counting one
person's two clicks as two approvals would defeat "2 of 3" entirely.

Product rules — "the payment creator cannot approve the payment", "the API key creator cannot
activate the same key" — are the same shape. Register the action with `registerApprovalAction` and
`selfApprovalPolicy` covers it:

```ts
registerApprovalAction('payment.release');
// A payment released by its own creator is now refused, with reason self_approval_forbidden.
```

### The concern a schema cannot see

One permission approving at two steps is two signatures from one population — which is one
signature wearing a hat. The schema knows one step at a time, so `simulateDefinition` reports it:

```
Separation-of-duty concerns:
  - "workflow.approval.decide" approves at 2 steps (manager_review, compliance_review).
    One person holding it could satisfy several supposedly independent reviews.
```

The framework's own example triggers this, honestly. Fixing it means giving each review its own
permission — `operations.approve` and `compliance.approve` — which is what a real deployment
should do and which the example does not, because an example that invented two product
permissions would be teaching a product's vocabulary rather than the framework's.

## Approval models

| Model         | Use when                                                 |
| ------------- | -------------------------------------------------------- |
| `single`      | One authorised checker is the control                    |
| `parallel`    | Several are eligible and any one may decide              |
| `sequential`  | Order matters: operations, then compliance, then finance |
| `unanimous`   | Every named approver must sign                           |
| `threshold`   | K of N, for a committee                                  |
| `conditional` | The required set depends on the request                  |

Three properties hold across all of them:

**A rejection settles the step immediately.** Not configurable. Every real approval chain works
this way, and a model where a refusal could be outvoted would make it advisory.

**Approvals are counted by distinct actor.** `allowSameActorMultipleSlots` defaults to false,
because a threshold one person can meet is not a threshold.

**Progress is derived from the decision trail**, never stored as a counter. The alternative
produces "the instance says 2 of 3 but only one decision exists" — and the trail is what an
auditor reads.

### Sequential offers one approver at a time

`evaluateApproval` returns only the next slot for a sequential model. Offering the third approver
a button before the first has acted would produce a request the runtime refuses, which teaches
people the system is broken.

### Conditional skips are recorded

An approver whose condition is false is _skipped_, and the skip appears in the evaluation:

```json
{ "skipped": [{ "key": "compliance", "name": "Compliance", "reason": "condition_not_met" }] }
```

An auditor asking "why did compliance not review this?" needs the answer "because riskRating was
medium", not an absence.

## Definitions are governed too

This is the control that stops the whole system being circumvented.

Somebody who can author _and_ publish a definition can publish one with
`allowSelfApproval: true` and then approve their own requests through it. Every control in this
document assumes the definition was reviewed by somebody other than its author.

So three grants, three people:

```
author ──submit──▶ reviewer ──approve──▶ publisher ──publish──▶ live
```

- The **author** cannot approve or publish their own version.
- The **approver** cannot publish what they approved.

Three rather than two, because approval is a judgement that the definition is correct and
publication is the act of making it live. One person doing both means one person's opinion is the
only thing between a draft and production.

A **global** definition — available to every tenant — additionally requires platform staff to
author, because otherwise any organization's author could publish a workflow every other
organization could then start.

## Exceptions

Sometimes a deployment genuinely needs one. The framework supports it and makes it loud.

```json
{ "model": "single", "allowSelfApproval": true, "approvers": [ ... ] }
```

Four things then happen, and all four are the point:

1. `validateDefinition` reports `self_approval_permitted` **every time** the definition is
   validated — at draft, at submission, and at approval.
2. The warnings present at approval are **recorded on the approval**, so a warning that is absent
   later means the definition changed.
3. `compareDefinitions` puts enabling it in the **control-weakening** bucket, which the portal
   renders first and labels `CONTROL WEAKENING — review before approving`.
4. The generated `workflow-enabled-saas` template ships a test that **fails the build** if
   `allowSelfApproval` is ever true — because in an application that has decided it must never be
   on, a warning is not enough.

`workflow.approval.override` exists for a stalled approval during an incident. It is a separate
grant, it is incompatible with `approval.decide`, and every use emits
`workflow.approval_overridden` at **critical** severity — reserved for things worth waking
somebody for.

## Rework

A returned request starts a **new approval cycle**, and approvals do not carry across.

That is not an optimisation. After a return the maker may change the very fields an approver
looked at, so an approval from the previous cycle is an approval of a different request.
Counting it would let a maker get one genuine approval, be returned, change the amount, and
inherit the approval for the new amount.

`WorkflowDecision.reworkCycle` is what scopes it, and the previous decisions are **never
deleted** — the point of an approval trail is that it shows what was decided before, not only
what was decided last.

`rework.maxCycles` bounds the loop. An unbounded one is how a request stays open for a year while
both sides believe the other has it.

## What this does not prevent

Stated plainly, because a control document that claims completeness is not useful.

**Collusion.** Two people who agree to approve each other's requests defeat maker-checker
entirely. Nothing here helps. What does: a threshold across a wider population, distinct
permissions per review step, and reading the audit trail for pairs who always approve each other.

**A legitimate administrator abusing legitimate authority.** An `organization_owner` can grant
themselves a checker role, approve, and remove it. Every step is audited, so the control is
detective rather than preventive — `roleGrantPolicy` stops the escalation _above_ their own
level, not sideways.

**Approval without reading.** Nothing distinguishes a considered approval from a click. SLAs and
approval-latency metrics make an implausibly fast decision visible; they do not stop it.

**A compromised account.** Maker-checker assumes the two actors are two people. Phase 4's session
security, MFA requirements and refresh-reuse detection are what make that assumption reasonable —
`@RequireMfa()` on an approval route is worth more here than any workflow setting.

---

**See also:** [workflow-security.md](workflow-security.md) ·
[workflow-definition-guide.md](workflow-definition-guide.md) ·
[workflow-versioning.md](workflow-versioning.md) ·
[../AGENTS.md](../AGENTS.md)

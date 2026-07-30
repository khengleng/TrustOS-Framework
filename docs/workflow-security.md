# Workflow security

The threats a governed workflow faces, what stops each one, and what remains.

- [Threat model](#threat-model)
- [Authorization](#authorization)
- [Tenant isolation](#tenant-isolation)
- [Self-approval prevention](#self-approval-prevention)
- [History protection](#history-protection)
- [Definition integrity](#definition-integrity)
- [Concurrency](#concurrency)
- [Idempotency](#idempotency)
- [Never trusted from a client](#never-trusted-from-a-client)
- [Residual risks](#residual-risks)

---

## Threat model

Thirteen threats, in the order they are likely rather than the order they are interesting.
Residual risk is stated for each, because a threat model claiming full mitigation is a marketing
document.

### 1. Self-approval

**Assets:** every control the workflow exists to impose.

**Controls.** `selfApprovalPolicy` in the policy engine, so it covers every route.
`checkApproverEligibility` refuses before checking permissions, so the message is the useful one.
`allowSelfApproval` defaults false, is reported as a warning every validation, is recorded on the
approval, and appears in the control-weakening bucket of a version comparison.

**Residual risk.** Collusion. Two people approving each other's requests defeat it entirely, and
nothing here helps — a wider threshold and distinct per-step permissions raise the cost.

### 2. Cross-tenant workflow access

**Assets:** another organization's business decisions, in full narrative form. Workflow history is
the most damaging thing to leak in this system.

**Controls.** Every lookup takes the organization from the verified actor and filters on it.
`workflowTenantPolicy` checks the _record's_ organization against the actor's. A record in another
organization is `notFound`, never `forbidden`. Every tenant-owned index leads with
`organizationId`. Explicit tests: instance, task, case, comment, attachment and SLA all refuse a
cross-tenant read and the error carries no organization name.

**Residual risk.** A hand-written raw SQL query bypasses the scoped delegate. The framework cannot
prevent it; row-level security in Postgres would move the boundary into the database.

### 3. Workflow-definition tampering

**Assets:** the rules every decision is made under, retroactively.

**Controls.** Three layers. `assertEditable` refuses the edit. `assertDefinitionUntampered`
verifies a SHA-256 hash on **every compile**, so a direct `UPDATE` is caught before the definition
executes. A database trigger refuses changes to `definition`, `definitionHash`, `version`,
`initialState` and `finalStates` on a published or retired row, and refuses deletion outright.

The trigger rather than a `REVOKE`, because PostgreSQL grants a table's owner implicit rights and
the application usually connects as the owner — a `REVOKE` succeeds and changes nothing.

**Residual risk.** A superuser can drop the trigger. This is a control against application bugs, a
compromised application role and well-meaning manual edits — not against a compromised database
administrator.

### 4. Unauthorised task reassignment

**Assets:** the outcome of a decision, steered by choosing who makes it.

**Controls.** `workflow.task.reassign` is a separate grant. A reason is mandatory. Every
reassignment writes a history entry _and_ emits `workflow.task_reassigned` to the security event
trail, because moving an approval from one reviewer to another is how a decision gets steered.
Delegation additionally requires the delegate to be independently eligible.

**Residual risk.** An administrator with the grant can reassign until a compliant reviewer holds
the task. Detective rather than preventive: the trail shows the sequence.

### 5. Duplicate approval

**Assets:** the meaning of a threshold.

**Controls.** `duplicateApprovalPolicy` refuses a second decision from the same actor on the same
step and cycle. `countDistinctApprovals` counts actors, not decisions.
`allowSameActorMultipleSlots` defaults false. Idempotency keys collapse a double-submit.

**Residual risk.** None known for a single step. Across steps, the same _permission_ approving
twice is threat 1's collusion problem wearing different clothes — `simulateDefinition` reports it.

### 6. Stale decision submission

**Assets:** the integrity of a decision made against a state that has since changed.

**Controls.** Optimistic locking. `expectedVersion` on a transition; every write conditional on
the version the read saw. A mismatch is a 409 with both numbers. `instanceActivePolicy` refuses
any action on a finished instance, so an approval cannot land after a rejection.

**Residual risk.** `expectedVersion` is optional. A client that omits it applies its decision to
whatever the instance now is, and the API cannot tell the difference between a considered
omission and a careless one.

### 7. Double task claim

**Assets:** two people doing the same work, one of them losing it.

**Controls.** A conditional `updateMany` with the version _and_ `claimedById: null` in the `where`.
Zero rows means somebody else won. Measured: 100 concurrent claims on one task produced exactly
one success and 99 conflicts.

**Residual risk.** None for the claim. A _claimed_ task has no expiry, so a claimant who goes on
leave holds it until an administrator releases it — which is why `release` accepts
`workflow.task.reassign` as well as the claimant.

### 8. Unsafe condition execution

**Assets:** the process, via a definition author.

**Controls.** No expression language. A structured predicate tree with eleven operators, no
parser, and no syntax for a function call. `__proto__`, `constructor` and `prototype` refused by
name; own-property access only in `readField`. Depth bounded at five. `callbackKey` names a
registered handler, never a URL.

**Residual risk.** A definition author can still write a _wrong_ condition — one that routes a
high-risk request as low-risk. `simulate` reports the paths and
`condition_field_undeclared` catches the common typo, but semantic correctness is a review
question.

### 9. Attachment access bypass

**Assets:** a document the actor should not read, published to every workflow participant.

**Controls.** `attach` checks the document exists **in this organization**, then that the actor may
read it. A checksum is recorded at attach time and re-checkable later. Detaching marks the
reference removed and never deletes the document, because another workflow may cite it and an
approver's decision was made with it in view.

**Residual risk.** No malware scanning. `scanStatus` is always `not_scanned`, which is honest —
defaulting it to `clean` would be a lie a compliance review would eventually find.

### 10. History deletion or amendment

**Assets:** the record of who approved what.

**Controls.** `HistoryStore` has **no** update and no delete method — not one you should avoid,
genuinely none. Database triggers refuse `UPDATE` and `DELETE` on `WorkflowEvent`,
`WorkflowDecision` and `WorkflowCommentAmendment`. A comment amendment writes the previous text and
increments a counter every reader sees. A redaction hides the text and retains it.

**Residual risk.** A superuser can drop the triggers. Shipping records off-host to append-only
storage is the next control and is not implemented.

### 11. Privilege escalation through a workflow

**Assets:** a role above the actor's own, granted by a workflow that assigns roles.

**Controls.** `roleGrantPolicy(canGrantRole)` is registered in the example composition roots, so a
workflow that grants a role is subject to phase 4's grant matrix. `definitionGovernancePolicy`
stops an author publishing a definition that would grant more than they hold.

**Residual risk.** A product that assigns roles in application code after a workflow completes
bypasses the policy. The engine's job is to authorise the transition; what a product does with the
outcome is the product's.

### 12. Idempotency abuse

**Assets:** an operation replayed as a different one.

**Controls.** The request payload is hashed. Same key and same payload replays the reference; same
key and a _different_ payload is refused, because replaying would tell the caller an operation
succeeded that never ran for this request. An `in_progress` key is refused rather than raced. A
failed key is refused rather than retried, because the failure was almost certainly deterministic.
Keys expire after 24 hours so the table stays bounded.

**Residual risk.** A caller who reuses one key for everything gets one successful operation and a
stream of conflicts. Confusing, and safe.

### 13. Insider access to the workflow portal

**Assets:** every decision in the organization.

**Controls.** Per-operation permissions, read split from write. `administrator` can reassign and
cancel but not author definitions. `auditor` reads only. Every privileged operation is audited.
`@HumanActorsOnly()` on definition governance, so no machine can publish a workflow.

**Residual risk.** An `organization_owner` can grant themselves a checker role, approve, and remove
it. Detective: the trail shows it. Two-person approval for role grants is the next control.

## Authorization

Four layers, each able only to refuse:

```
AuthenticationGuard    who is calling?
TenantGuard            whose data may they touch?
PermissionsGuard       do they hold the permission?     (deny by default)
PolicyAuthorizationGuard  does the full policy set allow it?
```

The workflow policies live in the last one. **None of them returns `allow`** — the only policy in
the framework's set that can is `rbac.permission`, and it runs last. So adding a workflow policy
can only make the system stricter, which is what makes the set safe to extend.

### Why policies rather than checks in the engine

A check inside the engine covers one call path. A policy is evaluated by
`PolicyAuthorizationGuard` on every route that declares a workflow action — including one written
next year by somebody who has not read this document.

The engine additionally calls `authorizer.assert` with the loaded record, because a guard runs
before the handler has loaded anything. `workflowResource()` builds the resource; a policy that
cannot find its field _abstains_, and an abstaining separation-of-duty policy is a control that
silently does not run — which is why there is one constructor rather than object literals at each
call site.

### Order changes the message, not the outcome

Any deny refuses. The order decides which _reason_ is reported, and the reason is what somebody
acts on:

1. tenant isolation — a cross-tenant reach is never told anything more specific
2. instance active — a closed workflow makes every later question moot
3. self-approval — **before** permissions, because "you lack the permission" sends a maker to an
   administrator for a grant that will not help
4. duplicate approval
5. task ownership
6. definition governance
7. the definition's own transition permission

### The definition can be stricter than the route

`transitionPermissionPolicy` checks the permission the _definition_ attaches to a transition. An
administrator holding `workflow.instance.transition` still cannot take a transition reserved for
`workflow.approval.decide`. A definition can therefore be stricter than the route it is reached
through, and never looser.

## Tenant isolation

The organization comes from the verified actor. There is no route that accepts an organization id
and no field in `WorkflowActor` a client could populate.

Two checks, because they cover different gaps: `TenantGuard` verifies the actor belongs to the
organization on the request, and `workflowTenantPolicy` verifies the _record_ belongs to the same
one. The first stops an actor claiming an organization they are not in; the second stops an actor
in A reaching a record in B by id.

Cross-tenant is **`notFound`, never `forbidden`.** A 403 confirms the record exists somewhere,
which is the enumeration primitive the boundary exists to deny. `explainDenial('cross_tenant')`
returns `'Not found.'` for the same reason.

### The one place a null organization is correct

`WorkflowDefinition` and `WorkflowVersion` may be platform-owned, which is what makes a
framework-shipped workflow available to every tenant. Every _instance_ has a real organization, and
that is where isolation is enforced. Authoring a global definition requires platform staff.

## Self-approval prevention

Covered in [maker-checker.md](maker-checker.md). The short version: three layers, the default is
off, and turning it on is visible four different ways.

## History protection

`HistoryStore` has no mutating methods beyond `append`. Triggers refuse `UPDATE` and `DELETE` on
the three append-only tables.

Two consequences worth knowing:

**Metadata is redacted before it is written.** Instance data is caller-supplied and history is the
longest-lived record in the system — a secret written here outlives the incident that leaked it.
`redactMetadata` is depth-limited, cycle-safe, bounds arrays at 50 elements and drops functions.

**A comment's text never reaches history.** `CommentRecordedNotice` carries ids and metadata, not
the comment record. An earlier version passed the whole comment, which put the text one careless
`metadata: comment` away from being copied — a test caught it. The text lives in one row because
that is the row an amendment updates; a copy in history is a second version a correction never
reaches.

**An instance cannot be deleted while it has history.** The cascade hits the trigger. That is
correct — the record of what was decided must outlive the record it was about — and it means a
development database is reset by dropping it.

## Definition integrity

The hash is verified on every compile, not only at publication:

```ts
assertDefinitionUntampered({ definition, expectedHash, version });
```

Keys are sorted recursively before hashing, so a round-trip through a JSON parser that does not
preserve order is not mistaken for tampering. Array order _is_ preserved, because approver order
is meaningful.

A mismatch throws `internal` rather than a validation error, because it is not a validation problem
— it is evidence that something wrote to the table outside the application, and continuing would
mean executing rules nobody approved. It emits
`workflow.definition_tampering_detected` at critical severity.

## Concurrency

Optimistic locking on every mutable record: `WorkflowInstance.version`, `WorkflowTask.version`,
`CaseRecord.version`. Every write is a conditional `updateMany`; zero rows is a 409.

Three different 409s, and a client should handle them differently:

| Reason                                  | What happened               | What to do       |
| --------------------------------------- | --------------------------- | ---------------- |
| `stale_version`                         | Somebody changed the record | Reload and retry |
| `already_claimed` / `already_completed` | Somebody else did it        | Do not retry     |
| `idempotency_key_reused`                | A caller bug                | Do not retry     |

Measured under load: 100 concurrent claims on one task → 1 success, 99 conflicts. 100 concurrent
instance starts → 100 successes, 0 conflicts.

The claim is atomic **in the store**, not in the service. A check-then-act split across two calls
cannot be made safe by anything the service layer does, so the atomicity lives where the row does.

## Never trusted from a client

| Never accepted            | Where it comes from instead           |
| ------------------------- | ------------------------------------- |
| Workflow state            | the definition's transitions          |
| `initiatedById`           | the instance row                      |
| Roles, permissions        | the membership tables, per request    |
| Organization              | the verified actor                    |
| Approval status           | the decision trail                    |
| Task ownership            | the task row                          |
| Comment visibility filter | computed from the actor's permissions |
| An escalation URL         | a registered callback key             |

There is no route that sets `currentState`. Every move goes through an action the definition
declares, which is why `simulate` can enumerate every path a request could take — if a state could
be set directly, it could not.

## Residual risks

Collected, so they are readable in one place:

1. **Collusion between a maker and a checker** defeats maker-checker. Wider thresholds and distinct
   per-step permissions raise the cost; nothing eliminates it.
2. **A superuser can drop the append-only triggers.** Off-host append-only storage is the next
   control.
3. **Raw SQL bypasses tenant scoping.** Row-level security would move the boundary into the
   database.
4. **`expectedVersion` is optional**, so a careless client can apply a stale decision.
5. **No malware scanning** on attachments. The status field is honest about it.
6. **A claimed task never expires**, so a holder who disappears blocks it until released.
7. **Process-local rate limiting** (inherited from phase 4) means N instances give an attacker N
   times the attempts against a workflow endpoint.
8. **Semantic correctness of a condition is a review question.** The validator catches typos and
   type errors, not a threshold set to the wrong number.
9. **An administrator can steer a decision** by reassignment. Detective, not preventive.
10. **The escalation resolver is a deployment's to wire.** The example application claims
    thresholds and reports that no rules ran, rather than pretending it escalated.

---

**See also:** [maker-checker.md](maker-checker.md) ·
[workflow-architecture.md](workflow-architecture.md) ·
[workflow-operations.md](workflow-operations.md) ·
[threat-model.md](threat-model.md) ·
[../AGENTS.md](../AGENTS.md)

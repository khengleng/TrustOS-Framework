# Workflow versioning

A published workflow definition never changes. Everything else in this document follows from that
one sentence.

- [Why immutability](#why-immutability)
- [The lifecycle](#the-lifecycle)
- [Three layers of enforcement](#three-layers-of-enforcement)
- [What happens to running instances](#what-happens-to-running-instances)
- [Comparing versions](#comparing-versions)
- [Choosing a version number](#choosing-a-version-number)
- [Activation and retirement](#activation-and-retirement)
- [Rollback](#rollback)
- [Global and organization definitions](#global-and-organization-definitions)
- [Upgrading](#upgrading)

---

## Why immutability

A running instance holds a version id and reads its rules from that row. Editing the row would
retroactively change the rules a decision was made under.

Concretely: a request is approved under a definition requiring two approvals. Somebody edits the
definition to require one. The audit trail now says the request was approved under a workflow that
requires one approval — and there is no way to discover that it required two at the time. The trail
becomes a record of what the workflow says _now_ rather than what it said then, which is the one
thing an audit trail must not be.

So a change is a new version. That is the only rule, and it has three useful consequences:

1. **A decision is explicable forever.** Load the version an instance ran under and the rules are
   exactly what applied.
2. **A definition can be cached with no invalidation.** Version 1.0.0 can never become stale, which
   is why `CompiledWorkflowCache` has no invalidation logic to get wrong.
3. **Rollback is a publication, not an edit.** Which means the trail shows a version was live,
   retired, and made live again — because that is what happened.

## The lifecycle

```
draft ──submit──▶ under_review ──approve──▶ approved ──publish──▶ published ──retire──▶ retired
  ▲                    │                        │
  └────withdraw────────┴────────────────────────┘
```

| From                    | To           | Permission                    | Note                                      |
| ----------------------- | ------------ | ----------------------------- | ----------------------------------------- |
| draft                   | under_review | `workflow.definition.submit`  | Editing stops here                        |
| under_review            | approved     | `workflow.definition.approve` | Refused for the author                    |
| approved                | published    | `workflow.definition.publish` | Refused for the author _and_ the approver |
| published               | retired      | `workflow.definition.retire`  | New instances stop; running ones continue |
| under_review / approved | draft        | `workflow.definition.update`  | Withdraw to edit again                    |

`published → draft` does not exist. `retired` is terminal.

### Editing stops at `under_review`, not at `approved`

A definition under review is one somebody is reading. Letting the author edit it underneath the
reviewer means the reviewer approves something other than what they read.

Withdrawing to draft is the way to change it, and withdrawal **clears any approval** — a
withdrawn-and-reworked version carrying its previous approval would be a definition approved in one
form and published in another.

### Three people, not two

Author, approver, publisher. Approval is a judgement that the definition is correct; publication is
the act of making it live. One person doing both means one person's opinion is the only thing
between a draft and production.

Enforced by `definitionGovernancePolicy`, so it applies to every route rather than to one service
method. See [maker-checker.md](maker-checker.md#definitions-are-governed-too).

## Three layers of enforcement

Immutability is enforced three times, and each layer covers a gap the others do not.

### 1. The service refuses the edit

`assertEditable` allows changes only in `draft`. `assertStatusTransition` refuses
`published → draft` with a message saying what to do instead.

Covers: an application bug, a route somebody added without thinking.

### 2. The runtime verifies a hash on every compile

```ts
assertDefinitionUntampered({ definition, expectedHash: version.definitionHash, version });
```

SHA-256 of the document with object keys sorted recursively — so a round-trip through a JSON parser
that does not preserve order is not mistaken for tampering, while array order _is_ preserved
because approver order is meaningful.

Covers: a direct `UPDATE` against the table. The application has write access to its own database,
so "the API refuses" is not a guarantee. A mismatch throws and emits
`workflow.definition_tampering_detected` at critical severity.

### 3. A database trigger refuses the write

`trustos_workflow_version_immutable` refuses changes to `definition`, `definitionHash`, `version`,
`initialState`, `finalStates` and `workflowDefinitionId` on a published or retired row.
`trustos_workflow_version_no_delete` refuses deletion.

Status and retirement fields stay mutable, because retiring a version _is_ a legitimate update to a
published row.

A trigger rather than a `REVOKE`, for the reason phase 1 documented for `AuditLog`: PostgreSQL
grants a table's owner implicit rights on it, so when the application connects as the owner — the
default on Railway and most single-role deployments — the `REVOKE` succeeds and changes nothing. A
`BEFORE` trigger applies to the owner too.

What none of the three stops: a superuser dropping the trigger. This is a control against
application bugs, a compromised application role and well-meaning manual edits.

## What happens to running instances

**Nothing. They are never migrated.**

An instance pins `workflowVersionId` at start and reads its rules from that row for its whole life.
Publishing version 2.0.0 does not touch a single instance running 1.0.0.

That is deliberate and not a limitation. Automatic migration would mean a request that entered
`manager_review` under one set of approval rules gets approved under another — and the states might
not even correspond. If 2.0.0 renamed `manager_review` to `operations_review`, an instance sitting
in the old state has no step and no transitions.

### The consequence to plan for

Both versions run concurrently until the last old instance finishes. That means:

- Both must remain readable. A retired version is never deleted for this reason.
- `countActiveInstances` reports how many are still on a version, and retirement reports it rather
  than blocking — an operator retiring a version usually knows there are instances on it, and
  blocking would mean waiting weeks for the last one.
- A long-running workflow keeps an old version alive for a long time. If that is a problem, cancel
  the instances and restart them on the new version; the trail shows both.

### If you must move an instance

There is no supported path, on purpose. What a deployment can do:

1. Cancel the instance with a reason naming the migration.
2. Start a new instance on the new version against the same business object.
3. Link the two in a case, or in the new instance's data.

The history of both survives, which is the point. A "migration" that rewrote the instance's version
id would produce a record of a decision made under rules that were not in force.

## Comparing versions

```
GET /workflow/definitions/versions/compare?fromVersionId=...&toVersionId=...
```

Organised by **consequence**, not by field, with four buckets:

| Bucket             | Contains                                                                                                                         | Who cares                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `controlWeakening` | Self-approval enabled, a permission removed, fewer approvals required, an attachment requirement dropped, a rework limit removed | Governance: should this change happen at all?     |
| `breaking`         | A state or transition removed, the initial state changed, an approval model changed, a state made final                          | Engineering: what happens to in-flight instances? |
| `additive`         | A state, transition or step added; more approvals required                                                                       | Informational                                     |
| `cosmetic`         | Name, description, labels                                                                                                        | Informational                                     |

Control weakening is a separate bucket from breaking because the two need different readers, and
`formatComparison` renders it **first**, labelled `CONTROL WEAKENING — review before approving`.

A raw JSON diff would surface the same bytes and bury both. This is the review artefact a visual
designer cannot produce, and it is one of the reasons definitions are text.

## Choosing a version number

Semantic, and `suggestNextVersion` proposes while the author decides:

| Change                        | Bump  | Why                                                                        |
| ----------------------------- | ----- | -------------------------------------------------------------------------- |
| A state or transition removed | major | An in-flight instance may be sitting in exactly the state that was removed |
| The initial state changed     | major |                                                                            |
| An approval model changed     | major |                                                                            |
| A state or transition added   | minor | Existing paths are unaffected                                              |
| More approvals required       | minor | Stricter, not incompatible                                                 |
| Name, description, labels     | patch |                                                                            |

The heuristic is deliberately conservative: a removal is major, because the failure mode is a
stranded instance rather than a mildly surprising one.

It **suggests** rather than deciding, because whether a change is breaking is a judgement about how
instances actually flow — and the tool cannot know that a state nothing has ever entered is safe to
remove.

## Activation and retirement

Publishing 2.0.0 **retires 1.0.0 by default**:

```
POST /workflow/definitions/versions/:id/publish
{ "effectiveFrom": "2026-08-05T00:00:00Z", "retirePrevious": true }
```

Two published versions of one key would make "the published version" ambiguous, and
`findPublished` would return whichever the query happened to order first. Retiring keeps exactly
one active.

`retirePrevious: false` is available and is almost always wrong. If you need two live variants, they
are two definitions with two keys.

Retirement:

```
POST /workflow/definitions/versions/:id/retire
{ "reason": "Superseded by 2.0.0; compliance threshold changed." }
```

Requires a reason and reports `activeInstances`. New instances stop immediately; running ones
continue on the retired version, and it stays readable forever.

## Rollback

**Rollback is republishing a previously approved version.** It is not an edit, and it is not
un-retiring.

```
POST /workflow/definitions/versions/:oldVersionId/rollback
{ "reason": "2.0.0 routed medium-risk requests past compliance." }
```

What happens:

1. The old version must already have `approvedById` set. Rollback is not a way to make an unreviewed
   definition live in a hurry — which is exactly when somebody would want it to be.
2. Governance policies run again, so the actor rolling back cannot be the version's author.
3. The currently published version is retired, with a reason naming the rollback.
4. The old version is published again, with a **new** `publishedAt` and `publishedById`.
5. A `definition.published` event is recorded with `rollback: true`.

The old version keeps its original approval record. The trail therefore shows: published, retired,
published again — because that is what happened, and a rollback that looked like the version had
never been retired would be a rewritten history.

Instances started under 2.0.0 keep running under 2.0.0. Rollback changes what _new_ instances use.

## Global and organization definitions

A definition may be **platform-owned** (`organizationId: null`), which makes it available to every
tenant. That is how a framework-shipped workflow works.

Resolution prefers an organization's own definition over a platform one with the same key:

```
1. This organization's definition with this key, published  → use it
2. The platform definition with this key, published         → use it
3. Nothing                                                  → refuse to start
```

That ordering is the extension mechanism: a tenant can publish their own version of a framework
workflow, and the framework's remains available to everybody who has not. Two explicit queries
rather than one `OR`, so the preference is in the code rather than depending on how the database
orders a disjunction.

Authoring a global definition requires platform staff. Without that check, any organization's
author could publish a workflow every other organization could then start.

## Upgrading

### The framework

The workflow tables are the framework's, so a framework upgrade may add columns. A generated
application carries a **copy** of the schema, because Prisma has no cross-package schema import.

`templates/workflow-enabled-saas` ships `workflow-schema.spec.ts`, which compares the copy against
the framework's and fails when they diverge. That test exists because the framework's own
`00-framework.prisma` copy silently fell behind between phases — and a stale copy produces a client
that does not know a column the engine writes, whose first symptom is a runtime error rather than a
build failure.

Run it after every framework upgrade. It prints which models drifted.

### A definition

```bash
# 1. Copy the current version to a new file and edit it.
cp workflows/change-request-approval.json workflows/change-request-approval-2.json

# 2. Validate, including permission references.
trustos workflow validate workflows/change-request-approval-2.json --strict-permissions

# 3. Walk every path. Non-zero if any reaches approval with no review.
trustos workflow simulate workflows/change-request-approval-2.json

# 4. Create the draft, read the comparison, then submit → approve → publish.
```

Step 3 is the one worth putting in a pre-commit hook. A path to `approved` with no review is
invisible on inspection of a forty-state document and obvious to a graph walk, and it is almost
always a shortcut transition added for testing and left in.

---

**See also:** [workflow-definition-guide.md](workflow-definition-guide.md) ·
[maker-checker.md](maker-checker.md) ·
[workflow-architecture.md](workflow-architecture.md) ·
[workflow-operations.md](workflow-operations.md)

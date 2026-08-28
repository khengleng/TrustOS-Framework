# Financial product security

Read this before changing anything in `financial-product-runtime/engine.ts`,
`financial-product-registry/registry.ts`, `financial-product-policy/policies.ts`,
`financial-product-versioning/version.ts` or `financial-product-composer/validate.ts`. The checks
in those files look redundant and are not.

- [The threat model](#the-threat-model)
- [Default deny](#default-deny)
- [The controls, and where each one lives](#the-controls-and-where-each-one-lives)
- [Tenant isolation](#tenant-isolation)
- [Idempotency](#idempotency)
- [Version substitution](#version-substitution)
- [Rule and connector tampering](#rule-and-connector-tampering)
- [AI-generated configuration](#ai-generated-configuration)
- [Audit](#audit)
- [What this layer does not defend against](#what-this-layer-does-not-defend-against)
- [The negative tests](#the-negative-tests)

---

## The threat model

Section 26 of the specification names fourteen. Each is listed here with where it is refused —
because a threat with no named enforcement point is a threat somebody assumes is handled.

| Threat                           | Refused by                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Unauthorized product publication | `PRODUCT_PUBLISH` permission + `productSelfPublicationPolicy` + `ProductRegistry.publish` |
| Self-approval                    | `productSelfApprovalPolicy` + `recordDecision` + `checkLifecycleTransition`               |
| Cross-tenant access              | Every store method takes `organizationId`; another tenant's record is `not_found`         |
| Rule tampering                   | Rules live in the definition; the definition is hashed; the hash is re-checked on load    |
| Connector tampering              | `requireBindable` + `productProviderSubstitutionPolicy`                                   |
| Fee manipulation                 | `financial.product.fee.update` + `productSensitiveChangePolicy` + FINANCE approval        |
| Limit bypass                     | The composer's ordering analysis + a limit block that consumes rather than checks         |
| Provider substitution            | `requireBindable` refuses a connector the tenant has not approved                         |
| Replay attacks                   | Idempotency keys with a request hash, and a conflict on a changed payload                 |
| Duplicate transactions           | The same                                                                                  |
| Version substitution             | Version binding + content hash + `assertBindingIntact`                                    |
| Audit deletion                   | No delete route, and the audit sink is append-only                                        |
| Unsafe AI configuration          | A strict proposal schema, a forced `draft`, and the same lifecycle                        |
| Draft execution                  | `EXECUTABLE_STATUSES` has one member, checked in `bindVersion` and in a policy            |

## Default deny

Three layers, and all three deny by default.

**Permissions.** `PermissionsGuard` refuses unless the actor holds the key the route declares.

**Policies.** `authorize()` denies unless a policy explicitly allows, and **every policy in this
layer can only refuse** — none returns `allow`. Adding one can only make the system stricter.

**The lifecycle.** `EXECUTABLE_STATUSES` has one member. A state not in it does not execute, and
the runtime asks the set rather than deciding for itself — a runtime that decided would be a
runtime with a code path that could be persuaded.

## The controls, and where each one lives

Several controls are enforced in **two places**, and that is deliberate rather than redundant.

| Control              | Enforcement point 1                               | Enforcement point 2                 |
| -------------------- | ------------------------------------------------- | ----------------------------------- |
| Self-approval        | `productSelfApprovalPolicy` — every route         | `recordDecision` — the registry     |
| Only active executes | `productExecutionEnvironmentPolicy` — every route | `bindVersion` — the runtime         |
| Immutability         | `productImmutabilityPolicy` — every route         | `assertUnpublishedOrIdentical`      |
| Provider binding     | `productProviderSubstitutionPolicy`               | `ConnectorRegistry.requireBindable` |

The policy covers **every route that declares a product action, including one written next year by
somebody who never read the registry**. The service check covers the service. Neither alone is
enough: a check in a service covers one call path, and a policy cannot load a record because a
guard runs before the handler.

## Tenant isolation

Every store method takes `organizationId` explicitly, and it is `string | null` rather than
optional so a caller cannot omit it. Null is the platform tenant, not a wildcard.

**Another tenant's product is `not_found`, never `forbidden`.** A 403 confirms the record exists,
which is the enumeration primitive the boundary exists to deny. That applies to products,
versions, variants, connectors and rollback targets — `planRollback` reports a cross-tenant target
as `product_not_found` for exactly this reason.

The organization comes from the verified actor and the server-side membership lookup. An
`X-Organization-Id` header naming an organization is a request, not a fact — and the dispatcher
has no code path that reads one.

## Idempotency

Every operation that creates a transaction takes a key, and the store enforces it with a **unique
constraint**. A read-then-write check passes every single-threaded test and creates two
transactions the moment two workers retry together — which is the normal case, because the reason
a client retries is that something was slow enough for two workers to be involved.

Three behaviours, and the third is the one people get wrong:

| Case                                  | Behaviour                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Same key, same payload, completed     | Return the stored result                                                                    |
| Same key, same payload, still running | **Refuse.** Returning a partial result tells the caller an operation completed that has not |
| Same key, different payload           | **Refuse.** Never replay                                                                    |

Never replay the first result for a different payload. That tells the caller an operation
succeeded that never ran _for their request_, which is worse than any error because they act on it.

The key is scoped to the tenant, the product and the operation, with `COALESCE` on the
organization in the SQL — PostgreSQL treats NULL as distinct from NULL, so a platform-tenant key
would never collide with itself.

The API refuses a **missing** key rather than generating one. A generated key makes every retry a
new transaction.

## Version substitution

Three mechanisms, layered.

**Binding.** An execution records the version and the content hash at start. Everything after
reads the bound definition; the active version is never re-resolved.

**The content hash, re-checked on every load.** `verifyContentHash` runs each time the registry
resolves a version, not once at start-up. Caching the verdict would mean a definition edited
between two executions is verified once and trusted afterwards, which is the window somebody would
use.

**`assertBindingIntact` on resume.** When an execution comes back from review or a provider
finally answers, the binding is re-checked against the stored version. It deliberately does _not_
check that the product is still active — that would kill every in-flight transaction the moment an
incident was handled.

The hash covers reviewed content and **excludes `lifecycleStatus`**. Including it would mean
pausing a product breaks every in-flight execution during exactly the incident the pause was
handling — the system least able to absorb a second problem.

## Rule and connector tampering

Rules are part of the definition, so they are hashed with it and immutable once published. A rule
change is `financial.product.rule.update` and needs RISK approval.

The rule **language** is a structured predicate tree, not an expression string — imported whole
from `@trustos/workflow-definition`, whose header explains at length why every convenient
alternative (`eval`, a general expression library, a template language) is a code-execution
primitive. The field pattern excludes `$` and brackets; `__proto__`, `constructor` and `prototype`
are refused by name; and `readField` accesses own properties only. Two independent defences,
because this is the boundary between a definition document and the process.

The rule **outcomes** are a closed union of eight. There is no `execute`, no `call`, no `script`
and no `set` that could write an arbitrary field of the execution context. A rule may steer the
runtime; it may not become it.

The rule **facts** are a closed list of twenty-three. The engine never receives the execution
context — it receives a fact map built from it — so a rule cannot price by customer id or by
tenant. Adding a fact is a deliberate change to `facts.ts` and `RULE_FACTS`, reviewed as one.

Connectors carry no endpoint and no credential, and the schema refuses anything URL-shaped. A URL
in a product-layer artefact is an environment leaking into an approved document: the staging URL
ships to production and it works, because staging answers.

## AI-generated configuration

The framework ships **no model call**. `buildCompositionBrief` produces the brief a deployment
sends through `@trustos/ai-gateway` — where policy, guardrails, cost accounting and audit are
applied — and `draftFromProposal` takes whatever comes back.

The proposal is **parsed, not trusted**:

- A block outside the approved catalog is refused at the block, before a definition exists.
- A currency the deployment does not support is dropped and reported.
- A country outside the deployment's list is dropped — expanding jurisdiction is a governed change.
- A connector the tenant has not approved is dropped.
- The lifecycle status is forced to `draft`.

The proposal schema has **no field** for ownership, approval levels, lifecycle status, audit
classification or retention. A model that could nominate the risk owner could nominate one who does
not exist, and the approval requirement would be satisfied by nobody.

Everything overridden is reported in `overrides`, which is the reviewer's first read.

## Audit

Every governed action is audited, and the action names are **specific**: a fee change is
`financial.product.fee.changed`, not `edited`. An auditor searching for fee changes will search for
the action name, not read every edit record and diff it.

`auditGovernanceAction` writes the record in the same call as the state change. A caller who wrote
one and forgot the other produces a complete history and an audit trail with a hole in it,
discovered during an audit rather than in a test.

Audit records carry **identifiers, outcomes and reasons** — never a payload, never an amount that
was not part of the decision, never a credential. The admin API has no `DELETE` route at all, and
the boot test asserts it.

## What this layer does not defend against

Stated plainly, because a control somebody assumes exists is worse than one that does not.

**A compromised handler.** A handler binds a block to `@trustos/wallet`; if the deployment's
handler moves money to the wrong account, nothing here notices. The ledger's own controls apply,
and they are phase 8's.

**A malicious approver.** Maker-checker ensures two people; it does not ensure two _honest_
people. Segregation of duties reduces the blast radius and the audit trail names them.

**A wrong fee that everybody approved.** The layer enforces that a fee change was reviewed by
finance, not that finance was right. The simulator is what turns a number into a consequence
somebody can see before it ships.

**Provider-side fraud.** Screening is a provider interface with no implementation here. A
deployment that binds nothing to `RiskProvider` has a product whose risk blocks fail, loudly —
which is the correct behaviour and is not the same as being screened.

**Cardinality in a deployment's own metrics.** `guardedSink` refuses an unbounded dimension on
this layer's metrics. A deployment emitting its own is on its own.

## The negative tests

Nine, named in section 31 of the specification, and each one exists in the suite:

| Test                                              | Where                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A draft product cannot execute                    | `financial-product-runtime.spec.ts`, `financial-product-versioning.spec.ts`                                      |
| A maker cannot approve their own product          | `financial-product-governance.spec.ts`, `financial-product-registry.spec.ts`, `financial-product-policy.spec.ts` |
| An unauthorized fee change is rejected            | `financial-product-registry.spec.ts`, `financial-product-policy.spec.ts`                                         |
| Cross-tenant product access is rejected           | `financial-product-registry.spec.ts`, `financial-product-api.spec.ts`                                            |
| An invalid version is rejected                    | `financial-product-versioning.spec.ts`                                                                           |
| A duplicate transaction is blocked                | `financial-product-runtime.spec.ts`, `financial-product-sandbox.spec.ts`                                         |
| A provider override is rejected                   | `financial-product-runtime.spec.ts`, `financial-product-policy.spec.ts`                                          |
| An unapproved rule is rejected                    | `financial-product-rules.spec.ts`, `financial-product-composer.spec.ts`                                          |
| A rollback does not alter historical transactions | `financial-product-versioning.spec.ts`, `financial-product-registry.spec.ts`                                     |

Plus the ones that are not on the list and matter as much: a variant cannot weaken a rule that
refuses, a paused product does not break its in-flight executions, a limit check on one branch is
refused, and an AI proposal naming a block that does not exist is refused at the block.

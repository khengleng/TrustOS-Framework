# Product governance

Who owns a product, which changes need a second person, how the required approvals are derived,
and what the audit trail has to answer.

- [Ownership](#ownership)
- [Change classification](#change-classification)
- [Which approvals a change needs](#which-approvals-a-change-needs)
- [Maker-checker](#maker-checker)
- [Separation of duties](#separation-of-duties)
- [Governance health](#governance-health)
- [The audit trail](#the-audit-trail)
- [Seeding roles](#seeding-roles)

---

## Ownership

Every product declares four owners, and all four are required:

| Owner             | Answers                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `businessOwner`   | Whose product is this, commercially?                              |
| `technicalOwner`  | Who do I call at 3am?                                             |
| `riskOwner`       | Who signed off on the limits and the exposure?                    |
| `complianceOwner` | Who signed off on the screening, the KYC level and the retention? |

They are required rather than optional because an optional owner field is an empty owner field,
and "who signed off on this fee" is a question that only ever gets asked after something has gone
wrong.

They are **actor identifiers**, not names or email addresses. The directory resolves them, and
keeping personal data out of the definition means the definition can be shown to anybody who needs
to review the product.

One person holding all four roles is legitimate in a small deployment and is reported as a
finding rather than hidden — see [governance health](#governance-health). What that finding
prevents is the org chart that says four names while one person signs everything.

## Change classification

The required approvals are **derived from a diff**, not declared by whoever is submitting.

```ts
const classification = classifyChange(previousDefinition, newDefinition);
// -> { changedPaths, sensitivePaths, requiredApprovalLevels, hasChanges, summary }
```

A product owner asked which approvals their change needs will answer with the ones they expect,
and the ones they expect are the ones they remembered. A diff does not forget.

The comparison is over **canonical JSON**, so re-serialising through a database is not a change
and neither is reordering object keys. Array order **is** significant, deliberately: the order of
transitions decides which branch is evaluated first, so a reordering is a change even when the set
is identical.

Two fields are never material: `lifecycleStatus` (which moves as the product progresses) and
`version` (which moves by definition). Nothing that affects a transaction is on that list and
nothing that affects one ever should be.

**A new product is a change to everything it declares.** Not an empty diff. A first version that
needed no approvals because "nothing changed" is the exact hole somebody would use: create the
product with the fee already in it, and the fee never went through a fee review.

## Which approvals a change needs

| Changed field           | Approval levels        |
| ----------------------- | ---------------------- |
| `fees`                  | PRODUCT_OWNER, FINANCE |
| `limits`                | PRODUCT_OWNER, RISK    |
| `providers`             | SECURITY, OPERATIONS   |
| `rules`                 | PRODUCT_OWNER, RISK    |
| `settlementPolicy`      | OPERATIONS, FINANCE    |
| `reconciliationPolicy`  | OPERATIONS             |
| `riskPolicy`            | RISK, COMPLIANCE       |
| `compliancePolicy`      | COMPLIANCE             |
| `apiExposurePolicy`     | SECURITY               |
| `supportedCountries`    | COMPLIANCE, RISK       |
| `supportedCurrencies`   | FINANCE, OPERATIONS    |
| `blocks`, `transitions` | PRODUCT_OWNER, RISK    |

The result is a **union**, not the strictest single set. A change touching both fees and countries
needs finance _and_ compliance — taking the maximum of two sets is not a thing, and a design that
picked one would drop the other silently. `PRODUCT_OWNER` is always included when anything
sensitive changed.

Four of these have their **own permission** on top of `financial.product.update`:
`financial.product.fee.update`, `.limit.update`, `.provider.update`, `.rule.update`. Those are the
four changes that alter money, exposure, counterparty and routing without altering the workflow —
and the four an attacker with product-editor access would reach for.

`productSensitiveChangePolicy` is what makes the split real: without it, a product editor changes a
fee through the same endpoint they change a description through, and the separate permission exists
only in the catalog.

## Maker-checker

The approval **models** are `@trustsystem/workflow-approvals`' — six of them, all pure functions of
the decision trail. This layer does not restate any of them.

Progress is **derived** from the decisions, never tracked alongside them. A counter that increments
per approval is the design that produces "the record says two of three and only one decision
exists". Recomputing from the trail means the trail is the truth, and the trail is what an auditor
reads.

Two refusals live in `recordDecision` because they need the decision list:

**The maker cannot decide.** Checked against the recorded author, which the registry captured from
the actor at creation — never against a submitter field in a request.

**Nobody decides twice.** Without this, a two-of-three requirement is satisfiable by one person
clicking twice, which passes every count-based check because the count is right.

**A rejection settles it**, regardless of how many approvals preceded it. "Three approved and one
refused" is not a product that ships, and a model that let approvals outvote a refusal would make
the compliance officer's veto a suggestion. A rejection also requires a reason of at least ten
characters — "No" sends the product owner back to guess, and they guess wrong and resubmit, which
is how a two-day review becomes a two-week one.

## Separation of duties

Seven policies, on the phase 4 authorization engine. **Every one can only refuse** — none returns
`allow` — so the set inherits default-deny and adding one can only make the system stricter.

| Policy                  | Refuses                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `self-approval`         | The author, or the submitter, deciding their own version                    |
| `self-publication`      | The author publishing; a sole approver publishing their own single approval |
| `duplicate-decision`    | A second decision from an actor who already decided                         |
| `sensitive-change`      | A fee, limit, provider or rule change travelling as a generic edit          |
| `immutability`          | An edit to a product past the editable states                               |
| `execution-environment` | A non-active product executing in production                                |
| `provider-substitution` | Binding a connector the tenant has not approved                             |

Build the resource with `productResource()`. **A policy that cannot find its field abstains**, and
an abstaining separation-of-duty policy is a control that silently does not run — which is worse
than not having written it, because the runbook says it is there.

The registry enforces the same rules independently. That duplication is deliberate: the registry
covers the registry, and the policies cover the endpoint somebody adds next year.

## Governance health

`assessGovernance` answers what a schema cannot: whether the governance is **current**. A product
with a review date eighteen months in the past has every field populated and none of them
meaningful, and the schema is perfectly happy.

| Finding                                    | Severity                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Review date passed                         | `overdue`, or `breach` past 90 days                                                                   |
| Review due within 30 days                  | `due_soon` — still healthy                                                                            |
| Review interval over a year                | `overdue`. A product reviewed less often than annually has a risk assessment that predates its volume |
| Fewer distinct owners than owner roles     | `due_soon`. A staffing fact, not a failure — but one that has to be said                              |
| A `restricted` product exposed over an API | `breach`. The classification says a named recipient; an API says anybody with a credential            |
| A lending product audited as `standard`    | `overdue`. Somebody will be asked to reconstruct why an application was declined                      |
| Retention under a year                     | `overdue`. Shorter than the window in which most disputes arrive                                      |

`assertGovernanceHealthy` refuses activation on anything `overdue` or `breach`.

## The audit trail

Two lists, and the split matters more than either list.

**Audit** is what a customer or a regulator must be able to reconstruct: who changed the fee, who
approved the product, who rolled it back. **Events** are what other systems react to.

The specification names sixteen auditable actions; the catalog has those plus the runtime's,
because a governance trail that records every product change and no execution refusal answers
"who changed the limit" and not "why was this transaction declined" — and the second is the
question a customer asks.

Actions are **specific**. A fee change is `financial.product.fee.changed`, not `edited`. An
auditor searching for every fee change would otherwise have to read every edit record and diff it,
and they will not — they will search for an action name that does not exist and conclude nothing
changed.

`auditGovernanceAction` writes the record in the same call as the state change. A caller who wrote
one and forgot the other produces a complete history and an audit trail with a hole in it,
discovered during an audit rather than in a test.

## Seeding roles

`SEGREGATED_PERMISSION_PAIRS` is exported as data so a deployment can **assert** the separation
rather than describe it in a runbook:

```ts
const violations = segregationViolations(role.permissions);
// [['financial.product.create', 'financial.product.approve']] -> refuse the role
```

A role holding both `create` and `approve` is a maker-checker configuration that passes every test
and controls nothing, and the only way anybody notices is a check like this one running over the
seeded roles.

A workable starting split:

| Role                | Holds                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Product owner       | `read`, `create`, `update`, `validate`, `sandbox`, `submit`, `simulate`, `variant.manage` |
| Product engineer    | `read`, `update`, `validate`, `sandbox`, `provider.update`                                |
| Risk reviewer       | `read`, `approve`, `limit.update`                                                         |
| Compliance reviewer | `read`, `approve`                                                                         |
| Finance reviewer    | `read`, `approve`, `fee.update`                                                           |
| Release manager     | `read`, `publish`, `rollback`, `deprecate`, `retire`                                      |
| On-call operator    | `read`, `pause`                                                                           |
| Auditor             | `read`, `execution.read`                                                                  |

Note that no role holds both `submit` and `approve`, none holds both `approve` and `publish`, and
`pause` is held by whoever is on call rather than by whoever can publish — because pausing during
an incident must not wait for a release manager to be found.

# Framework reuse report

The critical document of the pilot. For every capability the application needed: what TrustOS
provided, what the pilot wrote, and whether anything was duplicated.

## Summary

|                                                 |                                   |
| ----------------------------------------------- | --------------------------------- |
| Framework reuse, payment path                   | **85.6%**                         |
| Framework reuse, including the configured layer | **96.8%**                         |
| Application-specific code                       | **1,585 lines** across five files |
| Duplicated framework capability                 | **none found**                    |

Both percentages are computed by [`scripts/pilot-reuse.mjs`](../../scripts/pilot-reuse.mjs) from
the repository and written to [`evidence/framework-reuse.json`](evidence/framework-reuse.json).
Neither is an estimate.

**Why two numbers.** The first counts the transitive closure of packages the pilot's _runtime code_
imports — the payment path, and the honest figure for "how much of accepting a payment did the
framework do". The second adds the packages the pilot _configures and exercises_ but does not
import at runtime: the enterprise governance layer, the product runtime, the API gate. Reporting
only the second would overstate; reporting only the first would omit the layer that carries most of
the governance.

## Capability by capability

| Capability            | Reused TrustOS module                                   | New pilot code                               | Duplicated?               |
| --------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| Authentication        | `@trustos/identity`                                     | None                                         | No                        |
| Authorization         | `@trustos/authorization`                                | None                                         | No                        |
| Permissions and roles | `@trustos/rbac`                                         | 19 permission keys, one role map (192 lines) | No                        |
| Tenant isolation      | `@trustos/tenancy`                                      | None — `organizationId` on every record      | No                        |
| Audit                 | `@trustos/audit`                                        | None — six action names                      | No                        |
| Accounts              | `@trustos/accounts`                                     | None                                         | No                        |
| Ledger                | `@trustos/ledger`                                       | None — three entries per journal             | No                        |
| Wallet                | `@trustos/wallet`                                       | None                                         | No                        |
| Money arithmetic      | `@trustos/financial-core`                               | None                                         | No                        |
| Fees                  | `@trustos/fees`                                         | One fee schedule (configuration)             | No                        |
| Limits                | `@trustos/limits`                                       | Two limits (configuration)                   | No                        |
| Idempotency           | Payment reference + `@trustos/ledger` key               | The keying decision (12 lines)               | No                        |
| Product definition    | `@trustos/financial-product-composer` template          | None — used as generated                     | No                        |
| Product runtime       | `@trustos/financial-product-runtime`                    | None                                         | No                        |
| Sandbox               | `@trustos/financial-product-sandbox`                    | Eight scenario assertions                    | No                        |
| Simulation            | `@trustos/financial-product-simulator`                  | One scenario mix                             | No                        |
| Maker-checker         | Domain state machine + `@trustos/audit`                 | 387 lines                                    | **Partially — see below** |
| Merchant model        | —                                                       | 282 lines                                    | No — application domain   |
| Payment flow          | Orchestrates the above                                  | 482 lines                                    | No — application domain   |
| Data classification   | `@trustos/data-classification`, `@trustos/data-catalog` | Six catalog entries                          | No                        |
| Policy                | `@trustos/policy-engine` and its three                  | One policy document                          | No                        |
| API catalog and gate  | `@trustos/api-management` and its seven                 | One API definition, one consumer             | No                        |
| Objectives            | `@trustos/sli`, `@trustos/slo`, `@trustos/sre-core`     | One indicator, one objective, one service    | No                        |
| AI assistance         | `@trustos/governance-ai-bridge`                         | None — used as provided                      | No                        |
| Errors                | `@trustos/errors`                                       | None                                         | No                        |
| Configuration         | `@trustos/config`                                       | None                                         | No                        |
| Logging               | `@trustos/logging`                                      | None                                         | No                        |

## The one partial

**Maker-checker.** `@trustos/workflow-approvals` provides `evaluateApproval`,
`checkApproverEligibility` and `assertApproverEligible` — a complete approval model with quorum,
delegation and eligibility rules. The pilot did not use it, and wrote 387 lines that overlap it.

That was a deliberate decision and it is worth writing down as a finding, because a future
application will face the same choice.

The workflow package models approvals as _tasks in a workflow instance_: a request enters a
workflow, tasks are created, approvers act on tasks, and the workflow advances. That is the right
model when the approval is a step in a longer process. The pilot's merchant approval is not — it is
a transition on a record, checked wherever the transition is attempted, including from a migration
script that has no workflow.

`assertApprovable` in `domain/merchant.ts` is 15 of those 387 lines. The rest is the merchant state
machine, the rejection model with rework, and the limit change request — none of which the workflow
package provides.

**What should change:** the framework should offer the _eligibility check_ separately from the
workflow that usually carries it. `checkApproverEligibility` already takes plain arguments and
returns a verdict; it is exported, and the pilot did not find it because it is inside a package
named for workflows. This is a documentation and discoverability finding rather than a missing
capability.

## What the pilot did not have to build

Listed because the absence is the result. Each of these is a system an application team building on
a thinner framework would have written, and each is a system that goes wrong in ways that are
expensive to discover later.

- **A ledger.** Double-entry, balanced, immutable, with reversal and adjustment rather than update.
- **Money arithmetic.** No float appears anywhere on the payment path; amounts are strings and
  minor units, and `@trustos/financial-core` does the arithmetic.
- **A limit engine** with reservation rather than checking, calendar windows with timezones, and
  idempotent consumption.
- **A fee engine** with tiers, floors, ceilings, rounding modes and versioned schedules.
- **An audit trail** that is append-only, tenant-scoped and redacted.
- **A permission model.** The pilot added keys; it added no checking.
- **Tenant isolation.** Every framework signature takes `organizationId` explicitly, which is why
  the pilot's isolation tests are assertions rather than implementations.
- **An idempotency layer.** The pilot chose the _key_; the mechanism is the ledger's.
- **A product sandbox and simulator**, which produced the pilot's own evidence.

## What the pilot did build, and why each was necessary

**The merchant model (282 lines).** Five entities and six roles. No framework should provide these:
a merchant, a store and a branch are the pilot's domain, and a framework that shipped them would be
a framework with an opinion about what a merchant is.

The decision worth recording: **a merchant is not a tenant.** Making it one reads as the natural
mapping and means every framework package that scopes by `organizationId` scopes by the wrong
thing — every isolation test in the framework would still pass while the application leaked across
merchants inside one organization.

**Onboarding (387 lines).** Discussed above.

**The payment flow (482 lines).** The sequence, and the four decisions inside it — consume the
limit rather than check it, post one journal rather than two, post last, key idempotency on the
merchant's own reference. Those are product decisions, and 482 lines to make them explicit is the
right size.

**Permissions (192 lines).** Nineteen keys and a role map. Roughly the irreducible
application-specific part of a payment product.

**The assembly (237 lines).** Nine framework services, two domain classes, two pieces of
configuration. This file is the most direct answer to the pilot's question: if accepting a payment
on TrustOS needs 237 lines of wiring, the framework carries the weight.

## Duplicated code found

None.

The check is not a search for copied text — it is a search for a _capability_ the pilot implemented
that the framework already provides. `npx trustos architecture-check` enforces declared
dependencies and no deep imports, and passes across all 973 files. The overlap with
`@trustos/workflow-approvals` is described above and is not duplication of an available API: the
15 lines that overlap it are a different shape from the one the package offers.

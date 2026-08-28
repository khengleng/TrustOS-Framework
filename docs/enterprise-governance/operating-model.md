# Operating model

Who does what, and why the splits are where they are.

The technical controls in this layer only work if the roles behind them exist. A segregation rule
that separates a proposer from an approver does nothing when one person holds both roles, and that
is the normal state of a small team unless somebody decides otherwise.

So this page is about people. It is a starting point a deployment adapts, not a prescription.

## The roles

| Role                | Holds                                                      | Never holds                              |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| **Data steward**    | Catalog entries, classification proposals, retention rules | Classification approval                  |
| **Data governance** | Classification approval, reveal approval, access reviews   | Classification proposals                 |
| **Policy author**   | Draft policies, simulation                                 | Policy activation                        |
| **Policy owner**    | Policy activation                                          | Authorship of the policy being activated |
| **Service owner**   | Service registration, objectives, incident declaration     | DR activation                            |
| **Platform lead**   | DR activation, production experiment approval              | Running the experiment they approved     |
| **API owner**       | API drafts, versions, migration plans                      | Publishing their own API into production |
| **API governance**  | Publication approval, entitlement grants                   | API authorship                           |

The right-hand column is the load-bearing one. Each entry is a specific thing that person must not
be able to do, and each is enforced somewhere in the code rather than in this table.

## Why each split exists

**Classification: propose ≠ approve.** Lowering a classification makes previously-restricted data
readable, and every downstream control — masking, export, reveal, retention — reads the label. A
steward who could lower a classification could read anything by relabelling it first.

**Policy: author ≠ activate.** A policy is a rule that governs everybody else. One person writing
and enacting it is unreviewed rule-making. `PolicyController.activate` refuses when the actor is
the policy's own owner, which is a second check beyond the permission split — the split alone would
not stop somebody who legitimately holds both roles over different policy sets.

**API: own ≠ publish into production.** Publishing an API creates a contract with callers who did
not consent to it, and withdrawing it later is expensive. `ApiCatalog.transition` refuses when the
actor is either owner, and the check lives in the catalog rather than in a controller so it holds
for the CLI too. A control that exists in one controller is a control with a bypass.

**Experiments: run ≠ approve.** A production fault injection is a deliberate outage of a bounded
size. One person deciding both that it should happen and that it is safe is one person deciding to
break production.

**Reveal: request ≠ approve.** A role holding both can read any restricted value with nobody else
involved. This is the pair that most often gets collapsed by accident, because both permissions
sound like "handle sensitive support cases".

## The cadence

Governance work that has no schedule does not happen. These are defaults; the framework reads
several of them from configuration and reports overdue items rather than enforcing a calendar.

| What                        | How often                            | Enforced by                                      |
| --------------------------- | ------------------------------------ | ------------------------------------------------ |
| Catalog review              | Per classification, 90–365 days      | `DataCatalog.overdueReviews`                     |
| Access grant review         | 90 days, or the grant lapses         | `lapsingGrants` in `@trustos/data-access-policy` |
| Policy review               | Per policy `reviewDate`              | `PolicyRegistry.overdueReviews`                  |
| Consumer review             | 180 days                             | `reviewConsumer`                                 |
| Runbook review              | 180 days                             | `reviewProcedures`                               |
| Restore test                | Per source; 90 days for the database | `BackupInventory.analyse`                        |
| DR exercise                 | 180 days                             | `reviewPlans`                                    |
| Incident corrective actions | Per action due date                  | `overdueActions`                                 |

Access grants are the one that expires rather than merely being reported. Everything else surfaces
as a finding, because a policy that stopped working because nobody reviewed it would be an outage
caused by governance — and after the first one, the review interval gets set to ten years.

## What happens when something is found

`trustos enterprise doctor` over the deployment's governance documents is the check to run before a
review. It reports findings by severity and — importantly — reports what it could not check.

A high-severity finding is not an incident. It is a conversation with the owner named on the
record, which is why every record in this layer has an owner and why several schemas refuse
without one.

## Two things this model does not do

**It does not automate remediation.** Nothing here reclassifies data, revokes a grant, retires an
API or activates a plan on a schedule. Every one of those is a person acting under a permission,
after reading a finding. Automation would be faster and would eventually remove access somebody
needed at a moment nobody was watching.

**It does not let AI act.** The governance assistant explains, summarizes, drafts and suggests.
`AI_FORBIDDEN_ACTIONS` in `@trustos/governance-ai-bridge` names what it may never do, and the
constraint is structural rather than a rule: the output type carries text, and there is no path
from an output to an action.

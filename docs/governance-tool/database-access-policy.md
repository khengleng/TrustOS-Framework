# Database access policy

The three classes, what falls in each, and how each is enforced.

An internal application builder is, structurally, a way to run queries against production. The
way that goes wrong is never dramatic: somebody builds a console that reads a table directly
because the API was slow, it works, and eighteen months later the console is _writing_ to that
table because reading it was already allowed.

## Class A — approved read-only

Analytics replicas, reporting databases, read-only views, aggregates, reference data.

Reached with **dedicated read-only credentials**. Fast, cheap, and incapable of changing
anything — which is the enforcement, not a policy statement. `decideAccess` refuses a mutation
against Class A, and the credential could not perform one if it got through.

Registration refuses a Class A resource that _declares_ a mutation, so the deeper check is
unreachable through the normal path. It exists anyway, because "unreachable" is a property of
today's registration schema.

## Class B — API only

Everything authoritative:

payments · wallets · the ledger · settlement · reconciliation resolution · loans · customer
records · product configuration · workflow decisions · role changes · security configuration ·
API key management

Reads may be direct where a resource is registered for it. **Every mutation goes through a
TrustOS API**, so that authorization, workflow, maker-checker and audit all run. A direct write
skips all four and nothing errors.

Enforced twice: `DataAccessGuard.planMutation` for the runtime, and `assertApiOnlyMutation`
exported separately for a deployment's own executor — the code somebody writes next year that
does not go through the runtime.

## Class C — forbidden

passwords · password hashes · tokens · refresh tokens · encryption keys · API secrets · provider
credentials · private keys · MFA seeds

**Never exposed, under any permission, in any environment, to anybody.** Not "restricted" —
there is no permission that grants them, no reveal that surfaces them and no export that includes
them. A class that could be unlocked is a class somebody unlocks during an incident.

Enforced by name matching on the normalized field, at three points:

1. **Registration.** A resource declaring a credential-shaped column is refused.
2. **Read planning.** The projection is checked again, because "should never fire" and "does not
   fire" differ by one upstream schema change.
3. **The console templates.** A test asserts none of the ten exposes one.

### Over-matching is deliberate

`token_bucket_refill` is not a credential and is caught anyway. The cost of a false positive is a
declaration that names an exception, reviewed by a person; the cost of a false negative is a
refresh token in a CSV.

The exception is narrow: an **exact field name**, listed on the declaration.

```json
{ "fields": ["period", "requests", "inputTokens"], "fieldExceptions": ["inputTokens"] }
```

There is no wildcard, because a wildcard is used once during an incident and never removed.

## The resource registry

Every reachable thing is registered, per environment:

| Field                           | Why                                                                   |
| ------------------------------- | --------------------------------------------------------------------- |
| `accessClass`                   | Which of the three above                                              |
| `credentialRef`                 | A _reference_. Nothing here has a field a secret could be pasted into |
| `allowedGroups`                 | Empty means nobody, never everybody                                   |
| `permittedOperations`           | Narrows the class; never widens it                                    |
| `exposedFields`                 | Checked for Class C at registration                                   |
| `approvalStatus` + `approvedBy` | Production needs an approver who is not the registrant                |
| `nextReviewDate`                | `overdueReviews` is what a governance review opens with               |

`reporting.transactions` in DEV and in PROD are **two entries with two credential references**.
Conflating them is how a console promoted to production keeps reading the development replica —
or, in the direction that matters, how a development console reaches production data.

## What a reviewer sees

`summarizeAccess` derives, from the definition, every resource an application reaches, its class,
whether the app mutates it, and anything unregistered. Derived rather than described by the
author, because an author describing their own access describes what they remember.

```
reads:      reporting.transactions (read_only), reporting.exceptions (read_only)
mutations:  trustos.case  execute  /internal/v1/operations/cases
unregistered: —
```

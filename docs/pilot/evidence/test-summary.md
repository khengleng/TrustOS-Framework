# Test summary

153 tests across 6 files, all passing. Produced by:

```bash
npx vitest run apps/merchant-wallet-basic
```

Repository at `e899888`. Node v20.19.1, Apple M4 Pro, 12 cores.

| File                             | Tests | Covers                                                                                   |
| -------------------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `pilot.spec.ts`                  | 41    | Onboarding, wallet, payment, fee, idempotency, limits, refusals, isolation, limit change |
| `security.spec.ts`               | 34    | The mandatory negative suite                                                             |
| `governance.spec.ts`             | 35    | Classification, policy, API management, SRE, objectives, AI                              |
| `sandbox-and-simulation.spec.ts` | 19    | The eight scenarios and three simulation volumes                                         |
| `console-and-studio.spec.ts`     | 19    | The operations console and the Product Studio                                            |
| `performance.spec.ts`            | 5     | Three concurrency levels, measured                                                       |

Every test below asserts something the pilot specification asks for. A test that asserted the
framework's own behaviour would belong in the framework's suite, and several early drafts of these
were moved there or deleted for that reason.

---

### data governance

`governance.spec.ts` — 7 tests

- ✓ classifies the six entities the specification names
- ✓ masks the merchant profile and the wallet by default
- ✓ requires a second person to reveal a wallet balance and refuses to export the ledger
- ✓ keeps the ledger out of AI inputs
- ✓ narrows an unauthorized catalog search to a stub
- ✓ finds nothing misclassified
- ✓ would catch the wallet classified below the ledger it derives from

### policy-as-code

`governance.spec.ts` — 7 tests

- ✓ passes its own tests
- ✓ allows a verified merchant approved by a second person
- ✓ denies the verifier approving their own work
- ✓ defaults to deny
- ✓ records both the allow and the deny
- ✓ refuses to enforce a draft
- ✓ records the policy version, so the decision can be re-derived

### API management

`governance.spec.ts` — 8 tests

- ✓ registers the pilot API with owners, classification and an objective
- ✓ admits an authorized consumer
- ✓ refuses an unauthorized consumer
- ✓ lets a write scope read, and not the reverse
- ✓ refuses above the rate limit
- ✓ refuses once the quota is used up
- ✓ refuses a version the consumer is not entitled to
- ✓ counts refusals in the analytics

### observability and objectives

`governance.spec.ts` — 7 tests

- ✓ registers the pilot service with an owner, a rotation and a runbook
- ✓ measures the objective against a window with enough traffic
- ✓ calculates the error budget from the same numbers
- ✓ recommends reversible actions rather than halting anything
- ✓ pages on a fast burn
- ✓ reports an unmeasured window as unmeasured rather than perfect
- ✓ names the indicator’s good and valid events, which is the part people argue about

### the merchant operations assistant

`governance.spec.ts` — 6 tests

- ✓ may not approve a merchant, change a limit, post a journal or execute a payment
- ✓ gets a case reference rather than the customer record
- ✓ requires a person before a drafted operations note is used
- ✓ does not require one to explain a transaction failure
- ✓ is never given the ledger
- ✓ classifies the assistant’s own inputs below the ledger

### authorization

`security.spec.ts` — 6 tests

- ✓ gives the auditor no write permission at all
- ✓ gives the cashier no settlement, ledger or limit access
- ✓ matches every role’s declared capability to what it actually holds
- ✓ lets no role hold both halves of a maker-checker pair
- ✓ would catch a role that was given both
- ✓ names three pairs

### self-approval

`security.spec.ts` — 3 tests

- ✓ refuses the verifier as the approver
- ✓ refuses the requester as the limit approver
- ✓ records who acted at each step, so the refusal is checkable afterwards

### cross-tenant access

`security.spec.ts` — 7 tests

- ✓ refuses a merchant read from another organization
- ✓ refuses a wallet read from another organization
- ✓ refuses a journal read from another organization
- ✓ does not let a platform-wide role cross an organization boundary
- ✓ lets a platform role see another merchant inside its own tenant
- ✓ does not let a merchant role see another merchant
- ✓ answers a cross-tenant read with not-found rather than forbidden

### IDOR

`security.spec.ts` — 2 tests

- ✓ does not accept a merchant id alone as authorization
- ✓ does not let a payment name a merchant in another tenant

### duplicate transactions

`security.spec.ts` — 3 tests

- ✓ does not charge twice for a repeated reference
- ✓ does not let concurrent duplicates both execute
- ✓ does not let a different tenant replay another’s reference

### ledger integrity

`security.spec.ts` — 4 tests

- ✓ offers no way to update a posted journal
- ✓ refuses an unbalanced journal
- ✓ posts no journal for a refused payment
- ✓ keeps the wallet balance equal to what the journals say

### audit

`security.spec.ts` — 4 tests

- ✓ records every consequential action
- ✓ carries the correlation id into the audit record
- ✓ scopes every record to its organization
- ✓ offers no way to delete an audit record through the service

### sensitive data

`security.spec.ts` — 2 tests

- ✓ puts no amount or balance in a merchant record
- ✓ does not put payment amounts in the merchant audit metadata

### credential scope

`security.spec.ts` — 2 tests

- ✓ does not let a read scope satisfy a write requirement
- ✓ does not let a scope on one resource reach another

### the boundary of these tests

`security.spec.ts` — 1 tests

- ✓ does not test transport security, which is the deployment’s

### merchant onboarding is maker-checker

`pilot.spec.ts` — 7 tests

- ✓ onboards through three distinct people
- ✓ refuses an approver who verified the same merchant
- ✓ refuses an approver who registered the merchant
- ✓ cannot approve a merchant nobody verified
- ✓ requires a rejection to say why, and whether they may come back
- ✓ supports rework by naming what to fix
- ✓ audits every step

### the wallet is ledger-backed

`pilot.spec.ts` — 4 tests

- ✓ opens on approval, not at registration
- ✓ derives the balance from the ledger rather than storing it
- ✓ refuses a payment into a frozen wallet
- ✓ accepts again once unfrozen

### accepting a payment

`pilot.spec.ts` — 6 tests

- ✓ posts one balanced journal
- ✓ charges 0.50%
- ✓ applies the minimum fee
- ✓ applies the maximum fee
- ✓ takes the fee from configuration rather than from code
- ✓ never floats the money

### idempotency

`pilot.spec.ts` — 3 tests

- ✓ replays a repeated reference rather than charging twice
- ✓ does not consume the limit twice on a replay
- ✓ treats a different reference as a different payment

### limits

`pilot.spec.ts` — 5 tests

- ✓ accepts below the per-transaction limit
- ✓ accepts exactly at the limit
- ✓ refuses above the limit
- ✓ accumulates against the daily limit
- ✓ reads the limits from configuration

### the refusal paths

`pilot.spec.ts` — 6 tests

- ✓ refuses an unapproved merchant
- ✓ refuses a merchant in another organization
- ✓ refuses a currency the merchant does not transact in
- ✓ refuses when the mock risk rule refuses
- ✓ refuses when the mock provider does not respond
- ✓ names its refusals distinctly

### tenant isolation

`pilot.spec.ts` — 5 tests

- ✓ does not return another organization’s merchant
- ✓ does not list another organization’s merchants
- ✓ does not return another organization’s wallet
- ✓ does not return another organization’s journal
- ✓ does not let one organization’s payment reference collide with another’s

### a limit change is a request

`pilot.spec.ts` — 5 tests

- ✓ changes nothing until it is approved
- ✓ refuses the requester as the approver
- ✓ approves with a second person
- ✓ refuses to decide a request twice
- ✓ does not reach another organization’s request

### the Merchant Operations Console

`console-and-studio.spec.ts` — 10 tests

- ✓ validates as an internal application
- ✓ shows the nine things the specification asks for
- ✓ offers the five controlled actions
- ✓ calls an API for every action, and mutates nothing directly
- ✓ reads every authoritative source through the API rather than a replica
- ✓ requires approval for the two irreversible actions
- ✓ requires a reason for every action
- ✓ declares only AI features that summarize or explain
- ✓ is classified restricted and high risk
- ✓ starts as a draft in dev, not live in production

### the Financial Product Studio

`console-and-studio.spec.ts` — 9 tests

- ✓ shows the product definition with its eleven blocks
- ✓ shows the blocks resolving against the approved catalog
- ✓ validates, with the unbound providers reported as warnings
- ✓ shows the fee and limit configuration on the definition
- ✓ publishes a version with a content hash
- ✓ refuses a publication the author approved alone
- ✓ classifies a fee change and says which approvals it needs
- ✓ treats a first version as a change to everything
- ✓ reports the product’s governance health and its review date

### payment path performance

`performance.spec.ts` — 5 tests

- ✓ 10 concurrent merchants, 20 payments each
- ✓ 50 concurrent merchants, 20 payments each
- ✓ 100 concurrent merchants, 20 payments each
- ✓ does not degrade non-linearly with concurrency
- ✓ writes the measurements to the evidence pack

### the sandbox scenarios

`sandbox-and-simulation.spec.ts` — 10 tests

- ✓ 1. a successful payment completes every step
- ✓ 2. a limit refusal stops before the ledger
- ✓ 3. a frozen wallet refuses before the payment is taken
- ✓ 4. a risk rejection refuses
- ✓ 5. a duplicate request replays rather than executing again
- ✓ 6. a provider timeout fails the execution rather than crashing the process
- ✓ 7. a settlement failure leaves the ledger posting standing
- ✓ 8. a reconciliation mismatch is raised after the money has moved
- ✓ reports a scenario that was armed and never fired
- ✓ touches no production data, structurally

### simulation at three volumes

`sandbox-and-simulation.spec.ts` — 9 tests

- ✓ 100 transactions
- ✓ 1,000 transactions
- ✓ 100,000 transactions
- ✓ refuses more as consumption accumulates, which is the daily limit working
- ✓ refuses the injected scenarios rather than succeeding through them
- ✓ prevents the injected duplicates
- ✓ posts a journal for every success and none for a refusal
- ✓ carries its caveats into the report
- ✓ writes what was measured to the evidence pack

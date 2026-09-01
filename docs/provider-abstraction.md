# Provider abstraction

Why a product never names a bank, how a connector binds an interface to something outside, and
what a deployment has to supply.

- [The rule](#the-rule)
- [The seven interfaces](#the-seven-interfaces)
- [What a connector is](#what-a-connector-is)
- [What a connector is not](#what-a-connector-is-not)
- [Binding a connector](#binding-a-connector)
- [Fallback and substitution](#fallback-and-substitution)
- [Adding an adapter](#adding-an-adapter)

---

## The rule

A product workflow calls:

```ts
PaymentProvider.execute();
```

never:

```ts
ABA.execute();
```

A block declares that it needs a `PaymentProvider`. A connector says that some external system
implements `PaymentProvider.execute`. Nothing in a product definition names a vendor, and the
test suite fails on the word.

The consequence is the point of the layer: **swapping the rail underneath is a connector change**,
reviewed by security and operations, and the product's approved definition does not move. Nobody
re-reviews the fee schedule because the bank changed.

## The seven interfaces

| Interface              | Operations                                          | What it does                                                    |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `PaymentProvider`      | authorize, execute, capture, refund, cancel, status | Moves money over an external rail                               |
| `IdentityProvider`     | authenticate, challenge, verify, revoke             | Proves who somebody is                                          |
| `KycProvider`          | submit, status, level                               | Resolves a verification level. Returns a level, never documents |
| `RiskProvider`         | screen, score, decision, feedback                   | AML, sanctions, PEP, fraud, device                              |
| `SettlementProvider`   | instruct, status, statement, cancel                 | Instructs and reports on settlement                             |
| `NotificationProvider` | send, status                                        | Delivers a message                                              |
| `CreditProvider`       | assess, status, report                              | Where a credit decision comes from outside                      |

**The operation lists are closed.** That is the part that does the work. An open interface would
let a connector declare `PaymentProvider.doAnythingWeNeed`, and within a year the products would be
calling vendor-shaped operations through a vendor-neutral name — the same coupling wearing a
disguise.

Adding an interface or an operation is a change to `connector-registry` and a separate review. It
should be rare: seven interfaces have covered every block in an 84-block catalog.

## What a connector is

**Metadata about a binding.** It says that some external system implements an interface operation,
what it takes, what it returns, how long to wait, and what to do when it does not answer.

```ts
{
  connectorId: 'settlement-rail-primary',
  name: 'Primary settlement rail',
  description: 'Instructs settlement to the primary counterparty.',
  version: '1.0.0',

  providerInterface: 'SettlementProvider',
  operation: 'instruct',

  inputs: [...], outputs: [...],

  authentication: 'mutual_tls',
  timeoutMs: 15_000,
  idempotent: true,
  retry: { maxAttempts: 3, strategy: 'exponential', jitter: 'full' },

  health: 'healthy', healthCheckedAt: '2026-06-01T09:00:00.000Z',
  dataClassification: 'confidential',
  lifecycleStatus: 'approved',
  technicalOwner: 'usr_integrations',
}
```

Connectors are **tenant-scoped**. Two organizations on one platform integrate with different
counterparties, and a registry that returned every organization's connectors would let one
tenant's product bind to another's integration.

Three refusals in the schema, each describing a real way an integration goes wrong:

**An operation the interface does not offer.** Closed lists, checked at registration.

**A retry policy on a non-idempotent operation.** Retrying a capture that is not idempotent
captures twice. The policy has to be declared as absent rather than left off, so the decision is
visible in review.

**Anything shaped like a URL.** A connector carries no endpoint — see below.

Plus: an unauthenticated connector may only carry public data. Anything else is an integration
anybody who can reach the network can call.

## What a connector is not

**It is not the adapter.** The code that makes the call belongs to a deployment and is reached
through `@trustsystem/adapter-framework`, which already owns the retry, the circuit breaker, the
health check and the error translation. A second one here would be a second set of defaults.

**It carries no endpoint.** The schema refuses anything URL-shaped in the id, the name or the
description. A URL in a product-layer artefact is an environment leaking into an approved
document — the staging URL ships to production, and it _works_, because staging answers.

**It carries no credential.** Nothing in the connector schema has a field for one, and nothing
should gain one. Credentials live in a deployment's secret store and are read by the adapter.

**Its `health` is stale by construction.** It is a cached observation, not a live probe. A product
that routed on it without a fallback would route on a fact that was true a minute ago.

## Binding a connector

A product declares its provider requirements and binds a connector to each:

```json
{
  "providers": [
    {
      "providerInterface": "PaymentProvider",
      "required": true,
      "connectorId": "payment-rail-primary",
      "fallbackConnectorIds": []
    }
  ]
}
```

A block may override the binding for itself with its own `connectorId` — which is how one product
uses a different rail for refunds than for captures.

**Validation severity is contextual.** With no connector registry supplied, an unbound interface is
a _warning_: a template deliberately binds nothing, and validating one in the abstract has no way
to know which connectors exist. Publication supplies a registry, and then it is an _error_.

## Fallback and substitution

`fallbackConnectorIds` is a list, in order, and an **empty list is a legitimate answer**. A
product that quietly reroutes to a second provider is a product whose settlement lands somewhere
the operator did not expect, and the reconciliation is against the wrong statement.

Where a fallback is wanted, it is declared, versioned and approved with the rest of the product.

**Provider substitution is on the threat list.** It is the quiet one: the product still works, the
transactions still complete, and the money goes somewhere nobody reviewed. Two enforcement points
cover it:

- `productProviderSubstitutionPolicy` refuses a change binding a connector the tenant has not
  approved, on every route that declares a product action.
- The runtime's `requireBindable` refuses at execution, so a definition that somehow carried an
  unapproved connector fails at the block rather than calling it.

A rule may select a connector with `select_provider`, and it may only select one the tenant has
approved — the same check applies.

## Adding an adapter

The framework ships **no adapter and no connector**. `FRAMEWORK_CONNECTORS` is a frozen empty
array, and `assertNoFrameworkProvider` refuses a connector in this repository that names one of the
vendors this phase stays away from.

That guard applies to the _framework's_ catalog. A deployment's connectors should and must name
their providers — that is what a connector is for.

To add one:

1. **Write the adapter** in the deployment, implementing `@trustsystem/provider-sdk`'s `Provider`
   contract, and register it with `@trustsystem/adapter-framework`. It owns authentication, mapping,
   timeout, retry, the circuit breaker, health and error translation.
2. **Register the connector metadata** in that deployment's `ConnectorRegistry`, scoped to the
   organization. Name the interface and the operation; do not name a URL.
3. **Approve it.** A connector's lifecycle status is `draft` until somebody with
   `financial.connector.manage` approves it, and a draft connector cannot be bound into a product.
4. **Bind it** in the product definition, which is a `financial.product.provider.update` change
   and needs security and operations approval — see
   [product-governance.md](product-governance.md).
5. **Validate:** `npx trustos connector validate connectors.json`.

### Where a Bakong or a bank adapter would go

The specification asks that these be listed as extension points, so plainly:

| Step                              | Where                                                                      |
| --------------------------------- | -------------------------------------------------------------------------- |
| The HTTP client, auth and mapping | A deployment package implementing `@trustsystem/provider-sdk`              |
| Retry, breaker, health            | Already in `@trustsystem/adapter-framework`. Do not write a second one     |
| The connector record              | The deployment's `ConnectorRegistry`, tenant-scoped                        |
| The product binding               | `providers[].connectorId` in the definition, approved as a provider change |
| The block                         | None. `payment.execute` already exists and is what the product calls       |

The last row is the whole design: **adding a bank adds no block and changes no product graph.**
If it does, the abstraction has failed and the fix is in the interface, not in the product.

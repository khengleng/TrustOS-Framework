# API integration

How an internal application reaches a TrustOS API, and why it cannot reach anything else.

## The catalog, not a client

`@trustos/governance-tool-integration` is a **catalog**: every gateway path that exists, the
TrustOS resource it touches, the kind of operation it is, and the API permission it needs.

A catalog rather than a set of functions because the gateway has to answer, for a request it has
never seen: _is this path a real operation, and which resource does it touch?_ A set of functions
cannot be asked that.

```ts
requireOperation('POST', '/internal/v1/finance/adjustments/requests');
// -> { operationId: 'requestAdjustment', resourceId: 'trustos.ledger',
//      apiPermission: 'financial.adjustment.request', createsRecord: true }
```

An undeclared path is refused: nobody mapped it to a resource, so nothing classified it, and the
access-class check has nothing to check.

## The eight namespaces

```
/internal/v1/operations/*    retry · escalate · approve · reject · return · reassign · cases
/internal/v1/support/*       cases · notes · freeze *requests* · reveals
/internal/v1/finance/*       adjustment *requests* · reconciliation resolution · exports
/internal/v1/risk/*          case assignment · escalation · decisions · reveals
/internal/v1/compliance/*    (served by the risk namespace's case and decision operations)
/internal/v1/security/*      (served by the platform namespace)
/internal/v1/products/*      drafts · validate · sandbox · simulate · submit
/internal/v1/ai/*            review decisions
/internal/v1/platform/*      role-change *requests* · API key revocation · exports
```

Read the emphasis. **Freeze requests. Adjustment requests. Role-change requests.** The console
asks; TrustOS decides, through maker-checker.

## What the catalog does not contain

| Absent                              | Why                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `publishProduct`, `activateProduct` | The Studio composes and submits. Publishing from a low-code console is what this layer exists not to be |
| Any `/journals` or `/postings` path | Direct ledger posting from a console is prohibited. `requestAdjustment` replaces it                     |
| Any API-key reveal                  | `@trustos/api-keys` stores a prefix and a hash; there is nothing to reveal                              |
| Any business logic                  | Every entry is a mapping. A helper computing a fee would be a second implementation of the fee          |

Tests assert each of these absences, and a further one asserts that **every path the ten console
templates declare exists in the catalog** — a console calling something that does not exist is
better found at review than at 3am.

## Path matching

Segment by segment, with a declared `:param` matching exactly one concrete segment. Not a prefix
match: a prefix match sends `/internal/v1/operations/cases/../../platform/role-changes`
somewhere, and "somewhere" in a gateway ends badly. A segment of `..` never matches a parameter,
so a traversal is a lookup failure rather than a route.

## Forwarding

The framework ships **no forwarder**, and both applications say so at start-up.

When a deployment writes one, the rule is: **forward with the actor's own credential.** A gateway
that called downstream as itself would be a gateway through which everybody has the gateway's
permissions — and the TrustOS API would authorize correctly against the wrong identity, which is
the worst kind of correct.

Operations with `createsRecord: true` need an idempotency key, and the gateway surfaces
`requiresIdempotencyKey` so the forwarder cannot forget.

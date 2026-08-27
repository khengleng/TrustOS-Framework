# Consumers and the developer portal

## A consumer is not a credential

`@trustos/api-consumer` holds _who is allowed to call what_. Keys live in `@trustos/api-keys`.

A consumer outlives its credentials: keys rotate, expire and get revoked, and the entitlement —
this partner may read merchants in production — survives all of that.

Modelling entitlement on the key means the entitlement is re-granted at every rotation, usually by
copying whatever the old key had. That is how scopes accumulate and never shrink.

## An entitlement covers one major version

Minors and patches within it are included, because they are compatible by definition. The next
major is not.

An entitlement that followed "the newest version" would silently grant access to whatever the next
major adds — including operations nobody reviewed against this consumer.

## Kinds have ceilings

| Kind                    | Reaches at most   | Production |
| ----------------------- | ----------------- | ---------- |
| `internal_application`  | HIGHLY_RESTRICTED | yes        |
| `service_account`       | RESTRICTED        | yes        |
| `merchant`              | CONFIDENTIAL      | yes        |
| `partner`               | CONFIDENTIAL      | yes        |
| `external_organization` | INTERNAL          | yes        |
| `developer`             | PUBLIC            | **no**     |

A ceiling, not a grant. An entitlement above it is a `high` finding, and the point is that a
mistake in a single entitlement cannot hand an external caller restricted data — somebody would
have to change the _kind_, which is a visible decision rather than an edit to a scope list.

A developer consumer cannot reach production at all. The schema refuses it. A developer credential
is the least controlled thing in any estate — it lives in a laptop, a gist, a screenshot — and it
belongs on synthetic data.

## Refusals name themselves

```ts
decideAccess({ consumer, api, operation, at }).code;
// 'consumer_not_active' | 'no_entitlement' | 'entitlement_expired'
// | 'operation_not_entitled' | 'scope_not_granted' | 'wrong_environment' | 'version_retired'
```

A single "forbidden" is what makes integration support expensive: the integrator cannot tell
whether they need a scope, a new entitlement or a different version, so they ask, and somebody
reads logs.

## Entitlements expire

`expiresAt` is nullable, and a null is a `medium` finding. An entitlement that never expires is one
nobody revisits, and doing nothing should end access rather than extending it.

## What the portal shows

The default is invisible. An API becomes visible because something makes it so — being `PUBLIC` or
`INTERNAL`, or the viewer holding an entitlement — never because nothing hid it.

| Classification           | Listed | Documented | Requestable |
| ------------------------ | ------ | ---------- | ----------- |
| `PUBLIC`                 | yes    | yes        | yes         |
| `INTERNAL`               | yes    | no         | yes         |
| `CONFIDENTIAL` and above | **no** | no         | no          |
| entitled                 | yes    | yes        | —           |

**Listing and documenting are separate** because they leak differently. Listing says the API
exists; documenting names its fields, error codes and business rules.

**A restricted API is not listed at all.** Not a greyed-out row saying "contact us for access to
the Ledger API" — that row is most of the reconnaissance an attacker wanted, served by the
documentation site. The portal returns a 404 rather than a 403, because a 403 confirms the API is
real.

## Self-service ends at the sandbox

Registration produces a sandbox credential. `assertSandboxOnly` refuses anything else.

Production access is a **request**, decided by a named person, which creates a consumer through the
registry. Approving above the developer ceiling requires acknowledging the classification
explicitly — an approver working through a queue is the mechanism by which somebody ends up
entitled to restricted data, and the acknowledgement is what interrupts it.

## The portal never returns a key

Keys are hashed on creation and cannot be recovered. The portal shows a prefix from the key store
and says the key is not stored.

Where no key store is wired, it shows `unavailable` rather than deriving a prefix from the
credential id. A credential id is a reference, not the key, and treating the two as the same thing
is how an id that happened to be derived from a key ends up echoed back.

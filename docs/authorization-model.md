# Authorization model

Who may do what, to which record, in which organization — and why the answer was no.

- [Four layers](#four-layers)
- [The policy engine](#the-policy-engine)
- [The built-in policies](#the-built-in-policies)
- [Tenant isolation](#tenant-isolation)
- [Scopes](#scopes)
- [Decision records](#decision-records)
- [Writing a policy](#writing-a-policy)
- [Frontends are not authorities](#frontends-are-not-authorities)

---

## Four layers

RBAC alone answers "does this actor hold `merchant.update`". Real questions are
narrower: does this actor hold it _in this organization_, _for this record_, _with a
strong enough session_, _using a credential that permits writes_. So there are four
layers, each able only to refuse:

| Layer          | Question                          | Enforced by                             |
| -------------- | --------------------------------- | --------------------------------------- |
| Authentication | Who is calling?                   | `AuthenticationGuard`                   |
| Tenancy        | Whose data may they touch?        | `TenantGuard`, `tenantMembershipPolicy` |
| RBAC           | Do they hold the permission?      | `PermissionsGuard`                      |
| Policy         | Does the whole rule set allow it? | `PolicyAuthorizationGuard`              |

Adding a layer never grants access. That property is what makes the stack safe to
extend: a new policy can only make the system stricter.

## The policy engine

```ts
const decision = authorize(request, policies);
// { allowed, reason, matchedPolicy, decisionId, evaluated }
```

Four rules, and each one is load-bearing:

1. **Default deny.** No policy allows → denied. A policy that cannot form an opinion
   returns `null`, which is not an allow.
2. **Explicit deny wins, immediately.** The first denying policy short-circuits. A
   later allow cannot overturn it.
3. **First allow is recorded.** `matchedPolicy` names it, so "why was this allowed" has
   an answer too — the question an auditor asks more often than the other one.
4. **`authorize()` never throws.** A policy that throws is a bug, and a bug in a policy
   must not become a 500 that a caller can trigger deliberately. It is recorded as a
   deny.

Ordering matters, and only the _last_ policy in the built-in set can allow. Everything
before it can only refuse. That is what makes the set safe to add to: a new policy
inserted anywhere before `rbac.permission` cannot accidentally grant anything.

## The built-in policies

In evaluation order:

| Policy                      | Refuses when                                                 |
| --------------------------- | ------------------------------------------------------------ |
| `actor.authenticated`       | there is no actor                                            |
| `tenant.membership`         | the actor is not an active member of the target organization |
| `tenant.resource-ownership` | the resource belongs to a different organization             |
| `resource.not-deleted`      | the resource is soft-deleted                                 |
| `resource.status`           | the resource's status forbids the action                     |
| `actor.assurance`           | the action needs a stronger session than the actor has       |
| `actor.privileged-role-mfa` | a privileged role is in use without a second factor          |
| `credential.scope`          | the credential's scopes do not cover the action              |
| `rbac.permission`           | **allows** when the permission is held; refuses otherwise    |

`credential.scope` deserves a note: an action with no scope mapping is **denied**, not
allowed. A new endpoint that nobody mapped is unreachable by an API key until somebody
maps it, which is the failure everyone prefers.

`roleGrantPolicy(canGrantRole)` is added on top by the example application. It stops an
administrator from granting `organization_owner` — the standard privilege-escalation
path in any role system, and one that RBAC alone cannot see, because
`rbac.role.assign` is a single permission that says nothing about _which_ role.

## Tenant isolation

**The organization is never taken from the client.** It comes from the verified actor
and a server-side membership lookup. An `X-Organization-Id` header is a request, not a
fact.

`packages/authorization` has explicit negative tests for the five attacks:

- **Cross-organization access** — a valid token from org A against org B's record.
- **Role escalation** — assigning a role above the assigner's own grant set.
- **Inactive-member access** — a member whose membership was revoked but whose
  unexpired access token still says otherwise. Membership is re-resolved per request,
  which is why this fails.
- **Invitation-token abuse** — an invitation reused, expired, or presented for a
  different organization.
- **Organization-header manipulation** — a header naming an organization the actor is
  not in.

Each is a test that fails if the control is removed. `assertNoLeakedValues` also checks
that a cross-tenant denial does not leak the other organization's name or record id in
the error.

## Scopes

Scopes are `resource:action`, and a write scope covers the matching read:
`payments:write` satisfies a `payments:read` requirement. The reverse never holds —
that is the whole point, and `scopeMatches` is the one place it is decided.

Example scopes: `payments:read`, `payments:write`, `merchants:read`,
`merchants:write`, `webhooks:manage`, `reports:read`. They are examples: the allowed
set is configuration, and a product defines its own.

Validation is server-side, in `ScopeGuard` and `credentialScopePolicy`. A key with
`payments:read` calling a write route is refused by the server; nothing depends on a
client having checked.

Scopes apply to _credentials_. A human's session has no scopes, because a person's
authority is their roles. Narrowing a person's authority per-request is what roles are
for.

## Decision records

Every decision carries a `decisionId`. It appears in the 403 body and in the
`authz.denied` security event, so an operator can go from "the customer says they got a
403 at 14:12" to the exact policy that refused without asking the customer to reproduce
it.

The 403 body says _that_ it was denied and gives the id. It does not say which of nine
policies refused, because that is a map of the security model handed to whoever is
probing it. The reason is in the event.

## Writing a policy

```ts
const merchantActivePolicy: Policy = {
  name: 'merchant.active',
  evaluate: (request) => {
    if (request.resourceType !== 'Merchant') return null; // not mine
    const status = request.resource?.status;
    if (status === 'suspended') {
      return { effect: 'deny', reason: 'merchant_suspended' };
    }
    return null; // no opinion. NOT an allow.
  },
};
```

Three rules:

- **Return `null` for "not mine".** Never `{ effect: 'allow' }`.
- **Never allow.** Only `rbac.permission` allows. A custom policy that allows makes
  every policy before it optional.
- **Insert before `rbac.permission`.** `createAuthorizer({ additional })` does this.

A guard runs before the handler has loaded anything, so a decision about a _specific
row_ cannot be made in a decorator. Declare the resource type with
`@Authorize('merchant.update', 'Merchant')` and call `authorizer.assert(...)` in the
handler with the row in hand.

## Frontends are not authorities

A frontend may hide a button the actor cannot use. That is a courtesy, not a control.
Every route re-checks on the server, and the framework provides no mechanism for a
client to assert a decision — there is no "I already checked" header and no signed
capability a browser can present.

The reason is not distrust of the frontend; it is that the frontend's copy of the
permission set is a snapshot. A membership revoked thirty seconds ago is still in the
browser's state. The server's copy is current.

---

**See also:** [enterprise-identity.md](enterprise-identity.md) ·
[api-key-security.md](api-key-security.md) ·
[security-testing.md](security-testing.md) ·
[threat-model.md](threat-model.md)

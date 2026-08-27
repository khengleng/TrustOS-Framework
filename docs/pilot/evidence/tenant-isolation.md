# Tenant isolation results

Eleven tests. Every one against the service, none against a UI.

The pilot specification is explicit: _test API manipulation directly, do not only test UI
restrictions._ The reason is that a hidden button is a request anybody can still make, and the
control has to be in the code path rather than in the rendering.

## The setup

Two organizations, `org_a` and `org_b`, each with an approved merchant on the same product, using
the same payment reference.

## Results

| Test                                                      | Result                           |
| --------------------------------------------------------- | -------------------------------- |
| Organization A's merchant read from B                     | **Not found**                    |
| Organization A's merchant list, read as B                 | **Empty**                        |
| Organization A's wallet read from B                       | **Refused**                      |
| Organization A's journal read from B                      | **Refused**                      |
| A payment naming A's merchant, made as B                  | **`merchant_not_found`**         |
| A limit change request in A, decided as B                 | **Not found**                    |
| A platform-wide role crossing a tenant boundary           | **Refused for all six roles**    |
| A platform role seeing another merchant in its own tenant | **Permitted** — correct          |
| A merchant role seeing another merchant                   | **Refused**                      |
| The same payment reference in two tenants                 | **Two payments, not one replay** |
| A cross-tenant read's status code                         | **404, not 403**                 |

## Why 404 and not 403

Confirming that a merchant exists in another organization is itself a disclosure: it tells a caller
that the identifier they guessed is real, which is most of what an enumeration attack wants.

`assertCanView` throws `not_found` for a cross-tenant read and the test asserts the code rather
than the message.

## Why the same reference in two tenants is two payments

The idempotency key is `organizationId::merchantId::reference`. Two tenants both using `ORDER-001`
are two payments, and a key scoped only to the reference would mean one tenant's order silently
replaying another's response.

## The structural reason this holds

Every framework signature in the payment path takes `organizationId` first and non-optionally:

```ts
onboarding.require(organizationId, merchantId);
wallets.get(walletId, organizationId);
ledger.get(journalId, organizationId);
limits.consume({ organizationId, scope, subjectId, amount });
```

A lookup by id that then filters is a lookup that returns the wrong thing when somebody forgets the
filter. Making the tenant a required leading parameter makes forgetting it a type error rather than
a code review question.

## The design decision behind it

**A merchant is not a tenant.** The organization is the framework's tenant; a merchant is a record
inside one.

Making the merchant the tenant reads as the natural mapping, and it means every framework package
that scopes by `organizationId` scopes by the wrong thing. Every isolation test in the framework
would still pass while the application leaked across merchants inside one organization — a green
suite and an absent control, which is the worst available combination.

# Architecture

The TrustOS Engineering Framework is the shared foundation for TrustOS Learn,
TrustOS Merchant, payKH, payChain, dbank, Telegram Mini Apps and the vertical
SaaS platforms that follow. It exists so that authentication, tenant isolation,
authorization, auditing and error handling are solved **once**, correctly, and
reused — rather than re-implemented per product with slightly different bugs.

---

## 1. Principles

**A modular monolith, deliberately.**
One deployable per product, with hard internal boundaries. Packages are separate
so their dependencies can be enforced, not so they can be deployed separately.
Microservices are explicitly out of scope for this phase: distributed
transactions, service discovery and network partitions are expensive problems to
buy before the domain boundaries are known.

**Security controls live in the framework, not in product code.**
A product that forgets to filter by organization, forgets to check a permission,
or forgets to audit a role change should _fail_, not silently expose data. That
is why `PermissionsGuard` denies undecorated routes, why `scopedDelegate`
rejects operations it cannot scope, and why `AuditSink` has no update method.

**Fail closed, fail loudly, fail early.**
Invalid configuration aborts startup. A missing tenant scope throws rather than
querying every organization. An unrecognized delegate method throws rather than
passing through.

**Clients are conveniences; servers are controls.**
The admin app hides buttons a user cannot use. That is UX. Every one of those
actions is independently re-checked on the server, and the tests that matter
prove the server check, not the hidden button.

**Ports and adapters at the edges.**
`AuthService` depends on `AuthUserStore`, not on Prisma. `AuditService` depends
on `AuditSink`. This is not abstraction for its own sake — it is what lets the
security-critical logic be tested exhaustively with in-memory fakes, with no
database, no fixtures and no flake. The Prisma adapters are thin and boring by
design.

---

## 2. Repository layout

```
apps/
  api-example/        reference NestJS API — demonstrates every package
  admin-example/      reference Next.js console — login, tenancy, RBAC, audit
packages/
  shared-types/       types shared by server and browser. No runtime deps.
  errors/             error codes, ApiError, the response contract
  validation/         Zod schemas + the one path from bad input to an error
  config/             validated environment. The only reader of process.env
  logging/            Pino, request correlation, redaction
  database/           Prisma schema, client lifecycle, soft-delete helpers
  auth/               password, JWT, refresh rotation, guards
  rbac/               roles, permissions, deny-by-default guard
  tenancy/            organization scope: context, query scoping, guard
  audit/              append-only audit trail
  observability/      health/ready, metrics + tracing seams
templates/
  saas-starter/       copy-this-folder starting point for a new product
docs/                 this directory
.github/workflows/    CI
```

---

## 3. Dependency rules

Dependencies point **downward only**. The graph is acyclic and CI fails if a
rule is broken (`eslint.config.mjs` encodes them as `no-restricted-imports`).

```
                    shared-types      errors          ← layer 0: no dependencies
                        │  │            │
        ┌───────────────┘  │            ├──────────────┐
        │                  │            │              │
     config ───────────────┼────────► validation    rbac ──┐
        │                  │            │              │   │
     logging ──────────────┘            │              │   │
        │                               │              │   │
     database ─────────────────────────┘               │   │
        │  │                                           │   │
        │  └──────────► audit ◄── logging              │   │
        │                                              │   │
        └──────────────► auth ◄────────────────────────┘   │
                                                    tenancy┘
                                (tenancy depends only on errors + shared-types)

apps/ and templates/ may depend on any package. Nothing may depend on them.
```

| Rule                                                                | Enforced by    |
| ------------------------------------------------------------------- | -------------- |
| `shared-types` and `errors` have no framework dependencies          | eslint         |
| Only `config` reads `process.env`                                   | eslint         |
| The admin app may not import server-only packages                   | eslint         |
| No package may import an application                                | eslint         |
| No cross-package deep imports (`../../pkg/src/x`)                   | eslint         |
| Browser-safe packages ship NestJS bindings behind a `/nest` subpath | package layout |

**Why the `/nest` subpath.** `@trustos/errors` and `@trustos/validation` are
imported by the browser. If their root entry point re-exported a NestJS filter
or pipe, a bundler would pull a server framework — and everything it transitively
imports — into the client bundle. The subpath (`@trustos/errors/nest`) makes the
split physical rather than advisory.

---

## 4. Package responsibilities

### `@trustos/shared-types`

Types only, zero runtime dependencies. Entity summaries, request/response
contracts, pagination. The one package the browser and the server genuinely
share.

### `@trustos/errors`

The seven error codes, the `ApiError` class, and `toErrorResponse` — the single
place that decides what a caller is allowed to see. Unexpected errors never
contribute their message or stack to a production response. `ApiError.context`
is for logs and is never serialized to the wire.

### `@trustos/validation`

Shared Zod schemas and `parseOrThrow`, the only sanctioned route from untrusted
input to a typed value. Parsing _replaces_ the value, so unknown keys are
stripped — which is what prevents mass-assignment through a DTO.

### `@trustos/config`

Validates the environment once, at startup, and returns a frozen `AppConfig`.
Reports every problem at once. Refuses to boot production on placeholder or
short secrets, or when the access and refresh secrets match. Development and
test get working defaults; production gets none.

### `@trustos/logging`

Pino with service/environment/version on every line, request id, actor id and
organization id pulled from `AsyncLocalStorage`. Redaction runs twice — Pino's
fast path for known shapes, plus a deep key scan for everything else — because a
credential in a log sink cannot be recalled.

### `@trustos/database`

The Prisma schema and client lifecycle. Convention rather than magic:
`createdAt`/`updatedAt`/`deletedAt` on mutable models, `organizationId` first in
the index on tenant-owned models, and no hard deletes from application code.
`AuditLog` is the deliberate exception — append-only, no foreign keys.

### `@trustos/auth`

Email and password only. bcrypt (pure JS, so no native build ever breaks a
deploy), separate signing keys for access and refresh tokens, and refresh-token
rotation with reuse detection. Emits events; it does not know that
`@trustos/audit` exists.

### `@trustos/rbac`

The permission catalog, five system roles, and a guard that denies any
authenticated route declaring no policy. `canGrantRole` stops the standard
escalation: an administrator who can assign roles must not be able to assign
`organization_owner`.

### `@trustos/tenancy`

Organization scope. Read `docs/security-standards.md` before changing anything
here.

### `@trustos/audit`

Append-only records with actor, organization, action, entity, before/after,
timestamp, request id, IP and user agent. `before`/`after` are redacted with the
logger's rules. A sink failure is logged, never propagated — an audit outage
must not turn a successful login into a 500.

### `@trustos/observability`

`GET /health` (liveness, touches nothing) and `GET /ready` (readiness, checks
dependencies). Metrics and tracing are _interfaces_ with no-op defaults: the
seam is free, the backend is a later decision.

---

## 5. Request lifecycle

```
  request
    │
    ├─ requestContextMiddleware   assign/accept request id, open log context,
    │                             echo x-request-id, start the timer
    ├─ tenantScopeMiddleware      open an empty tenant scope for this request
    │
    ├─ JwtAuthGuard               who is calling?   → request.actor
    ├─ TenantGuard                whose data?       → request.organizationId
    ├─ PermissionsGuard           may they do this? → deny by default
    │
    ├─ ZodValidationPipe          untrusted input → typed, stripped value
    ├─ handler                    business logic; queries carry the scope
    │
    ├─ AuditService.record        for every sensitive mutation
    └─ AllExceptionsFilter        any failure → the standard error body
                                  res 'finish' → access log + metrics
```

Two details are load-bearing:

**Guard order is the security model.** They are registered in `AppModule` in
this order and Nest honours it. Authentication before tenancy before
authorization means an anonymous request to a tenant-scoped route returns 401,
not 403, and a cross-tenant request never reaches a permission check.

**The tenant scope is opened by middleware, not by the guard.** A guard returns
before the handler runs, and `AsyncLocalStorage.enterWith` does not reliably
survive that promise boundary — the handler resumes in the async context
captured _before_ the guard ran and sees an empty store. So middleware opens a
mutable holder for the whole request and the guard fills it in. The guard throws
if the middleware is missing rather than proceeding unscoped.

---

## 6. Tenant isolation rules

These are the rules a reviewer checks. They are not aspirational.

1. **Every query against a tenant-owned model includes `organizationId`.**
   Prefer `scopedDelegate`, which makes it structural; otherwise the filter is
   the first condition in the `where` clause.
2. **The organization comes from the access token**, never from a request body,
   query string or header. Membership is verified when the token is minted, so
   later requests can trust the claim.
3. **A request that names a different organization than the token is refused.**
   A request naming _two_ different organizations is refused as ambiguous.
4. **A lookup by primary key is verified after loading** with
   `assertTenantMatch`, which reports another tenant's row as `not_found` —
   never `forbidden`, which would confirm the id exists.
5. **Cross-organization access requires `@CrossOrganization()` and
   `isSuperAdmin`.** Every use is a review item.
6. **Frontend filtering is never a control.** The admin app filters for
   readability; the server filters for safety.
7. **Every tenant-owned model gets isolation tests.** See
   `packages/tenancy/src/tenant-isolation.spec.ts` for the framework's, and
   `templates/saas-starter/src/modules/widgets/widgets.spec.ts` for the shape a
   product copies.

---

## 7. Deliberate trade-offs

| Decision                                    | Cost                                                                      | Why                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions are carried in the access token | A revoked permission still works until the token expires (15 min default) | Removes a database round trip from every authorized request. Shorten `ACCESS_TOKEN_TTL` to narrow the window; refresh re-resolves from the database.        |
| Audit failures do not fail the operation    | A sink outage loses records                                               | An audit outage taking down login is a worse failure. For actions where the record is part of the contract, write it in the same transaction as the change. |
| bcrypt rather than argon2                   | Slightly weaker per-unit-cost                                             | Pure JavaScript: no native module, so no deploy ever fails on a build toolchain. Cost factor is configuration.                                              |
| The database is not required at startup     | An instance can be live but not ready                                     | `/health` and `/ready` answer different questions. Crashing on a database blip turns a brief outage into a restart loop and blocks rolling deploys.         |
| One organization per access token           | Switching organizations costs a round trip                                | Membership is verified exactly once, at issue time, and every later authorization is a pure function of the token.                                          |

---

## 8. Creating a new TrustOS application

1. `cp -r templates/saas-starter apps/<product>` and rename the package in
   `package.json`.
2. Add the product to the `workspaces` array if it is outside `apps/*`.
3. Replace `modules/widgets` with your domain module. Keep the shape: a
   permission on every route, `@OrganizationId()` in the handler, audit on every
   mutation, isolation tests alongside.
4. Add your models to a product Prisma schema — with `organizationId`,
   timestamps, `deletedAt` and an index on `organizationId`.
5. Add your permission keys to a product catalog and seed them onto roles.
6. Do **not** modify the three global guards, the error contract, or the tenancy
   package to make your product fit. If the framework genuinely cannot express
   what you need, change the framework deliberately — with tests and a doc
   update — rather than working around it locally.

Full instructions, including the Railway service setup, are in
`docs/railway-deployment.md` and the root `README.md`.

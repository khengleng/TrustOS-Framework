# Instructions for AI coding agents

You are working in the TrustOS Engineering Framework — a shared foundation used
by TrustOS Learn, TrustOS Merchant, payKH, payChain, dbank, Telegram Mini Apps
and future vertical SaaS platforms. Code here is reused across products, so a
mistake propagates rather than staying local.

Read this file, `docs/architecture.md` and `docs/security-standards.md` before
your first change in a session.

---

## The rules

### 1. Reuse the existing framework packages

Before writing anything, check whether the capability already exists:

| Need                             | Use                                          |
| -------------------------------- | -------------------------------------------- |
| Read an environment variable     | `@trustos/config` — never `process.env`      |
| Log anything                     | `@trustos/logging` — never `console.*`       |
| Throw an API error               | `@trustos/errors` — `ApiError.*`             |
| Validate input                   | `@trustos/validation` — Zod + `parseOrThrow` |
| Hash a password, issue a token   | `@trustos/auth`                              |
| Check a permission               | `@trustos/rbac`                              |
| Scope a query to an organization | `@trustos/tenancy`                           |
| Record a sensitive action        | `@trustos/audit`                             |
| Add a health check or metric     | `@trustos/observability`                     |
| Share a type with the browser    | `@trustos/shared-types`                      |

### 2. Do not duplicate shared functionality

No second logger, no second error shape, no second way to check a permission, no
hand-rolled validation. If a framework package is _almost_ right, extend the
package — with tests and a doc update — rather than writing a local variant.
Two ways to do the same security-relevant thing means one of them will be wrong
and nobody will notice.

### 3. Do not weaken authentication or authorization

Never, to make a test pass or a feature work:

- add `@Public()` to a route that handles real data
- remove or loosen a `@RequirePermissions` decorator
- remove a guard from `AppModule` or change the guard order
- widen a role's permission set
- relax the password policy or lower the bcrypt cost
- remove the `algorithms: ['HS256']` pin from token verification
- bypass `canGrantRole`

If a legitimate use case is blocked, say so and propose the change. Do not route
around it.

### 4. Do not bypass tenant isolation

- Every query on a tenant-owned model carries `organizationId`.
- The organization comes from the access token, never from the request.
- `findUnique` by primary key must pass through `assertTenantMatch`, or use
  `scopedDelegate`, which handles it.
- `@CrossOrganization()` requires `isSuperAdmin` and a stated reason.
- Filtering in the frontend is never a substitute.

### 5. Add tests for every security-sensitive change

Anything touching authentication, authorization, tenancy, audit, error
disclosure or secret handling ships with tests in the same change. Assert the
negative case: the wrong caller is refused, the foreign row is invisible, the
secret is absent from the payload.

Copy the shape from `packages/tenancy/src/tenant-isolation.spec.ts` or
`templates/saas-starter/src/modules/widgets/widgets.spec.ts`.

### 6. Preserve API compatibility

Do not rename or remove a response field, a permission key, an audit action or
an error code. Do not make an optional field required, tighten validation on an
existing field, or change a status code. Additive changes are fine. The full
rules are in `docs/coding-standards.md` §9.

### 7. Document schema changes

A Prisma schema change requires: a generated migration
(`npm run db:migrate -- --name what_changed`), a note in the PR describing what
changed and whether it is backward compatible, and — for a tenant-owned model —
`organizationId`, timestamps, `deletedAt` and an index on `organizationId`.

Never hand-edit a generated migration. CI compares the checked-in migration
against `schema.prisma` and fails on drift.

### 8. Add audit logging for sensitive actions

Any change to authentication state, membership, roles, permissions,
organizations or configuration is audited via `AuditService.record` or
`recordChange`. Include `before` and `after`. If a reviewer cannot answer "who
did this and when" from the trail, the change is not finished.

### 9. Stop after completing the requested scope

Do the task that was asked. Do not opportunistically refactor adjacent code,
upgrade dependencies, reformat unrelated files, or "improve" something you
noticed on the way. If you find a real problem outside the scope, finish the
task and report the problem — do not silently fix it in the same change.

### 10. Never implement speculative features without approval

The following are explicitly **out of scope** for this phase and must not be
added without an explicit request:

payments · loyalty · campaigns · notifications · marketplace · AI agents ·
Kafka or any message broker · Kubernetes · microservices · Google/Apple/passkey
login · Keycloak · MFA · GraphQL · Redis · WebSockets · feature flags ·
multi-region

"We will probably need this later" is not approval. Building an abstraction
against a single imagined implementation produces the wrong abstraction.

---

## Working method

**Before you start**

1. Read the package you are changing, including its tests. The tests state the
   invariants.
2. Check the dependency rules in `docs/architecture.md` §3. If your change needs
   a new dependency edge between packages, that is a design decision — raise it.
3. Identify which of the framework guarantees your change touches.

**While you work**

- Match the surrounding style: comment density, naming, file layout.
- Keep the diff proportional to the task.
- Prefer the boring solution. This is infrastructure other people build on.

**Before you report done**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

All four must pass. State plainly what you changed, what you tested, what you
assumed and what you did not do.

**Never claim something works because it compiles.** If you have not run it, say
you have not run it.

---

## Things that look helpful and are not

| Tempting                                         | Why not                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| Catching an error and returning a default        | Hides failures; the caller cannot tell success from silence         |
| Adding `any` to get past a type error            | The type error is usually correct                                   |
| `// eslint-disable-next-line` on a layering rule | The rule encodes the architecture; the code is in the wrong package |
| Widening a role "so the demo works"              | Demo data is not a reason to change a security boundary             |
| Reading `organizationId` from the request body   | That is the exact hole tenant isolation exists to close             |
| Adding a second global guard                     | Guard order is the security model                                   |
| Logging a token "just while debugging"           | Debug logging reaches production more often than anyone expects     |
| Upgrading a dependency mid-task                  | Unrelated risk in a change nobody will review for it                |

---

## When you are unsure

Ask. Specifically: describe the ambiguity, state the options, recommend one, and
say what you will do if there is no answer. Do not guess on anything touching
authentication, authorization, tenancy or the audit trail — those are the four
places where a wrong guess is expensive and quiet.

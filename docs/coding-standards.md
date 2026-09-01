# Coding standards

Conventions that apply across every TrustOS package and product. The goal is
that code written by different people, in different products, in different
years, reads as though one team wrote it.

---

## 1. TypeScript

- `strict` is on, plus `noUncheckedIndexedAccess` and `noImplicitOverride`.
  Do not relax them per file.
- **No `any`.** Use `unknown` and narrow. If a third-party type genuinely
  requires a cast, isolate it in one function with a comment explaining why.
- **No non-null assertions (`!`) in framework packages.** Narrow, or throw an
  `ApiError` with a message that explains the invariant.
- Prefer `type` for unions and object shapes, `interface` for contracts other
  code implements (ports, adapters).
- Export types with `export type` when they are types only, so the emitted
  JavaScript does not carry a phantom import.
- Return types are explicit on exported functions. Inference is fine internally.

## 2. Naming

| Thing                 | Convention                                                     | Example                               |
| --------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Files                 | kebab-case                                                     | `permission-checker.ts`               |
| Nest artifacts        | `*.controller.ts`, `*.service.ts`, `*.guard.ts`, `*.module.ts` | `tenant.guard.ts`                     |
| Tests                 | `*.spec.ts` beside the code                                    | `auth.service.spec.ts`                |
| Types / classes       | PascalCase                                                     | `ApiError`, `TenantContext`           |
| Functions / variables | camelCase                                                      | `assertTenantMatch`                   |
| Constants             | SCREAMING_SNAKE                                                | `PASSWORD_MIN_LENGTH`                 |
| Permission keys       | `resource.action`                                              | `organization.member.invite`          |
| Audit actions         | `domain.entity.verb` (past tense)                              | `rbac.role.assigned`                  |
| Injection tokens      | `Symbol.for('trustos.*')`                                      | `Symbol.for('trustos.audit-service')` |

Booleans read as assertions: `isActive`, `hasNextPage`, `canGrantRole`.
Async functions that throw on failure are named `assertX` / `requireX`; the
non-throwing variants are `hasX` / `getX`.

## 3. Comments

Comment the **why**, never the what. `// increment i` is noise; `// Deliberately
discards the original message: unexpected errors routinely embed connection
strings` is the reason someone will need in two years.

Every exported symbol in a framework package carries a doc comment stating what
it is for and what it guarantees. Security-relevant code additionally states
what breaks if the guarantee is removed — that comment is what stops a
well-meaning refactor.

## 4. Errors

- Throw `ApiError`. Anything else reaching the exception filter is treated as an
  unexpected failure and reported as `internal_error` with its message withheld.
- Pick the code from the caller's perspective: `not_found` for a resource they
  may not know about (including another tenant's), `forbidden` for one they know
  exists but may not touch, `conflict` for a state clash, `validation_error` for
  malformed input.
- Diagnostic detail goes in `ApiError.context`, which reaches logs and never the
  response body.
- Never catch an error only to re-throw it unchanged. Either add context or let
  it travel.

## 5. Validation

- Every request body, query and param is parsed with a Zod schema through
  `ZodValidationPipe` or `parseOrThrow`.
- Use the **parsed output**, never the raw input. Zod strips unknown keys, which
  is what stops a caller smuggling `organizationId` or `isSuperAdmin` into a DTO
  that later gets spread into a write.
- Compose the shared primitives in `@trustsystem/validation` rather than restating
  what a valid email or password is.

## 6. Database access

- Tenant-owned reads and writes carry `organizationId`. Prefer `scopedDelegate`.
- No hard deletes from application code on a model with `deletedAt`. Use
  `softDeleteData()`.
- Every read filters `deletedAt: null` unless it is deliberately reading
  retired rows.
- Multi-row invariants go in `prisma.$transaction`. An organization without an
  owner, or a member without a role, is a state no error path should be able to
  produce.
- Migrations are generated, never hand-edited:
  `npm run db:migrate -- --name what_changed`. CI fails if the checked-in
  migration and `schema.prisma` disagree.
- Index `organizationId` first on tenant-owned models: it is in every
  legitimate query.

## 7. NestJS

- Modules expose `forRoot(options)` when they need configuration; otherwise a
  plain `@Module`.
- Controllers are thin: validate, delegate, map to a response type. Business
  logic lives in a service; a controller with an `if` about domain state is a
  smell.
- Services take their dependencies through the constructor. No service locators,
  no reaching into `ModuleRef` at runtime.
- Every route declares its access policy. There is no default.
- Do not register a fourth global guard without a security review — the three
  and their order are the security model.

## 8. Tests

- Vitest, `*.spec.ts` beside the code.
- Test names state the behaviour and, where it matters, the reason:
  `'reports another organization row as not_found, never as forbidden'`.
- Security-relevant tests assert the **negative**: that the wrong caller is
  refused, that the secret is absent from the payload, that the foreign row is
  invisible. A test that only proves the happy path proves very little about a
  guard.
- Use the in-memory fakes shipped with the packages (`InMemoryUserStore`,
  `InMemoryAuditSink`, `FakeModelDelegate`) rather than mocking Prisma. They
  implement the same contracts, including the parts that are easy to get wrong.
- No network, no database, no clock, no randomness in unit tests. Inject `now`.
- A regression test names the bug it prevents in its comment.

## 9. API compatibility

Products and clients depend on these contracts. Within a major version:

**Allowed** — adding an endpoint; adding an optional request field; adding a
response field; adding an error code, permission key or audit action; relaxing a
validation rule.

**Not allowed** — removing or renaming a response field; making an optional
request field required; changing an error code for an existing condition;
renaming a permission key or audit action; tightening validation on an existing
field; changing a status code.

Renaming a permission key silently grants or revokes access on every deployment
that has not been migrated. Renaming an audit action breaks dashboards, alert
rules and regulatory exports. Treat both as permanent.

Schema changes are documented in the PR: what changed, whether it is backward
compatible, and the migration path if not.

## 10. Formatting and linting

Prettier and ESLint decide. Do not argue with them in review; change the config
if the rule is wrong.

```bash
npm run format      # apply
npm run lint        # check, including dependency rules
```

The layering rules in `eslint.config.mjs` are mechanical enforcement of
`docs/architecture.md` §3. If lint blocks an import, the fix is almost never to
add an eslint-disable — it is that the code is in the wrong package.

## 11. Commits and pull requests

- Imperative subject, under 72 characters: `add reuse detection to refresh flow`.
- The body explains why, not what — the diff already says what.
- A PR touching authentication, authorization, tenancy or audit says so in its
  description and lists the tests that cover it.
- Schema changes state the migration name and whether it is backward compatible.

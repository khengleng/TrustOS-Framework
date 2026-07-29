# Templates

A template is a promise: _generating this produces a working, secure TrustOS
application_. This document is what keeps that promise true as templates
multiply and change hands.

---

## 1. Layout

```
templates/
  _base/                    every generated application gets this
    template.json           conditional paths
    files/                  the tree, mirroring the generated project
  <template-id>/
    template.json
    files/                  overrides and adds to _base
```

Generation merges `_base` then the template, so a template only contains what
makes it that template. The framework wiring — guards, error filter, request
context, health probes, auth module, audit reads — lives in `_base` once.

### File naming

| Convention       | Meaning                                   |
| ---------------- | ----------------------------------------- |
| `foo.ts`         | copied verbatim                           |
| `foo.ts.hbs`     | rendered with Handlebars, `.hbs` stripped |
| `_dot_gitignore` | becomes `.gitignore`                      |

The `_dot_` prefix exists because a literal `.gitignore` inside a template tree
would be applied by git _to the template tree_, and npm strips `.gitignore`
from published packages. Encoding the dot avoids both and makes the intent
greppable.

### Paths are literal

Template file paths are never templated. The only user input that becomes a path
is the project directory name, which is validated and contained. This is a
deliberate security property: **no prompt answer can influence where a file is
written.** Do not add path templating.

---

## 2. Design rules

**1. Reuse the framework. Never reimplement it.**
A template that ships its own logger, error shape, permission check or tenant
filter is a bug, not a variation. `validate-template` fails a template that
imports a `@trustos/*` package it did not declare, and code review catches the
rest.

**2. Every route declares a permission.**
The framework's `PermissionsGuard` denies undeclared routes, so a template that
forgets one generates a broken endpoint. That is the intended failure — but the
template should not ship it.

**3. Every tenant-owned model carries `organizationId`, timestamps and
`deletedAt`, and indexes `organizationId` first.**

**4. Every template ships tenant-isolation tests.**
`validate-template` fails a template whose specs do not cover isolation. The
four assertions every product entity owes:

- listing returns only the caller's organization
- creating stamps the caller's organization
- reading another organization's row reports `not_found`, never `forbidden`
- updating or deleting another organization's row fails and changes nothing

Plus: no tenant context at all must fail closed.

**5. Product models do not declare a Prisma relation to `Organization`.**
Prisma requires both sides of a relation, so declaring one would mean editing
`00-framework.prisma` — the file replaced wholesale on framework upgrade.
`organizationId` is a scalar with an index, the same trade the framework makes
for `AuditLog`. Isolation comes from the query scope, not the foreign key. A
template that wants the database-level guarantee adds the constraint in a
migration.

**6. Mutations are audited; reads are not.**
Include `before` and `after`. Snapshot the before-values _before_ the write —
reading them afterwards makes the record depend on the repository returning a
detached object, which no store guarantees.

**7. Credentials are shown once and stored hashed.**
Never in an audit record, never in a log line, never in a shared type. The
payment-gateway template is the worked example.

**8. Money is integer minor units.** Floating point never touches an amount.

**9. Nothing speculative.**
Each template's `outOfScope` list is enforced by review, echoed into the
generated README, and repeated in the generated `AGENTS.md`. A template that
quietly adds payments because "they'll need it" has made a product decision it
was not asked to make.

**10. No JSX inline styles in a `.hbs` file.**
`style={{ … }}` collides with Handlebars delimiters and fails at render time.
Use a CSS class. (Handlebars' `\{{` escape exists for cases where literal
braces are genuinely wanted, such as Railway's `${{VAR}}` syntax.)

---

## 3. The registry

`packages/template-registry` holds the metadata, as typed, Zod-validated code
rather than loose JSON. An invalid manifest fails at module load, so it cannot
reach a caller.

| Field                        | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `id`                         | Directory name and CLI argument                              |
| `displayName`, `description` | Shown by `list-templates`                                    |
| `version`                    | Exact semver. Ranges are rejected.                           |
| `minimumFrameworkVersion`    | `trustos new` refuses an older framework                     |
| `includedApps`               | `api`, `admin`, `miniapp`                                    |
| `includedModules`            | The `@trustos/*` packages it wires — checked against imports |
| `requiredVariables`          | Every placeholder a template may reference                   |
| `deploymentTargets`          | `railway`, `local`                                           |
| `entities`                   | Domain models, for `--verbose`                               |
| `migrationNotes`             | What a maintainer must know when moving versions             |
| `owner`                      | The team accountable. Not decorative — see below.            |
| `outOfScope`                 | Deliberate exclusions, echoed into the generated project     |

`requiredVariables` is load-bearing: `validate-template` fails on any
placeholder not declared there, which is what stops a template rendering an
empty string into a generated config file.

---

## 4. Ownership

Every template names an owner, and the owner is accountable for:

- reviewing changes to it
- keeping `migrationNotes` truthful across versions
- deciding what stays out of scope, and defending that in review
- refreshing `00-framework.prisma` when the framework schema changes

| Template            | Owner                 |
| ------------------- | --------------------- |
| `generic-saas`      | TrustOS Platform Team |
| `merchant`          | TrustOS Merchant Team |
| `learning`          | TrustOS Learn Team    |
| `payment-gateway`   | payKH Team            |
| `telegram-mini-app` | TrustOS Platform Team |

An unowned template rots: nobody upgrades it, nobody notices when its security
assumptions age, and the next product to use it inherits the problem.

---

## 5. Versioning and compatibility

Template versions are semantic, and they describe the **generated output**:

| Change                                                                        | Bump      |
| ----------------------------------------------------------------------------- | --------- |
| Fix a typo, improve a comment, tighten a test                                 | patch     |
| Add a model, endpoint, screen or permission                                   | minor     |
| Rename or remove a model, endpoint or permission key; restructure directories | **major** |

`minimumFrameworkVersion` moves when a template starts using something new from
the framework. `trustos new` refuses to generate against an older framework
rather than producing a project that fails at build time.

Existing generated projects are unaffected by a template change — generation is
a one-time act, and `trustos.json` records which version produced a project.
That is also why `trustos upgrade` is a real piece of work rather than a
follow-up chore, and why it is out of scope for this phase.

### Framework schema copies

Each generated project owns a copy of the framework models at
`prisma/schema/00-framework.prisma`. Prisma has no cross-package schema import,
so this is a copy, and it can drift. When the framework schema changes:

1. Refresh the copy in `templates/_base/files/prisma/schema/00-framework.prisma`.
2. Say so in the affected templates' `migrationNotes`.
3. Bump `minimumFrameworkVersion` if generated code now depends on the change.

---

## 6. Adding a template

1. **Get approval.** A new template is a long-term commitment by a named team,
   not a folder. Agree the scope — and the `outOfScope` list — first.
2. `mkdir -p templates/<id>/files` and add `template.json` with the id.
3. Add the manifest to `packages/template-registry/src/registry.ts` and the id
   to `TEMPLATE_IDS`.
4. Add only what makes it distinct:
   - `prisma/schema/10-product.prisma`
   - `packages/product-domain/src/index.ts` — permissions and role grants
   - `packages/shared-types/src/index.ts` — runtime-free shared types
   - `apps/api/src/modules/product/` — module, service, controller(s)
   - `apps/api/src/modules/product/tenant-isolation.spec.ts`
   - `apps/admin/src/lib/resources.ts` — the console screens
5. `trustos validate-template <id>` until it passes.
6. `trustos new <id> --yes --framework-path .` then, in the generated project:
   `npm install && npm run db:validate && npm run typecheck && npm test && npm run build`.
7. Add the id to the CI matrix in `.github/workflows/ci.yml`.

The `ProductModule` name and its location are fixed by `_base`'s composition
root, so a template replaces the domain inside that folder rather than editing
`app.module.ts`.

---

## 7. Approval workflow

| Change                                  | Approval                                  |
| --------------------------------------- | ----------------------------------------- |
| Fix within an existing template         | Template owner                            |
| Add a model, endpoint or screen         | Template owner                            |
| Change anything in `_base`              | Platform team — it affects every template |
| Change the guard set or their order     | Platform team **and** a security review   |
| Relax a validation rule or a permission | Security review                           |
| Add a template                          | Platform team, with a named owner         |
| Add something from an `outOfScope` list | The decision-maker who put it there       |

A change to `_base` is the one most likely to be underestimated: it lands in
every product generated afterwards, and there is no upgrade path for products
generated before it. Treat it as a framework change.

---

## 8. Constraints for this phase

Templates are **local and version-controlled**. There is deliberately no remote
template fetch, no plugin resolution, no marketplace, no paid templates and no
self-update. The generator can only ever write files that are already in this
repository and have been through review — which is the property that makes the
threat model in [`generator-security.md`](generator-security.md) tractable.

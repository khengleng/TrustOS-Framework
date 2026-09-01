# Templates

A template is a promise: _generating this produces a working, secure TrustOS
application_. This document is what keeps that promise true as templates
multiply and change hands.

The library is thirty templates across nine categories. This page is the
architecture; the other three pages are:

| Page                                                           | For                                             |
| -------------------------------------------------------------- | ----------------------------------------------- |
| [industry-reference.md](industry-reference.md)                 | What each template models, and what it does not |
| [template-development-guide.md](template-development-guide.md) | Writing or changing one                         |
| [template-sdk.md](template-sdk.md)                             | The building blocks every template shares       |

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
context, health probes, auth module, audit reads, and the messaging mini app
shell — lives in `_base` once.

### Inheritance

A template may `extends` another. The layers then apply parent-first:

```
_base  →  clinic  →  hospital
```

A clinic is not a smaller hospital — a hospital is a clinic plus wards, and the
inheritance runs that way round. `merchant → ecommerce → marketplace`,
`wallet → digital-bank`, `education → school`, and the three messaging templates
share one parent for the same reason.

Almost every file a template ships is **additive**: its own Prisma fragment, its
own NestJS module folder, its own resource list. Exactly three are **aggregators**
it overrides, and each is a list of imports naming every layer in the chain:

| Aggregator                                       | Composes                                |
| ------------------------------------------------ | --------------------------------------- |
| `packages/product-domain/src/index.ts`           | the chain's permissions and role grants |
| `apps/admin/src/lib/resources.ts`                | the chain's console screens             |
| `apps/api/src/modules/product/product.module.ts` | the chain's Nest modules                |

That is the whole mechanism, and it is why `hospital` restates no patient field.
Without it, a child template would be a copy of its parent — correct on the day
it was made, and quietly different a year later. Templates get the same
no-duplication rule as everything else in the framework.

### Templates are generated

`templates/` is build output. The source is `scripts/template-specs.mjs`, and
three scripts derive everything from it:

```bash
node scripts/scaffold-industry-templates.mjs   # the file trees
node scripts/sync-template-registry.mjs        # the manifests
node scripts/sync-industry-reference.mjs       # the reference page
```

What differs per industry is the domain. What must not differ is the tenant
scope, the audit trail, the permission wiring and the isolation test — so the
second category is generated, and there is one correct version of it rather than
twenty-four copies. See the
[development guide](template-development-guide.md) before editing anything under
`templates/` by hand.

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
imports a `@trustsystem/*` package it did not declare, and code review catches the
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

| Field                        | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `id`                         | Directory name and CLI argument                                  |
| `displayName`, `description` | Shown by `list-templates`                                        |
| `version`                    | Exact semver. Ranges are rejected.                               |
| `minimumFrameworkVersion`    | `trustos new` refuses an older framework                         |
| `includedApps`               | `api`, `admin`, `miniapp`                                        |
| `includedModules`            | The `@trustsystem/*` packages it wires — checked against imports |
| `requiredVariables`          | Every placeholder a template may reference                       |
| `deploymentTargets`          | `railway`, `local`                                               |
| `entities`                   | Domain models, for `--verbose`                                   |
| `migrationNotes`             | What a maintainer must know when moving versions                 |
| `owner`                      | The team accountable. Not decorative — see below.                |
| `outOfScope`                 | Deliberate exclusions, echoed into the generated project         |
| `category`                   | One of nine groups, for `trustos templates`                      |
| `status`                     | `experimental`, `stable` or `deprecated`                         |
| `extends`                    | The template this one is layered on                              |
| `supersededBy`               | Required when deprecated, refused otherwise                      |
| `documentation`              | A page that must exist, checked by the validator                 |

`requiredVariables` is load-bearing: `validate-template` fails on any
placeholder not declared there, which is what stops a template rendering an
empty string into a generated config file.

### Status

None of the three statuses blocks generation.

| Status         | `trustos new`                                              |
| -------------- | ---------------------------------------------------------- |
| `stable`       | Generates quietly                                          |
| `experimental` | Generates with a warning that entities and keys may change |
| `deprecated`   | Generates with a warning naming its successor              |

A template somebody has already built on must keep generating, or an upgrade
becomes a rewrite. Promotion to `stable` is a decision a person makes, not one
the passing of time makes for them.

### Module dependencies

`includedModules` must be **closed under its own prerequisites**. A manifest
naming `wallet` without `ledger`, `accounts` and `financial-core` generates an
application whose wallet cannot compute a balance — and it fails on the first
request, in a project nobody has opened yet. `MODULE_DEPENDENCIES` in
`schema.ts` records the edges and the manifest schema refuses a list that is not
closed.

---

## 4. Ownership

Every template names an owner, and the owner is accountable for:

- reviewing changes to it
- keeping `migrationNotes` truthful across versions
- deciding what stays out of scope, and defending that in review
- refreshing `00-framework.prisma` when the framework schema changes

| Category            | Templates                                                             | Owner                            |
| ------------------- | --------------------------------------------------------------------- | -------------------------------- |
| Foundation          | `generic-saas`, `workflow-enabled-saas`                               | TrustOS Platform Team            |
| Commerce            | `merchant`, `ecommerce`, `marketplace`, `gold-shop`                   | TrustOS Merchant / Commerce Team |
| Financial services  | `payment-gateway`, `wallet`, `digital-bank`, `insurance`              | TrustOS Financial Team           |
| Lending             | `microloan`, `collection`                                             | TrustOS Lending Team             |
| Business operations | `crm`, `erp`, `helpdesk`                                              | TrustOS Platform Team            |
| Education           | `learning`, `education`, `school`                                     | TrustOS Learn Team               |
| Health              | `clinic`, `hospital`                                                  | TrustOS Health Team              |
| Public and social   | `ngo`, `government`                                                   | TrustOS Public Sector Team       |
| Messaging           | `telegram-miniapp`, `whatsapp-miniapp`, `messenger-miniapp`           | TrustOS Platform Team            |
| Portals             | `admin-portal`, `customer-portal`, `staff-portal`, `developer-portal` | TrustOS Platform Team            |

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
2. **Check it should not be a child.** If it is another template plus a few
   entities, set `extends` and write only the delta. That is the normal shape.
3. Add the id to `TEMPLATE_IDS` in `packages/template-registry/src/schema.ts`.
4. Add a spec entry to `scripts/template-specs.mjs` — entities, fields, modules,
   `outOfScope`, `migrationNotes`.
5. Re-run all three sync scripts.
6. `trustos validate-template <id>` until it passes.
7. `trustos new <id> --yes --framework-path .` then, in the generated project:
   `npm install && npm run db:validate && npm run typecheck && npm test && npm run build`.
8. Add the id to the CI matrix in `.github/workflows/ci.yml`.

The full field reference and the review rules are in the
[development guide](template-development-guide.md).

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

No template contains, and none may gain:

- a business-specific integration,
- a payment provider,
- a government API,
- an external AI provider,
- a cloud vendor service.

Every one of those is a seam a deployment fills. A template that filled one for
everybody would be a template only one deployment can use — and the industry
library exists precisely because the domain is shared and the vendors are not.

# Template development guide

How to add a template to the library, and the rules a reviewer will hold you to.

Read [templates.md](templates.md) first for the architecture, and
[industry-reference.md](industry-reference.md) to check that what you want does not already exist.

## Before you start: does it need to be a template?

Three questions, in order.

**Is there a template that already models this?** A clinic is a hospital without wards. A staff
portal is not an admin portal. Look at the "Choosing between neighbours" table in the industry
reference — most new-template requests are answered there.

**Could it extend one?** If your domain is another template plus a few entities, it is a child.
`hospital` adds four models to `clinic` and restates nothing. That is the normal shape for a new
template, not the exception.

**Is it an industry, or one customer?** A template is a starting point for many products. If it
encodes one organization's process, one country's regulations or one vendor's API, it belongs in
that product, not here.

## The layout

A template is a directory under `templates/` with a `template.json` and a `files/` tree that is
overlaid onto `_base`:

```
templates/clinic/
  template.json                    id + conditional paths
  files/
    prisma/schema/10-clinic.prisma            models
    packages/product-domain/src/clinic.ts     permissions + role map
    packages/product-domain/src/index.ts      aggregator  ← overridden
    packages/shared-types/src/index.ts        API shapes
    apps/admin/src/lib/resources-clinic.ts    screens
    apps/admin/src/lib/resources.ts           aggregator  ← overridden
    apps/api/src/modules/product/clinic/
      clinic.service.ts
      clinic.controller.ts.hbs
      clinic.module.ts
      tenant-isolation.spec.ts
    apps/api/src/modules/product/product.module.ts   aggregator  ← overridden
```

Later layers override earlier ones. Almost every file a template ships is **additive** — a new
Prisma fragment, a new module folder — and exactly three are **aggregators** it overrides. Each
aggregator is a list of imports naming every layer in the chain.

That is the whole inheritance mechanism. `hospital` restates no patient field: it adds its folder
and re-lists the chain, and the clinic files arrive from the layer beneath untouched.

## Templates are generated

`templates/` is **build output**. The source is `scripts/template-specs.mjs`.

This is deliberate, and the argument is the one the framework makes everywhere else: what differs
per industry is the domain, and what must not differ is the tenant scope, the audit trail, the
permission wiring and the isolation test. Generating the second category means there is one
correct version of it rather than twenty-four copies that were correct on the day they were
written.

So the workflow is:

```bash
# 1. Add or edit an entry in scripts/template-specs.mjs
# 2. Regenerate everything derived from it
node scripts/scaffold-industry-templates.mjs   # the file trees
node scripts/sync-template-registry.mjs        # the manifests
node scripts/sync-industry-reference.mjs       # the docs

# 3. Check it
npx trustos validate-template clinic
npx trustos new clinic --name scratch --dry-run
```

Editing a generated file directly is a change the next regeneration discards. If you find yourself
wanting to, the thing you want probably belongs in the spec — or in `_base`, if every template
needs it.

## Writing a spec entry

```js
{
  id: 'clinic',
  displayName: 'TrustOS Clinic',
  category: 'health',
  status: 'experimental',
  owner: 'TrustOS Health Team',
  description: 'One paragraph. What it models, in plain terms.',
  modules: [...SDK, 'financial-core'],
  outOfScope: ['clinical decision support', 'HL7 and FHIR', /* ... */],
  migrationNotes: 'What a maintainer must know. Why the model is shaped this way.',
  entities: [
    {
      name: 'Patient',
      label: 'Patients',
      singular: 'Patient',
      description: 'A person receiving care. Contact fields sit behind their own permission.',
      fields: [
        { name: 'patientNumber', type: 'text', label: 'Patient no.',
          required: true, unique: true, immutable: true, search: true, prefix: true },
        { name: 'phone', type: 'phone', label: 'Phone', pii: true },
        { name: 'status', type: 'enum:PatientStatus', label: 'Status',
          default: 'ACTIVE', filter: true },
      ],
      enums: { PatientStatus: ['ACTIVE', 'INACTIVE', 'DECEASED'] },
    },
  ],
}
```

### Field types

| Type                                     | Prisma                       | TypeScript                |
| ---------------------------------------- | ---------------------------- | ------------------------- |
| `text` `longtext` `slug` `email` `phone` | `String`                     | `string`                  |
| `int`                                    | `Int`                        | `number`                  |
| `money`                                  | `Decimal @db.Decimal(28, 8)` | `string`                  |
| `bool`                                   | `Boolean`                    | `boolean`                 |
| `date`                                   | `DateTime @db.Date`          | `Date`                    |
| `datetime`                               | `DateTime`                   | `Date`                    |
| `json`                                   | `Json`                       | `Record<string, unknown>` |
| `enum:Name`                              | the enum                     | a union                   |
| `ref:Entity`                             | `String`                     | `string`                  |

### Field flags

| Flag        | Effect                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| `required`  | Non-null in Prisma, required in the create input                              |
| `default`   | Non-null with a database default; optional in the create input                |
| `unique`    | `@@unique([organizationId, field])` — scoped, so two tenants may share a code |
| `immutable` | Absent from the update schema entirely                                        |
| `filter`    | An index and a declared filter                                                |
| `search`    | Included in the free-text search                                              |
| `prefix`    | Searched with `startsWith` rather than `contains` — right for a reference     |
| `pii`       | Its own `*.pii.read` permission; the column is projected away without it      |
| `sensitive` | Never returned, never logged, never audited                                   |

## The rules

These are what a reviewer checks, and most of them `trustos validate-template` checks first.

**1. Reuse the framework. Never reimplement it.** Auth, RBAC, tenancy, audit, workflow, ledger,
limits and the SDK already exist. A template that writes its own permission check has written a
second, worse one that will disagree with the first.

**2. Every model carries `organizationId`.** A model without it cannot be scoped, so every query
over it returns every tenant's rows — and nothing fails. The validator refuses it.

**3. No float, no Int, for money.** `Decimal @db.Decimal(28, 8)`, or an integer minor-unit column
with a `///` comment saying so. A float accepts every value, agrees with every test, and disagrees
with the counterparty once in ten thousand transactions.

**4. Every write is audited.** A change with no audit row is a change nobody can answer questions
about six months later, and the question always arrives at the worst moment.

**5. Personal data gets its own permission.** An operator who can work a record usually has no
business reading the identity behind it. Mark the fields `pii` and the SDK does the rest — the
column is projected away server-side, not hidden in CSS.

**6. Permission keys are permanent.** Add freely, never rename. A renamed key silently revokes
access on every deployment that has not been migrated and grants it on none.

**7. Declare every module you use, and its prerequisites.** A manifest naming `wallet` without
`ledger` generates an application whose wallet cannot compute a balance — and it fails on the
first request, in a project nobody has opened yet. The schema refuses it.

**8. State what you do not do.** `outOfScope` is a commitment. A template that grows a payment
provider stops being reusable by the deployment that has a different one.

**9. Ship the isolation test.** It is generated, so this costs nothing — but a template that
somehow lacks one fails validation, because tenant leakage is the quietest failure a generated
application can have.

**10. Decisions belong in the engine, not in a column.** If your domain has an approval, use
`@trustsystem/workflow-*` and store a `workflowInstanceId`. A status column beside a workflow is a
second source of truth about whether something was approved.

## Validation

```bash
npx trustos validate-template clinic
```

| Check                      | Fails when                                                                |
| -------------------------- | ------------------------------------------------------------------------- |
| registry metadata          | `template.json` disagrees with the registry                               |
| framework version          | The template needs a newer framework than this checkout                   |
| dependencies               | A declared module's prerequisites are missing                             |
| documentation              | The page the manifest points at does not exist                            |
| required files             | A generated app would lack a README, an `.env.example`, docs              |
| safe paths                 | A path escapes the project directory                                      |
| build configuration        | No `package.json` or `tsconfig.base.json`                                 |
| health endpoint            | No API composition root                                                   |
| test configuration         | No tests, or none covering tenant isolation                               |
| deployment configuration   | Railway declared with no `railway.toml`                                   |
| required modules           | A declared app ships no files                                             |
| no unresolved placeholders | A `{{variable}}` nobody declared                                          |
| no committed secrets       | A key, token or real JWT secret in a template file                        |
| valid package references   | A `@trustsystem/*` import the manifest did not declare                    |
| monetary precision         | A monetary column declared `Float`, or `Int` without saying "minor units" |
| tenant scope               | A product model with no `organizationId`                                  |

A `warn` does not block. A `fail` does.

## Testing a template

```bash
# Generate into a scratch directory against this checkout
npx trustos new clinic --name scratch --framework-path "$PWD" --force

cd scratch
npm install
npm run build
npx vitest run          # the isolation tests come with the template
```

Then read the generated `prisma/schema/` and check the models say what you meant. The generator
will produce a coherent project from an incoherent domain without complaint.

## Deprecating a template

Set `status: 'deprecated'` and `supersededBy: '<id>'`. Both, or the manifest is refused — a
deprecation notice with nowhere to go leaves the reader on the deprecated template.

A deprecated template keeps generating. An application somebody has already built on must be able
to keep upgrading, and a deprecation that blocks generation turns an upgrade into a rewrite.

## Checklist

- [ ] Checked the industry reference for something that already does this
- [ ] Considered `extends` before writing a standalone template
- [ ] Spec entry added to `scripts/template-specs.mjs`
- [ ] All three sync scripts re-run
- [ ] `trustos validate-template <id>` passes
- [ ] `trustos new <id>` generates, installs and builds
- [ ] `outOfScope` says what you are not doing, and means it
- [ ] `migrationNotes` explains the one modelling decision a maintainer would otherwise undo
- [ ] No business-specific integration, payment provider, government API, AI provider or cloud
      vendor service anywhere in it

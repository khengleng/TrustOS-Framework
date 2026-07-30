# @trustos/module-reporting

**Reporting** · v0.1.0 · experimental · owned by TrustOS Platform Engineering

Declarative report definitions with filtering, pagination, CSV export, a PDF renderer port and a scheduled-report interface.

```bash
trustos add-module reporting --path ../my-app --framework-path .
```

Declarative report definitions with filtering, pagination, CSV export, a PDF renderer
port and a scheduled-report interface. The module owns filtering, pagination, export
and audit; the application owns the data.

```ts
reports.register({
  id: 'payouts',
  name: 'Payouts',
  description: 'Payouts in the period.',
  permission: 'payments.report.read',
  columns: [{ key: 'reference', label: 'Reference', type: 'string' }],
  filters: [{ key: 'from', label: 'From', type: 'date', required: false }],
  dataSource: createPrismaReportDataSource({
    delegate: () => scopedDelegate(prisma.payment),
    where: (filters) => (filters.from ? { createdAt: { gte: filters.from } } : {}),
  }),
});
```

## Definitions are code, not rows

A report that can be authored at runtime is a query builder, and a query builder
exposed to customers is an unbounded read of whatever the database will join.
Applications register what they are willing to expose.

Each definition names a permission of its own, _in addition to_
`reporting.report.run`. A report the caller may not read is reported as `not_found`
rather than `forbidden`, because a report id names the data it exposes.

## CSV export is a security control

`escapeCsvCell` prefixes any cell beginning `=`, `+`, `-`, `@`, tab or a line break
with an apostrophe. `=cmd|' /c calc'!A1` in a CSV opened in Excel is code execution
on the machine of whoever opened it, and the cell contents are customer data — a
merchant name, a description. Quoting follows RFC 4180.

Column order comes from the definition, not from the shape of the first row: a row
missing an optional field would otherwise shift every later column, which is the kind
of corruption nobody notices until a reconciliation fails.

An export larger than the configured ceiling is **refused, not truncated**. A partial
export that looks complete is how a reconciliation ends up short by exactly the rows
nobody knew were missing.

## Schedules, without a scheduler

The module computes when a report should next run and stores it. It runs nothing —
adding a scheduler would mean a timer in a library imported into request-handling
processes, or a queue the framework keeps out of scope. Call `dueSchedules` from a
platform cron or a worker, and `markScheduleRun` afterwards.

Frequencies are a closed set rather than cron expressions, because every field of
cron is a way to write something that never fires — `0 0 31 2 *` runs on the 31st of
February. A monthly schedule set for the 31st is clamped to the last day of a short
month, so a month-end report does not silently skip February.

## Permissions

| Key                         | Description                             | Suggested roles                                      |
| --------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `reporting.report.read`     | List report definitions.                | organization_owner, administrator, operator, auditor |
| `reporting.report.run`      | Run a report and page through its rows. | organization_owner, administrator, operator, auditor |
| `reporting.report.export`   | Export a report to a file.              | organization_owner, administrator                    |
| `reporting.schedule.read`   | View scheduled reports.                 | organization_owner, administrator, operator, auditor |
| `reporting.schedule.manage` | Create or remove a scheduled report.    | organization_owner, administrator                    |

Nothing grants these. Seed them onto roles in the application; a module that could
grant its own permissions would be a privilege-escalation path in a package.

## Routes

| Route                           | Permission                  |
| ------------------------------- | --------------------------- |
| `GET /reports`                  | `reporting.report.read`     |
| `GET /reports/schedules`        | `reporting.schedule.read`   |
| `POST /reports/schedules`       | `reporting.schedule.manage` |
| `DELETE /reports/schedules/:id` | `reporting.schedule.manage` |
| `GET /reports/:id`              | `reporting.report.read`     |
| `POST /reports/:id/run`         | `reporting.report.run`      |
| `POST /reports/:id/export`      | `reporting.report.export`   |

## Configuration

Application-wide defaults go in `apps/api/src/modules/module-config.ts`. Every field
has a safe default, so the module works with none, and every field is validated when
the application starts. Per-organization overrides go through the SDK's tenant
settings and are validated by the same schema.

| Environment variable        | Purpose                          |
| --------------------------- | -------------------------------- |
| `REPORTING_MAX_EXPORT_ROWS` | Row ceiling for a single export. |

### Feature flags

- `reporting.export.pdf` (default off) — Offer PDF export. Off until a renderer is wired in.

## Database

- `prisma/schema/24-reporting.prisma` — ReportSchedule table.

The module ships the fragment; `npm run db:migrate` in the application generates the
SQL against its real schema.

## Extension points

| Port                  | Purpose                                                                                                                         | Ships                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ReportDataSource`    | Supplies the rows for one report definition. Applications register their own; the module owns filtering, pagination and export. | `createPrismaReportDataSource`, `createStaticReportDataSource` |
| `PdfRenderer`         | Interface only. The shipped implementation refuses with a clear message rather than producing an empty file.                    | `UnavailablePdfRenderer`                                       |
| `ReportScheduleStore` | Where schedules live. The module computes the next run time; the application decides what triggers it.                          | `PrismaReportScheduleStore`                                    |

## Depends on

None.

## Out of scope

- Charts and visualisations
- A PDF rendering implementation — implement `PdfRenderer`
- A scheduler runtime (cron, Redis, Kafka)
- Ad-hoc query building by end users

Each of these is a product decision with operational consequences. The extension
point is the seam; the decision is yours.

## Tests

```bash
npx vitest run packages/modules/reporting
```

Unit, tenant isolation, RBAC where this module makes its own authorization decisions,
configuration validation and lifecycle. Isolation tests drive the Prisma store over
`FakeModelDelegate`, so they exercise `@trustos/tenancy` rather than a test double.

## Changes

### 0.1.0

Initial release.

## See also

- `AGENTS.md` — the invariants in this module that must not be weakened
- `docs/modules.md` — the module system
- `docs/module-development.md` — writing one
- `docs/module-versioning.md` — what counts as a breaking change

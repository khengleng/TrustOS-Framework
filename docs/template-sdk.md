# Template SDK

`@trustos/template-sdk` is what every industry template is built out of: navigation, forms,
tables, filters, search, pagination, dashboards, charts, CRUD, uploads and notifications.

Two decisions shape all of it.

**It is headless.** No React, no charting library, no storage client, no HTTP client. A template
generates a NestJS API _and_ a Next.js admin from one dependency tree, and anything importing a
renderer is unusable in half of it. What the SDK ships is descriptors — a table, a form, a filter
set — plus the pure logic that operates on them.

**It reuses the framework rather than restating it.** Validation primitives come from
`@trustos/validation`, errors from `@trustos/errors`, permission keys are the ones `@trustos/rbac`
enforces, and a monetary value is a string on its way to `@trustos/financial-core`. The SDK adds
the layer above those — where a screen, an endpoint and a permission have to agree — and nothing
below it.

## The problem it exists to solve

Three bugs recur in every admin console ever built, and all three come from describing one thing
twice:

- a field added to the form and forgotten in the table;
- a filter offered by the UI and not allowed by the API;
- a column hidden with CSS while the value is still in the payload.

There is one description here, and **the server reads it first**. That last point is the one worth
internalising: `visibleColumns` and `pickColumns` are meant to run on the server, before the
response is built. A column permission enforced only in the browser is a disclosure with a spinner
in front of it.

## Architecture

```
                    ┌──────────────────────────────┐
                    │        ResourceDefinition     │   one declaration
                    │  table · form · filters ·     │
                    │  search · permissions         │
                    └───────────────┬──────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐          ┌────────────────┐          ┌────────────────┐
│  NestJS API   │          │  Next.js admin │          │  Mini app      │
│               │          │                │          │                │
│ assertCan     │          │ RESOURCES      │          │ fetchMenu      │
│ buildListQuery│          │ filterNavigation│         │ filterNavigation│
│ buildListResp │          │ table columns  │          │ menu entries   │
└───────────────┘          └────────────────┘          └────────────────┘
        │
        ▼
   Prisma where / orderBy / skip / take
```

Nothing in the SDK touches a database. `buildListQuery` returns the _arguments_ for a query the
template runs itself, because the moment an SDK owns the query it owns the tenant scope — and a
tenant scope applied by a shared library a template can forget to configure is worse than one the
template writes on every call and a test proves.

## The twelve areas

| Area          | Key exports                                                  | The failure it prevents                            |
| ------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Navigation    | `filterNavigation`, `findActiveItem`, `breadcrumbsFor`       | A menu showing screens the API will refuse         |
| Forms         | `buildFormSchema`, `buildUpdateSchema`, `redactSensitive`    | A form and a DTO that disagree                     |
| Validation    | derived from the form; primitives from `@trustos/validation` | Two descriptions of one rule                       |
| Tables        | `visibleColumns`, `pickColumns`, `resolveSort`               | A hidden column still in the payload               |
| Pagination    | `buildOffsetPage`, `buildCursorPage`                         | A sync job skipping a record at a page boundary    |
| Filters       | `parseFilters`, `toPrismaWhere`                              | A caller filtering on `passwordHash`               |
| Search        | `normalizeSearchTerm`, `toSearchWhere`                       | A free-text box searching a column holding a token |
| Dashboards    | `visibleWidgets`, `interpretTrend`                           | A number computed, sent, and hidden in the browser |
| Charts        | `fillSeriesGaps`, `toSeries`, `dailyRange`                   | "We sold nothing" drawn as "we have no data"       |
| CRUD          | `assertCan`, `buildListQuery`, `buildListResponse`           | An unguarded write nobody chose                    |
| File upload   | `assertUploadAllowed`, `sniffContentType`, `safeFilename`    | An HTML file named `photo.jpg`                     |
| Notifications | `notificationTemplateSchema`, `buildNotification`            | An OTP in a delivery provider's dashboard          |

## Worked example

One resource, read by the API and the admin:

```ts
import {
  buildListQuery,
  buildListResponse,
  assertCan,
  type ResourceDefinition,
} from '@trustos/template-sdk';

export const ORDERS: ResourceDefinition = {
  key: 'orders',
  label: 'Orders',
  singular: 'Order',
  endpoint: '/orders',
  table: {
    key: 'orders',
    label: 'Orders',
    endpoint: '/orders',
    defaultSort: { key: 'placedAt', direction: 'desc' },
    columns: [
      { key: 'reference', label: 'Reference', sortable: true },
      { key: 'total', label: 'Total', format: 'money', currencyKey: 'currency' },
      // Only visible to a role holding the permission — enforced by the projection below.
      { key: 'margin', label: 'Margin', format: 'money', permission: 'ecommerce.order.margin.read' },
    ],
  },
  filters: [
    { key: 'status', label: 'Status', type: 'enum', operators: ['eq', 'in'], options: [...] },
  ],
  search: { fields: [{ key: 'reference', label: 'Reference', prefixOnly: true }] },
  permissions: {
    list: 'ecommerce.order.read',
    read: 'ecommerce.order.read',
    create: 'ecommerce.order.create',
    update: 'ecommerce.order.update',
  },
};
```

In the controller:

```ts
async list(query: ListRequest, actor: Actor) {
  const can = permissionsFrom(actor.permissions);

  assertCan(ORDERS, 'list', can);

  const args = buildListQuery(ORDERS, query, {
    can,
    // Applied last, so a filter on the same field cannot displace it.
    scope: { organizationId: actor.organizationId, deletedAt: null },
  });

  const [rows, total] = await Promise.all([
    this.prisma.order.findMany(args),
    this.prisma.order.count({ where: args.where }),
  ]);

  // Projects away every column the actor may not see. This is the step that makes a column
  // permission a control rather than a rendering hint.
  return buildListResponse(ORDERS, rows, total, query.page, can);
}
```

In the admin, the same `ORDERS` drives the table and the menu entry. There is no second list.

## Two rules that are easy to get wrong

**People get offset pagination, machines get cursor pagination.** Offset is what an admin table
wants — jump to page 7, see "340 results" — and it is wrong under concurrent writes: a row
inserted while you page shifts everything down and you see a record twice. For a list a person is
reading, that is cosmetic. For a settlement export, a record skipped at a page boundary is money
that went missing. A template paging a financial file with `page=2` is a bug a reviewer should
catch on sight.

**`fillGaps` is a claim about the data, not a rendering preference.** A daily revenue chart with
no orders on Sunday has two honest renderings: a line dropping to zero, or a line skipping the
day. They mean "we sold nothing" and "we have no data", and the wrong one turns a closed shop into
a crisis or an outage into a quiet weekend.

## Customization guide

Everything is data, so customizing is editing a declaration:

- **Add a column** — one entry in `table.columns`. Give it a `permission` if it carries anything
  the whole team should not see.
- **Add a filter** — one entry in `filters`. A field not listed there cannot be filtered, which is
  the point; `parseFilters` refuses an undeclared key by name.
- **Add a screen** — one `ResourceDefinition` and one line in the template's resource array.
- **Change what a role can do** — the permission keys in the template's `product-domain` package,
  and the role map beside them. Never rename a key: a renamed key silently revokes access on every
  deployment that has not been migrated.

## Extension guide

| Extend                             | How                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A field type the SDK does not have | Add a `FieldType` case in `forms.ts` with its zod mapping. Every consumer picks it up.                                                                                              |
| A filter operator                  | Add it to `FilterOperator`, to `OPERATORS_BY_TYPE`, and to `toPrismaWhere`. All three, or a caller gets an operator the translator drops.                                           |
| A different query engine           | Replace `toPrismaWhere` and `toSearchWhere`. Everything above them is engine-agnostic.                                                                                              |
| Real search                        | Replace `toSearchWhere` with a call into your index. `SearchDefinition` still declares what is searchable.                                                                          |
| A chart renderer                   | Consume `ChartSpec`. The SDK never renders.                                                                                                                                         |
| A storage backend for uploads      | Keep `assertUploadAllowed` and `assertContentMatches`; write your own put/get. `safeFilename` is not a storage key — prefix it with an id, or one tenant overwrites another's file. |
| A notification transport           | Consume `BuiltNotification`. The SDK never sends.                                                                                                                                   |
| Permissions from somewhere else    | `PermissionCheck` is a function. Back it with anything.                                                                                                                             |

## What it deliberately is not

- Not a UI library. No components, no styles, no icon set.
- Not an ORM. No queries, no transactions, no tenant scope of its own.
- Not a search engine. `contains` across declared columns, and it says so.
- Not a charting library. Specs in, nothing rendered.
- Not a storage or delivery client. Policies and checks, no I/O.

Each of those is a seam a deployment fills, and a template that filled one for everybody would be
a template only one deployment can use.

# @trustos/module-search

**Search** · v0.1.0 · experimental · owned by TrustOS Platform Engineering

Global search across registered module adapters, with permission filtering, tenant verification, ranking and pagination. Database-backed; no external engine.

```bash
trustos add-module search --path ../my-app --framework-path .
```

Global search across registered adapters, with permission filtering, tenant
verification, ranking and pagination. Database-backed; no external engine and no
index.

```ts
search.register(
  createPrismaSearchAdapter({
    id: 'merchants',
    label: 'Merchants',
    permission: 'merchant.merchant.read',
    delegate: () => prisma.merchant,
    fields: ['name', 'reference'],
    titleField: 'name',
  }),
);

const results = await search.search({ term: 'coffee' }, organizationId, actor.permissions);
```

## Authorization is the source list

An adapter the caller cannot read is **never queried**, so a hit they should not see
is never produced. Filtering after the fact would be one refactor away from leaking.

Asking for a named source the caller cannot read gives the same answer as asking for
one that does not exist, so naming a source is not a way to discover which exist.

## Tenant verification

Adapters receive the organization and are responsible for scoping —
`createPrismaSearchAdapter` does it through the framework's scoped delegate. The
service verifies every hit anyway: one from another organization is dropped, audited
as `search.result.dropped`, and logged. An adapter returning foreign rows is a defect
that has to surface somewhere.

## Ranking and pagination

Rank, then paginate. The other order returns the most relevant results on an
arbitrary page. `weightedRanker` scores an exact title match above a prefix match
above a substring, then by how many fields matched; ties break on source and id, so
the order is stable — an unstable ranking returns the same row on two pages and skips
another.

## The term is audited; the results are not

Searching for a person's name is exactly what an insider-threat review asks about,
and a trail recording only "a search happened" cannot answer it. The results are
never recorded: a trail of what someone found is a second copy of the data with
different access controls. An organization can turn term recording off where the term
itself is the greater risk.

## No index

Adapters query what the owning module already stores, so a hit is as current as the
row. An index would be a second copy of customer data to keep tenant-correct, and
keeping two copies correct is harder than querying one. This module owns no tables.

## Permissions

| Key                    | Description                                          | Suggested roles                                      |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `search.query.execute` | Run a global search.                                 | organization_owner, administrator, operator, auditor |
| `search.source.read`   | List the searchable sources available to the caller. | organization_owner, administrator, operator, auditor |

Nothing grants these. Seed them onto roles in the application; a module that could
grant its own permissions would be a privilege-escalation path in a package.

## Routes

| Route                 | Permission             |
| --------------------- | ---------------------- |
| `GET /search`         | `search.query.execute` |
| `GET /search/sources` | `search.source.read`   |

## Configuration

Application-wide defaults go in `apps/api/src/modules/module-config.ts`. Every field
has a safe default, so the module works with none, and every field is validated when
the application starts. Per-organization overrides go through the SDK's tenant
settings and are validated by the same schema.

| Environment variable            | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `SEARCH_MAX_RESULTS_PER_SOURCE` | Rows requested from each adapter before merging and ranking. |

### Feature flags

- `search.ranking.weighted` (default on) — Rank by field weight and match position rather than by source order.

## Database

_None. This module owns no tables._

The module ships the fragment; `npm run db:migrate` in the application generates the
SQL against its real schema.

## Extension points

| Port            | Purpose                                                                                                                                  | Ships                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `SearchAdapter` | One searchable source. Declares the permission a caller needs, and the service never returns a hit from a source the caller cannot read. | `createPrismaSearchAdapter`, `createStaticSearchAdapter` |
| `Ranker`        | Scores and orders merged hits.                                                                                                           | `weightedRanker`, `sourceOrderRanker`                    |

## Depends on

None.

## Out of scope

- Elasticsearch and OpenSearch — implement `SearchAdapter`
- Fuzzy matching, stemming and synonyms
- A separate search index
- Faceting and aggregations

Each of these is a product decision with operational consequences. The extension
point is the seam; the decision is yours.

## Tests

```bash
npx vitest run packages/modules/search
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

# Writing a module

Read `docs/modules.md` first for what a module is. This is how to write one.

## The shape

```
packages/modules/<id>/
  package.json          @trustsystem/module-<id>
  tsconfig.json
  nest/package.json     subpath stub: keeps @nestjs out of non-Nest consumers
  README.md
  AGENTS.md
  install/
    prisma/schema/NN-<id>.prisma      copied into the host application
  src/
    index.ts
    config.ts                         Zod schema; must accept {}
    <domain>.ts                       the capability, framework-agnostic
    store.ts                          persistence ports + Prisma implementation
    <id>.service.ts                   orchestration, audit, tenant checks
    <id>.module.ts                    defineModule + create()
    <id>.spec.ts                      unit, isolation, RBAC, config tests
    nest/
      tokens.ts
      <id>.controller.ts              routes, permissions, Zod validation, OpenAPI
      <id>.nest-module.ts             forRoot(binding)
      index.ts
```

## The declarations live in the catalog

A module's permissions, routes, audit events, migrations, feature flags and
environment variables are declared in `packages/module-registry/src/catalog.ts`, not
in the module package. The module reads its own entry:

```ts
export const notificationModule = defineModule<NotificationConfig>({
  ...moduleDeclarations('notification'),
  configSchema: notificationConfigSchema,
  tenantScoped: true,
  create: (context) => createNotification(context),
});
```

Two reasons, both about review rather than convenience:

1. **The CLI can read the catalog without executing a module.** `add-module` needs a
   module's permissions and migrations to install it. Taking them from data means
   the installer never imports module code, so nothing a module could do at import
   time runs during an install.

2. **Collisions between modules are impossible to miss.** Two modules claiming
   `GET /reports`, or both defining `document.read`, would be reviewed in two
   different files by two different people. In the catalog they are twelve lines
   apart, and it refuses to load.

`defineModule` re-validates everything it receives, so a module cannot widen its own
surface by editing its source — only by editing the catalog, which is where a
security reviewer looks.

## Adding a module, step by step

### 1. Add the catalog entry

```ts
{
  metadata: {
    id: 'audit-export',
    name: 'Audit Export',
    description: 'Scheduled export of the audit trail to a customer-supplied sink.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    owner: 'TrustOS Platform Engineering',
    stability: 'experimental',
    tags: ['compliance'],
  },
  packaging: {
    packageName: '@trustsystem/module-audit-export',
    directory: 'packages/modules/audit-export',
    nestModule: { className: 'AuditExportModule', importPath: '@trustsystem/module-audit-export/nest' },
  },
  permissions: [
    { key: 'audit-export.export.read', description: 'View exports.', suggestedRoles: ['auditor'] },
  ],
  routes: [
    { method: 'GET', path: '/audit-exports', permission: 'audit-export.export.read', summary: 'List exports.' },
  ],
  auditEvents: [
    { action: 'audit-export.export.created', entityType: 'AuditExport', description: 'An export was created.' },
  ],
  migrations: [
    { id: 'audit-export-init', description: 'AuditExport table.', schemaFragment: 'prisma/schema/26-audit-export.prisma' },
  ],
  environment: [{ name: 'AUDIT_EXPORT_DESTINATION', description: 'Where exports are written.' }],
  extensionPoints: [
    { name: 'Export sink', port: 'ExportSink', description: 'Where the export goes.', provided: ['LocalExportSink'] },
  ],
  outOfScope: ['Real cloud destinations', 'Encryption at rest'],
}
```

Add the id to `BUILT_IN_MODULE_IDS` in `schema.ts`. The catalog validates on import,
so `npm test` tells you immediately if the namespacing, the fragment number or a
route's permission is wrong.

### 2. Write the configuration schema

```ts
export const auditExportConfigSchema = z
  .object({
    destination: z.string().min(1).max(400).default('.trustos-exports'),
    maxRowsPerExport: z.number().int().min(1).max(1_000_000).default(100_000),
  })
  .strict();
```

Two rules, both enforced:

- **`.strict()`.** A typo in a deployment's configuration must fail loudly rather
  than leave the default silently in place.
- **`{}` must parse.** `defineModule` refuses a schema that does not, because an
  install that leaves an application unable to start puts the failure on whoever
  installed the module rather than on whoever wrote the schema. Pick safe defaults —
  a limit rather than "unlimited", off rather than on.

### 3. Write the store

Persistence goes through `ModuleRepository`, which wraps `@trustsystem/tenancy`:

```ts
export class PrismaAuditExportStore implements AuditExportStore {
  private readonly exports: ModuleRepository<AuditExportRow>;

  constructor(context: ModuleContext<AuditExportConfig>) {
    this.exports = new ModuleRepository(context.prisma, 'auditExport', context.moduleId);
  }
}
```

Do not write raw queries and do not take a `where` clause from a caller. The scope is
structural: a `ModuleRepository` has no method that can read outside the active
organization, which is what makes the isolation tests short.

### 4. Write the service

```ts
async create(input: CreateExportInput, organizationId: string): Promise<AuditExportRow> {
  const config = await this.context.resolveConfig(organizationId);   // tenant overrides applied
  const row = await this.store.create({ ... });

  await this.context.audit.record({
    action: 'audit-export.export.created',
    entityType: 'AuditExport',
    entityId: row.id,
    organizationId,
    after: { rows: row.rowCount },      // metadata, never the exported content
  });

  return row;
}
```

Conventions that matter:

- `organizationId` is a **parameter**, never something the service reaches for. A
  background job and an HTTP request then take the same code path.
- Do not pass `actorId` for audit attribution — `AuditService` fills it in from the
  ambient request context. Pass it only where the module _uses_ it as a business
  input, as `workflow` does for separation of duties.
- Audit every mutation, with `before` **snapshotted before the write**. Reading the
  previous values afterwards makes the record depend on the store returning a
  detached object, which no store guarantees.
- Never put customer content in an audit record. Sizes, checksums, counts, ids and
  filters — yes. Message bodies, document contents, search results — no. An audit
  trail is read by more people than the data was addressed to.
- Use `context.clock()`, never `new Date()`. Tests need a clock they can move.

### 5. Write the Nest layer

```ts
@Controller('audit-exports')
export class AuditExportController {
  @Get()
  @RequirePermissions('audit-export.export.read')
  @ApiOperation({ summary: 'List exports.' })
  list(@OrganizationId() organizationId: string): Promise<AuditExportRow[]> { ... }
}
```

- One `@RequirePermissions` per route, matching the catalog. `PermissionsGuard`
  denies a route that declares none, so there is no accidentally public endpoint.
- `@OrganizationId()` reads what the tenant guard derived from the access token.
  Never take an organization id from a request body.
- Validate every body and query with `ZodValidationPipe`.
- `@ApiTags` / `@ApiOperation` on everything, so the module appears in the
  application's OpenAPI document.

### 6. Write the tests

Five kinds are required, and CI checks that each module has them:

| Kind                     | What it must show                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit                     | The capability works: the state machine, the rendering, the bucketing                                                                            |
| Tenant isolation         | Another organization's rows are `not_found`, writes are refused, audit is attributed correctly, and it fails closed with no tenant context       |
| RBAC                     | Where the module makes authorization decisions of its own — search filtering by permission, workflow separation of duties — those decisions hold |
| Configuration validation | `{}` parses, an unknown key is rejected, and an out-of-range value is refused                                                                    |
| Lifecycle                | It refuses to start without what it needs, and its health indicator reports the right thing                                                      |

Isolation tests drive the **Prisma-backed store over `FakeModelDelegate`**, not a
hand-written in-memory store. That exercises `scopedDelegate` — the framework's
actual isolation mechanism — rather than testing a test double against itself.

```ts
const prisma = { auditExport: new FakeModelDelegate([...]) };
const { context, audit } = createTestModuleContext(auditExportModule, { prisma });

const asAcme = <T>(fn: () => Promise<T>) =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);
```

### 7. Register it in the wiring

Add the module to `packages/modules/all-modules.spec.ts` and
`packages/modules/nest-wiring.spec.ts`. The first proves it can be registered
alongside the others without colliding; the second boots a real Nest application and
checks that its routes map and its lifecycle runs.

Add the package to `tsconfig.base.json` paths, `tsconfig.build.json` references,
`vitest.config.ts` aliases (both the root and the `/nest` subpath, subpath first),
and `eslint.config.mjs` `MODULE_PACKAGES`.

## Rules

Restated because they are the ones that get broken under deadline:

1. **Never duplicate framework functionality.** Tenant scoping is
   `@trustsystem/tenancy`. Audit is the audit port. Validation is Zod through
   `@trustsystem/validation`. Errors are `ApiError`. Health is `HealthIndicator`. If you
   are about to write one of these, you are about to write a second implementation
   that will diverge.
2. **Reuse the SDK.** `ModuleRepository`, `createModuleContext`,
   `moduleHealthIndicator`, `createTestModuleContext`, `RecordingAuditPort`.
3. **No `process.env`.** Everything arrives through `ModuleContext`. ESLint enforces
   this.
4. **No timers.** A module that starts an interval keeps running in a process meant
   to serve one request, and runs twice in an application that imported it twice.
   Expose `processQueue`/`runEscalations`/`dueSchedules` and let the application
   decide what triggers them.
5. **No cross-module imports except through declared dependencies.** `document`
   depends on `file-storage` and says so in the catalog.
6. **Preserve compatibility.** See `docs/module-versioning.md`.

## Checklist

- [ ] Catalog entry added; id in `BUILT_IN_MODULE_IDS`
- [ ] `configSchema` is `.strict()` and accepts `{}`
- [ ] Every route has a permission the module declares
- [ ] Every mutation is audited, with no customer content in the record
- [ ] Persistence is `ModuleRepository` only
- [ ] Isolation tests use `FakeModelDelegate` through the Prisma store
- [ ] Configuration validation tests present
- [ ] Lifecycle refuses to start without its dependencies
- [ ] `README.md` and `AGENTS.md` written
- [ ] Added to `all-modules.spec.ts` and `nest-wiring.spec.ts`
- [ ] Monorepo config updated (tsconfig ×2, vitest, eslint)
- [ ] `npm test && npm run build:packages && npm run lint` clean

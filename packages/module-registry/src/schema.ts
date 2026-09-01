import {
  moduleAuditEventSchema,
  moduleDependencySchema,
  moduleEnvVarSchema,
  moduleExtensionPointSchema,
  moduleFeatureFlagSchema,
  moduleIdSchema,
  moduleMetadataSchema,
  moduleMigrationSchema,
  modulePermissionSchema,
  moduleRouteSchema,
} from '@trustsystem/module-sdk';
import { z } from 'zod';

/**
 * The module catalog schema.
 *
 * The catalog is the trust boundary of the module system, exactly as the
 * template registry is for the generator. Two consequences follow from that,
 * and they are the reason this file exists rather than each module package
 * declaring its own surface:
 *
 *   1. **The CLI can read it without executing a module.** `trustos add-module`
 *      needs to know a module's permissions, routes, migrations and environment
 *      variables to install it. Getting them from data means the installer never
 *      imports module code, so nothing a module could do at import time runs
 *      during an install.
 *
 *   2. **Collisions between modules are impossible to miss.** Two modules that
 *      both claimed `GET /reports` or both defined `document.read` would be
 *      reviewed in two different files and merged by two different people. Here
 *      they are twelve lines apart and the catalog refuses to load.
 *
 * Module packages import their own entry through `moduleDeclarations()` and pass
 * it to `defineModule`, which re-validates it. There is one declaration of each
 * permission, route and flag in the repository.
 */

/** Where the module lives, so the installer can find its `install/` tree. */
export const modulePackagingSchema = z
  .object({
    /** npm package name, added to a host application's dependencies. */
    packageName: z
      .string()
      .regex(/^@trustsystem\/module-[a-z][a-z0-9-]*$/, 'Must be @trustsystem/module-<id>.'),
    /** Path from the framework root, e.g. `packages/modules/notification`. */
    directory: z
      .string()
      .regex(/^packages\/modules\/[a-z][a-z0-9-]*$/, 'Must be packages/modules/<id>.'),
    /**
     * The Nest module class a host application imports, and the specifier it
     * comes from. The installer generates the wiring from these, so an
     * application never hand-writes a module import that could drift.
     */
    nestModule: z
      .object({
        className: z.string().regex(/^[A-Z][A-Za-z0-9]*Module$/, 'Must be a PascalCase *Module.'),
        importPath: z.string().min(1).max(120),
      })
      .strict(),
  })
  .strict();

export type ModulePackaging = z.infer<typeof modulePackagingSchema>;

export const moduleCatalogEntrySchema = z
  .object({
    metadata: moduleMetadataSchema,
    packaging: modulePackagingSchema,
    dependencies: z.array(moduleDependencySchema).default([]),
    permissions: z.array(modulePermissionSchema).default([]),
    auditEvents: z.array(moduleAuditEventSchema).default([]),
    routes: z.array(moduleRouteSchema).default([]),
    migrations: z.array(moduleMigrationSchema).default([]),
    featureFlags: z.array(moduleFeatureFlagSchema).default([]),
    environment: z.array(moduleEnvVarSchema).default([]),
    extensionPoints: z.array(moduleExtensionPointSchema).default([]),
    /** Capabilities deliberately excluded, echoed into the generated docs. */
    outOfScope: z.array(z.string().min(1).max(160)).default([]),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const id = entry.metadata.id;

    // The same namespacing `defineModule` enforces, applied here so a catalog
    // mistake is caught by `npm test` and not only when the module is imported.
    for (const permission of entry.permissions) {
      if (!permission.key.startsWith(`${id}.`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `permission "${permission.key}" must start with "${id}.".`,
        });
      }
    }

    const declared = new Set(entry.permissions.map((permission) => permission.key));
    for (const route of entry.routes) {
      if (!declared.has(route.permission)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `route ${route.method} ${route.path} requires undeclared permission "${route.permission}".`,
        });
      }
    }

    if (entry.packaging.packageName !== `@trustsystem/module-${id}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `packaging.packageName must be "@trustsystem/module-${id}".`,
      });
    }
    if (entry.packaging.directory !== `packages/modules/${id}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `packaging.directory must be "packages/modules/${id}".`,
      });
    }
  });

export type ModuleCatalogEntry = z.infer<typeof moduleCatalogEntrySchema>;

export const moduleCatalogSchema = z.array(moduleCatalogEntrySchema).min(1);

/**
 * Ids of the modules the framework ships. Used by the CLI for `--help`.
 *
 * Grouped by what they are for rather than alphabetically: the capability modules a product
 * chooses between, then the integration layer, which is infrastructure a product composes with
 * rather than an alternative to any of the others.
 */
export const BUILT_IN_MODULE_IDS = [
  // Capabilities.
  'notification',
  'document',
  'workflow',
  'reporting',
  'search',
  'feature-flags',
  'file-storage',

  // The integration layer.
  'events',
  'webhook',
  'jobs',
  'scheduler',
  'adapter',
  'import',
  'export',
  'sync',

  // The AI platform. `rag` and `agent` both depend on `ai`, so the order is also the install
  // order.
  'ai',
  'rag',
  'agent',

  // The financial platform. Everything depends on `ledger`, so the order is also the install
  // order.
  'ledger',
  'wallet',
  'transactions',
  'settlement',
  'reconciliation',
] as const;

export type BuiltInModuleId = (typeof BUILT_IN_MODULE_IDS)[number];

export const builtInModuleIdSchema = z.enum(BUILT_IN_MODULE_IDS);

/** Re-exported so consumers validate ids without depending on the SDK. */
export { moduleIdSchema };

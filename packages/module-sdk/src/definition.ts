import type { HealthIndicator } from '@trustos/observability';
import { z } from 'zod';
import {
  environmentPrefix,
  moduleAuditEventSchema,
  moduleEnvVarSchema,
  moduleExtensionPointSchema,
  moduleFeatureFlagSchema,
  moduleMigrationSchema,
  modulePermissionSchema,
  moduleRouteSchema,
  type ModuleAuditEvent,
  type ModuleEnvVar,
  type ModuleExtensionPoint,
  type ModuleFeatureFlag,
  type ModuleMigration,
  type ModulePermission,
  type ModuleRoute,
} from './contracts';
import type { ModuleConfigSchema, ModuleContext } from './context';
import {
  moduleDependencySchema,
  moduleMetadataSchema,
  type ModuleDependency,
  type ModuleMetadata,
} from './metadata';

/**
 * The module contract.
 *
 * Every TrustOS module is one of these. The declarative half (metadata,
 * permissions, routes, audit events, migrations, flags) is validated at import
 * time by `defineModule`; the behavioural half is a single factory that turns a
 * `ModuleContext` into a running instance.
 *
 * Notice what a module *cannot* do: it cannot register a route without a
 * permission, cannot define a permission outside its own namespace, cannot
 * grant itself a permission, cannot read `process.env`, and cannot declare
 * itself exempt from tenant scoping. Those are not conventions — `defineModule`
 * throws.
 */

/** A module that has been created and is ready to be started. */
export interface ModuleInstance {
  readonly moduleId: string;
  /** Called once, in dependency order, before the application serves traffic. */
  initialize(): Promise<void>;
  /** Called once, in reverse dependency order, during shutdown. */
  shutdown(): Promise<void>;
  /**
   * Readiness contribution. Registered with the application's `HealthRegistry`,
   * so a module's dependency shows up in `GET /ready` beside the database.
   */
  healthIndicator(): HealthIndicator;
}

export interface TrustosModule<TConfig = unknown> {
  readonly metadata: ModuleMetadata;
  readonly dependencies: ModuleDependency[];
  /** Zod schema for the module's configuration. Must accept `{}`. */
  readonly configSchema: ModuleConfigSchema<TConfig>;
  readonly permissions: ModulePermission[];
  readonly auditEvents: ModuleAuditEvent[];
  readonly routes: ModuleRoute[];
  readonly migrations: ModuleMigration[];
  readonly featureFlags: ModuleFeatureFlag[];
  readonly environment: ModuleEnvVar[];
  readonly extensionPoints: ModuleExtensionPoint[];
  /** Always true. Present so the invariant is visible in the type, not implied. */
  readonly tenantScoped: true;
  create(context: ModuleContext<TConfig>): ModuleInstance;
}

/** What an author passes to `defineModule`. Defaults fill in the rest. */
export interface ModuleDefinitionInput<TConfig> {
  metadata: unknown;
  configSchema: ModuleConfigSchema<TConfig>;
  dependencies?: unknown[];
  permissions?: unknown[];
  auditEvents?: unknown[];
  routes?: unknown[];
  migrations?: unknown[];
  featureFlags?: unknown[];
  environment?: unknown[];
  extensionPoints?: unknown[];
  tenantScoped: true;
  create(context: ModuleContext<TConfig>): ModuleInstance;
}

export class ModuleDefinitionError extends Error {
  readonly moduleId: string;
  readonly problems: string[];

  constructor(moduleId: string, problems: string[]) {
    super(`Module "${moduleId}" is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ModuleDefinitionError';
    this.moduleId = moduleId;
    this.problems = problems;
  }
}

/**
 * Validates a module definition and returns it, or throws.
 *
 * Called at module scope in every module package, so an invalid declaration
 * fails when the package is imported — during `npm test`, during `tsc`, during
 * application start-up — and never at the moment a customer hits the route.
 */
export function defineModule<TConfig>(
  input: ModuleDefinitionInput<TConfig>,
): TrustosModule<TConfig> {
  const metadataResult = moduleMetadataSchema.safeParse(input.metadata);
  if (!metadataResult.success) {
    throw new ModuleDefinitionError('(unknown)', issuesOf(metadataResult.error));
  }

  const metadata = metadataResult.data;
  const id = metadata.id;
  const problems: string[] = [];

  const dependencies = parseAll(
    moduleDependencySchema,
    input.dependencies,
    'dependencies',
    problems,
  );
  const permissions = parseAll(modulePermissionSchema, input.permissions, 'permissions', problems);
  const auditEvents = parseAll(moduleAuditEventSchema, input.auditEvents, 'auditEvents', problems);
  const routes = parseAll(moduleRouteSchema, input.routes, 'routes', problems);
  const migrations = parseAll(moduleMigrationSchema, input.migrations, 'migrations', problems);
  const featureFlags = parseAll(
    moduleFeatureFlagSchema,
    input.featureFlags,
    'featureFlags',
    problems,
  );
  const environment = parseAll(moduleEnvVarSchema, input.environment, 'environment', problems);
  const extensionPoints = parseAll(
    moduleExtensionPointSchema,
    input.extensionPoints,
    'extensionPoints',
    problems,
  );

  // --- Tenant scoping -------------------------------------------------------
  if (input.tenantScoped !== true) {
    problems.push(
      'tenantScoped must be true. Every module handles customer data and must be organization-scoped.',
    );
  }

  // --- Namespacing ----------------------------------------------------------
  // Each of these prevents one module from silently affecting another through a
  // shared key. Permission collisions are the dangerous case: a role granted
  // `message.send` for one module would grant it for the other too.
  for (const permission of permissions) {
    if (!permission.key.startsWith(`${id}.`)) {
      problems.push(`permission "${permission.key}" must start with "${id}.".`);
    }
  }
  for (const event of auditEvents) {
    if (!event.action.startsWith(`${id}.`)) {
      problems.push(`audit action "${event.action}" must start with "${id}.".`);
    }
  }
  for (const flag of featureFlags) {
    if (!flag.key.startsWith(`${id}.`)) {
      problems.push(`feature flag "${flag.key}" must start with "${id}.".`);
    }
  }
  const envPrefix = `${environmentPrefix(id)}_`;
  for (const variable of environment) {
    if (!variable.name.startsWith(envPrefix)) {
      problems.push(`environment variable "${variable.name}" must start with "${envPrefix}".`);
    }
  }

  // --- Uniqueness -----------------------------------------------------------
  problems.push(
    ...duplicatesOf(
      permissions.map((item) => item.key),
      'permission key',
    ),
  );
  problems.push(
    ...duplicatesOf(
      auditEvents.map((item) => item.action),
      'audit action',
    ),
  );
  problems.push(
    ...duplicatesOf(
      featureFlags.map((item) => item.key),
      'feature flag key',
    ),
  );
  problems.push(
    ...duplicatesOf(
      environment.map((item) => item.name),
      'environment variable',
    ),
  );
  problems.push(
    ...duplicatesOf(
      migrations.map((item) => item.id),
      'migration id',
    ),
  );
  problems.push(
    ...duplicatesOf(
      routes.map((route) => `${route.method} ${route.path}`),
      'route',
    ),
  );

  // --- Routes ---------------------------------------------------------------
  // A route may only reference a permission this module declares. Referencing
  // one it does not own would make the module's authorization surface depend on
  // whatever else happens to be installed.
  const declaredKeys = new Set(permissions.map((permission) => permission.key));
  for (const route of routes) {
    if (!declaredKeys.has(route.permission)) {
      problems.push(
        `route ${route.method} ${route.path} requires permission "${route.permission}", which the module does not declare.`,
      );
    }
  }

  // --- Dependencies ---------------------------------------------------------
  if (dependencies.some((dependency) => dependency.moduleId === id)) {
    problems.push('a module cannot depend on itself.');
  }
  problems.push(
    ...duplicatesOf(
      dependencies.map((item) => item.moduleId),
      'dependency',
    ),
  );

  // --- Configuration --------------------------------------------------------
  // A module must be installable with no configuration at all. If `{}` does not
  // parse, then `trustos add-module` would leave an application that cannot
  // start, and the failure would land on whoever installed it rather than on
  // whoever wrote the schema.
  const emptyConfig = input.configSchema.safeParse({});
  if (!emptyConfig.success) {
    problems.push(
      `configSchema must accept {} so the module installs with safe defaults (${issuesOf(
        emptyConfig.error,
      ).join('; ')}).`,
    );
  }

  if (problems.length > 0) throw new ModuleDefinitionError(id, problems);

  return {
    metadata,
    dependencies,
    configSchema: input.configSchema,
    permissions,
    auditEvents,
    routes,
    migrations,
    featureFlags,
    environment,
    extensionPoints,
    tenantScoped: true,
    create: input.create,
  };
}

/** Permission keys a module introduces, for seeding and documentation. */
export function modulePermissionKeys(module: TrustosModule): string[] {
  return module.permissions.map((permission) => permission.key);
}

/** Audit actions a module writes, for documentation and alert rules. */
export function moduleAuditActions(module: TrustosModule): string[] {
  return module.auditEvents.map((event) => event.action);
}

// ---------------------------------------------------------------------------

function parseAll<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  values: unknown[] | undefined,
  field: string,
  problems: string[],
): z.infer<TSchema>[] {
  const parsed: z.infer<TSchema>[] = [];

  for (const [index, value] of (values ?? []).entries()) {
    const result = schema.safeParse(value);
    if (result.success) {
      parsed.push(result.data);
      continue;
    }
    for (const issue of issuesOf(result.error)) problems.push(`${field}[${index}] ${issue}`);
  }

  return parsed;
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

function duplicatesOf(values: string[], label: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return [...duplicates].map((value) => `duplicate ${label} "${value}".`);
}

import type { LoggerPort } from '@trustos/logging';
import { ApiError } from '@trustos/errors';
import { z } from 'zod';

/**
 * What the host application hands a module.
 *
 * Everything a module needs arrives through this object, and nothing else. A
 * module never reads `process.env`, never constructs its own Prisma client and
 * never imports application code — which is what makes the same module usable
 * from an API, a worker and a test without change.
 */

/**
 * The audit port.
 *
 * Deliberately narrower than `AuditService`: one method, no query side, no
 * `AuditSink`. A module needs to *write* history and has no business reading
 * it, and the narrow port means a module can be tested with a two-line fake
 * instead of a Prisma client. `AuditService` satisfies this port structurally;
 * a test in this package asserts that it still does.
 */
export interface ModuleAuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorId?: string | null;
  organizationId?: string | null;
  before?: unknown;
  after?: unknown;
}

export interface ModuleAuditPort {
  record(input: ModuleAuditInput): Promise<void>;
}

/**
 * Per-organization module settings.
 *
 * Multi-tenancy applies to configuration too: one organization sending email
 * through a different sender identity must not change what any other
 * organization sends. Overrides are stored per `(moduleId, organizationId)` and
 * are validated through the module's own config schema before use, so a stored
 * override cannot put a module into a state its schema forbids.
 */
export interface TenantSettingsStore {
  read(moduleId: string, organizationId: string): Promise<Record<string, unknown> | null>;
  write(moduleId: string, organizationId: string, settings: Record<string, unknown>): Promise<void>;
}

/** In-memory settings store. The default, and what the tests use. */
export class InMemoryTenantSettingsStore implements TenantSettingsStore {
  private readonly entries = new Map<string, Record<string, unknown>>();

  private key(moduleId: string, organizationId: string): string {
    return `${moduleId}::${organizationId}`;
  }

  read(moduleId: string, organizationId: string): Promise<Record<string, unknown> | null> {
    return Promise.resolve(this.entries.get(this.key(moduleId, organizationId)) ?? null);
  }

  write(
    moduleId: string,
    organizationId: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    this.entries.set(this.key(moduleId, organizationId), { ...settings });
    return Promise.resolve();
  }
}

/**
 * The shape a module needs from a Prisma client: model delegates looked up by
 * name. Loose on purpose — the framework's client and an application's client
 * are generated from different schemas and are not structurally assignable to
 * one another, so naming the capability keeps a module usable with either.
 */
export type PrismaLike = object;

/**
 * A module's configuration schema.
 *
 * The input type is `unknown` rather than the output type, because a schema with
 * defaults accepts less than it produces — `z.ZodType<TConfig>` would force the
 * two to match and reject every schema that has a default. Input is untrusted
 * anyway: it arrives from an application's configuration or from a stored tenant
 * override.
 */
export type ModuleConfigSchema<TConfig> = z.ZodType<TConfig, z.ZodTypeDef, unknown>;

/** The environment the host is running in. Modules use it for flag scoping. */
export type ModuleEnvironment = 'development' | 'test' | 'production';

export interface ModuleContext<TConfig> {
  readonly moduleId: string;
  /** Validated module configuration, with the schema's defaults applied. */
  readonly config: TConfig;
  readonly logger: LoggerPort;
  readonly audit: ModuleAuditPort;
  readonly environment: ModuleEnvironment;
  /** Injectable clock. Modules must not call `new Date()` directly. */
  readonly clock: () => Date;
  /**
   * The application's Prisma client, or null when the host has no database.
   *
   * A module whose rows live in Postgres refuses to initialize when this is
   * null, rather than silently falling back to memory and losing writes that
   * the caller was told had succeeded.
   */
  readonly prisma: PrismaLike | null;
  readonly tenantSettings: TenantSettingsStore;
  /** Base config merged with this organization's overrides, then validated. */
  resolveConfig(organizationId: string): Promise<TConfig>;
}

export interface CreateModuleContextOptions<TConfig> {
  moduleId: string;
  configSchema: ModuleConfigSchema<TConfig>;
  /** Raw configuration, from the application. Validated here, once. */
  config?: unknown;
  logger: LoggerPort;
  audit: ModuleAuditPort;
  environment?: ModuleEnvironment;
  clock?: () => Date;
  prisma?: PrismaLike | null;
  tenantSettings?: TenantSettingsStore;
}

/**
 * Builds a module context, validating configuration up front.
 *
 * Configuration is validated at construction rather than at first use, so a
 * misconfigured module fails when the application starts instead of when a
 * customer triggers the code path that reads the bad value.
 */
export function createModuleContext<TConfig>(
  options: CreateModuleContextOptions<TConfig>,
): ModuleContext<TConfig> {
  const {
    moduleId,
    configSchema,
    logger,
    audit,
    environment = 'development',
    clock = () => new Date(),
    prisma = null,
    tenantSettings = new InMemoryTenantSettingsStore(),
  } = options;

  const config = parseModuleConfig(configSchema, options.config ?? {}, moduleId);

  return {
    moduleId,
    config,
    logger,
    audit,
    environment,
    clock,
    prisma,
    tenantSettings,

    async resolveConfig(organizationId: string): Promise<TConfig> {
      if (!organizationId) {
        throw ApiError.internal(`Module "${moduleId}" resolved configuration without a tenant.`);
      }

      const override = await tenantSettings.read(moduleId, organizationId);
      if (!override || Object.keys(override).length === 0) return config;

      // A shallow merge over the *raw* input, re-validated by the module's own
      // schema. Merging validated objects would skip the schema's refinements,
      // which is precisely where a nonsensical combination would be caught.
      return parseModuleConfig(
        configSchema,
        { ...(options.config as Record<string, unknown>), ...override },
        moduleId,
        organizationId,
      );
    },
  };
}

/**
 * Parses module configuration or throws an `ApiError`.
 *
 * Config problems surface as `internal_error` with the detail in the log
 * context, never in the response body: a validation message that echoes a
 * configuration key back to a caller tells them how the server is wired.
 */
export function parseModuleConfig<TConfig>(
  schema: ModuleConfigSchema<TConfig>,
  input: unknown,
  moduleId: string,
  organizationId?: string,
): TConfig {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

  throw new ApiError('internal_error', {
    message: 'A module is misconfigured.',
    context: {
      reason: 'module_configuration_invalid',
      moduleId,
      ...(organizationId ? { organizationId } : {}),
      problems,
    },
  });
}

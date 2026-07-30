import { z } from 'zod';

/**
 * What a module declares about itself.
 *
 * Everything here is data, validated at import time. That is the point: the
 * registry, the installer, the generated documentation and the OpenAPI surface
 * are all derived from these declarations rather than discovered by reflection,
 * so "which permissions does the notification module need?" has an answer that
 * does not involve booting an application.
 */

/**
 * A permission the module introduces.
 *
 * Keys are namespaced under the module id (`notification.message.send`) and
 * enforced by `defineModule`. Without the namespace two modules could define
 * `message.send` with different meanings, and a role that granted one would
 * silently grant the other.
 */
export const modulePermissionSchema = z
  .object({
    key: z
      .string()
      .min(3)
      .max(120)
      .regex(
        /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
        'A permission key must be dot-separated lowercase segments.',
      ),
    description: z.string().min(1).max(200),
    /**
     * Roles that should receive this permission when the module is installed.
     *
     * A suggestion, not an instruction: the installer prints it and the
     * application's seed decides. Nothing in the module system can grant a
     * permission by itself, because a module that could grant its own
     * permissions would be a privilege-escalation path.
     */
    suggestedRoles: z.array(z.string().min(1).max(60)).default([]),
  })
  .strict();

export type ModulePermission = z.infer<typeof modulePermissionSchema>;

/** An audit action the module writes. Namespaced under the module id. */
export const moduleAuditEventSchema = z
  .object({
    action: z
      .string()
      .min(3)
      .max(120)
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'An audit action must be dot-separated.'),
    entityType: z.string().min(1).max(60),
    description: z.string().min(1).max(200),
  })
  .strict();

export type ModuleAuditEvent = z.infer<typeof moduleAuditEventSchema>;

export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * An HTTP route the module exposes.
 *
 * `permission` is required and has no "public" escape hatch. The framework's
 * `PermissionsGuard` denies any route that declares no permission, so a public
 * module route would have to be an explicit exception — and a reusable module
 * is exactly the wrong place to put one, because the exception would be
 * inherited by every application that installs it.
 */
export const moduleRouteSchema = z
  .object({
    method: httpMethodSchema,
    /** Path relative to the application root, e.g. `/notifications/messages`. */
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^\/[A-Za-z0-9\-_/:]*$/, 'A route path must start with "/".'),
    permission: z.string().min(3).max(120),
    summary: z.string().min(1).max(160),
  })
  .strict();

export type ModuleRoute = z.infer<typeof moduleRouteSchema>;

/** A feature flag the module reads. Namespaced under the module id. */
export const moduleFeatureFlagSchema = z
  .object({
    key: z
      .string()
      .min(3)
      .max(120)
      .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, 'A flag key must be dot-separated.'),
    description: z.string().min(1).max(200),
    /** Value used when the flag is not configured. Off, for anything risky. */
    defaultValue: z.boolean(),
  })
  .strict();

export type ModuleFeatureFlag = z.infer<typeof moduleFeatureFlagSchema>;

/**
 * A database change the module needs.
 *
 * `schemaFragment` is a path inside the module's `install/` tree. The installer
 * copies it into the application's `prisma/schema/` directory; the application
 * then generates the SQL with its own `db:migrate`. Modules deliberately do not
 * ship hand-written SQL: a migration generated against the application's real
 * schema is correct, and one written blind against an imagined schema is a
 * guess that fails in production.
 */
export const moduleMigrationSchema = z
  .object({
    id: z.string().min(1).max(80),
    description: z.string().min(1).max(200),
    schemaFragment: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._/-]+$/, 'Must be a plain relative path.'),
    /** False for a fragment that adds no table (an enum-only fragment). */
    requiresMigration: z.boolean().default(true),
  })
  .strict();

export type ModuleMigration = z.infer<typeof moduleMigrationSchema>;

/**
 * A seam an application may implement to change what the module does.
 *
 * Declared rather than merely documented so `trustos list-modules --verbose`
 * can answer "what can I swap out here?" — which is the question asked at the
 * moment someone is about to fork a module instead of extending it.
 */
export const moduleExtensionPointSchema = z
  .object({
    name: z.string().min(1).max(80),
    /** The exported interface name an implementation must satisfy. */
    port: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    /** Implementations shipped with the module, e.g. ['MockEmailAdapter']. */
    provided: z.array(z.string().min(1).max(80)).default([]),
  })
  .strict();

export type ModuleExtensionPoint = z.infer<typeof moduleExtensionPointSchema>;

/**
 * An environment variable the module reads.
 *
 * Only the *name* and a description are declared. No example value is carried,
 * and the installer writes `NAME=` with the description as a comment — a module
 * cannot contribute a value to `.env.example`, so it cannot contribute a
 * secret-shaped default that someone later ships.
 */
export const moduleEnvVarSchema = z
  .object({
    name: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Environment variable names are UPPER_SNAKE_CASE.'),
    description: z.string().min(1).max(200),
    required: z.boolean().default(false),
  })
  .strict();

export type ModuleEnvVar = z.infer<typeof moduleEnvVarSchema>;

/** Derives the resource and action halves of a permission key. */
export function splitPermissionKey(key: string): { resource: string; action: string } {
  const segments = key.split('.');
  return {
    resource: segments.slice(0, -1).join('.'),
    action: segments[segments.length - 1] ?? '',
  };
}

/** `feature-flags` -> `FEATURE_FLAGS`, the required prefix for its env vars. */
export function environmentPrefix(moduleId: string): string {
  return moduleId.replace(/-/g, '_').toUpperCase();
}

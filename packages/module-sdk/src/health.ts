import type { HealthIndicator, HealthStatus } from '@trustsystem/observability';

/**
 * Re-exported so a module needs one import.
 *
 * The type is the framework's, not the SDK's — a module indicator is registered
 * with the application's `HealthRegistry` unchanged. Re-exporting rather than
 * redeclaring keeps that true.
 */
export type { HealthIndicator, HealthStatus };

/**
 * Module health.
 *
 * Modules contribute to the application's existing readiness probe rather than
 * exposing endpoints of their own, so `GET /ready` stays the single answer to
 * "should traffic come here?" and an operator does not have to know which
 * modules are installed to know whether the service is healthy.
 *
 * Module indicators are **non-critical by default**. A degraded notification
 * queue should not take an instance out of rotation — it should show up in the
 * report and let the rest of the application keep serving. A module that genuinely
 * cannot be degraded (its storage provider is unreachable and every request will
 * fail) passes `critical: true` explicitly.
 */

export interface ModuleHealth {
  status: HealthStatus;
  /** Operator-facing detail. Must not contain credentials or connection strings. */
  detail?: string;
}

export interface ModuleHealthOptions {
  /** Fails readiness when down. Default false; see the note above. */
  critical?: boolean;
}

export function moduleHealthIndicator(
  moduleId: string,
  check: () => Promise<ModuleHealth>,
  options: ModuleHealthOptions = {},
): HealthIndicator {
  return {
    // Prefixed so a module indicator is distinguishable from `database` at a
    // glance in the readiness payload.
    name: `module:${moduleId}`,
    critical: options.critical ?? false,
    check,
  };
}

/** A module with nothing external to check. Reports `ok` without doing work. */
export function alwaysHealthy(moduleId: string, detail: string): HealthIndicator {
  return moduleHealthIndicator(moduleId, () => Promise.resolve({ status: 'ok', detail }));
}

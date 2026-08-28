/**
 * @trustos/sre-core
 *
 * Services, dependencies, runbooks and maintenance windows.
 *
 * One rule shapes the schema: a service that cannot name an owner, and — above tier 3 — a
 * rotation and a runbook, does not register. The alternative is a registry full of services whose
 * alerts route nowhere, which is worse than no registry because it looks like coverage.
 */
export * from './service';

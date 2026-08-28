/**
 * @trustos/upgrade-manager
 *
 * The upgrade: preflight, backup, migration, validation, rollback and a report.
 *
 * Everything else in Phase 10 exists so this can be a plan rather than a leap. The manager
 * decides and refuses; it does not execute — backups, migrations and restores are ports the
 * caller supplies. That split is the point: a tool that both decides and acts has one code path
 * for "what would happen" and another for "what happened", and the dry run stops predicting the
 * real run the first time they diverge.
 *
 * How to recover from a failure is decided *before* the upgrade starts, from what the migration
 * plan says is reversible. Deciding it at failure time, with a half-migrated database, is
 * deciding it under the worst possible conditions.
 */
export * from './upgrade';

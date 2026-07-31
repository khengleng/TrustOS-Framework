/**
 * @trustos/migration-tools
 *
 * Database, configuration, template, module and framework migrations, with dry run and rollback.
 *
 * The five kinds differ in one respect that governs everything else: whether they can be undone.
 * Config, template and module migrations rewrite files and are reversible. Database migrations
 * are not — a dropped column does not come back — so the framework says so rather than offering a
 * `down` that silently loses data. Reversible migrations reverse; irreversible ones are recovered
 * from the backup taken before the upgrade started.
 *
 * Nothing here opens a database connection or writes a file. Execution is a port the caller
 * supplies, which is what lets the dry run and the real run take the same path.
 */
export * from './migration';

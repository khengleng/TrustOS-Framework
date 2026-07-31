/**
 * @trustos/package-manager
 *
 * Install, update, remove, rollback, dependency resolution, conflict detection and integrity
 * validation — offline.
 *
 * Nothing here fetches. The installer is handed the artefacts it may use and refuses anything
 * else, which makes an air-gapped install the same operation as a connected one rather than a
 * degraded mode nobody tests. Every operation produces an inspectable plan first, so `--dry-run`
 * is simply not calling `apply` rather than a second code path that predicts the first.
 */
export * from './lockfile';
export * from './installer';

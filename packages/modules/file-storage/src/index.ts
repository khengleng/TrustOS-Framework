/**
 * @trustos/module-file-storage
 *
 * Object storage behind a provider port, with checksums, version history and a
 * per-organization key namespace.
 *
 * Read `keys.ts` before changing anything: it holds the only code in the module
 * system that turns a caller-supplied string into a filesystem path, and its two
 * independent controls are the reason that is safe.
 */
export * from './config';
export * from './keys';
export * from './provider';
export * from './store';
export * from './file-storage.service';
export * from './file-storage.module';

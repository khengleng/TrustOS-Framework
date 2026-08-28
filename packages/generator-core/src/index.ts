/**
 * @trustos/generator-core
 *
 * Safe, deterministic, transactional generation from local templates.
 *
 * The invariants, in order of how much they matter:
 *   1. No write ever lands outside the project directory.
 *   2. A failed run leaves nothing behind.
 *   3. The same inputs produce byte-identical output.
 *   4. No secret is ever generated — `.env.example` only.
 */
export * from './errors';
export * from './naming';
export * from './paths';
export * from './render';
export * from './template-config';
export * from './plan';
export * from './writer';
export * from './generate';
export * from './validate-template';
export * from './application-manifest';
export * from './module-install-files';
export * from './install-module';

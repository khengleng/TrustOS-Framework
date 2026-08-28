/**
 * @trustos/compatibility-engine
 *
 * Whether the framework, its modules, the database, the CLI, the templates and the API contract
 * can run together.
 *
 * Every real upgrade failure this exists to prevent is a *pair*, not a single thing: the
 * framework moved and the module did not, the schema migrated and the CLI that reads it did not,
 * a template generated against 0.1 calling an API at 0.4. Checking each surface alone finds none
 * of them, because each one is individually fine.
 */
export * from './engine';

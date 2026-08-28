/**
 * @trustos/connector-registry
 *
 * Provider-neutral connector metadata: which external system implements which interface
 * operation, what it takes, how long to wait and what to do when it does not answer.
 *
 * A connector is *metadata about a binding*, not the adapter and not the credential. The adapter
 * lives in a deployment, wired through `@trustos/adapter-framework`; the credential lives in that
 * deployment's secret store; nothing here carries either, and the schema refuses anything shaped
 * like a URL.
 *
 * `interfaces.ts` is the file to read first. The seven interfaces and their closed operation
 * lists are why a bank can be replaced without reopening a product — and why an open interface
 * would quietly undo that.
 *
 * **The framework's own registry is empty and stays empty.**
 */
export * from './interfaces';
export * from './schema';
export * from './registry';

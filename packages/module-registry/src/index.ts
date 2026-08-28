/**
 * @trustos/module-registry
 *
 * Two things, both about discovery:
 *
 *   * **The catalog** — validated data describing every approved module: its
 *     permissions, routes, audit events, migrations, flags and dependencies.
 *     Modules read their own declarations from it, the CLI installs from it, and
 *     nothing has to execute a module to know what it does.
 *
 *   * **The registry** — the in-memory list an application builds at start-up,
 *     which decides start order, stop order, health indicators and the
 *     permission catalog to seed.
 *
 * Modules are local and version-controlled. There is no remote fetch, no plugin
 * resolution and no marketplace.
 */
export * from './errors';
export * from './schema';
export * from './provenance';
export * from './catalog';
export * from './declarations';
export * from './resolve';
export * from './registry';

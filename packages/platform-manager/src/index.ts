/**
 * @trustos/platform-manager
 *
 * One view of the platform: version, modules, health, licence, dependencies, compatibility and
 * upgrade status.
 *
 * Every fact here is available somewhere else — the version in a package.json, the modules in a
 * lockfile, the licence in a config file, health in a check nobody runs. The reason this exists is
 * that nobody assembles them, so "is this deployment in good shape" takes an afternoon and three
 * people. `describePlatform` answers it in one call, offline, with no running system — which
 * matters because the moment somebody most needs the summary is when they are deciding whether to
 * start the system, or during an incident when it will not start.
 *
 * It aggregates and never decides. Nothing here installs, upgrades or repairs.
 */
export * from './platform';

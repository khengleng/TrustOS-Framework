import { describe, expect, it } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MODULE_CATALOG } from '@trustos/module-registry';

/**
 * Every module package, exercised as a contract.
 *
 * One generic suite rather than sixteen near-identical ones, because these packages *are*
 * near-identical: each declares its catalog entry, builds an instance, and reports health. What
 * differs between them is the domain behind them, and that lives in the framework packages the
 * module wraps — which have their own tests.
 *
 * What this catches, and nothing else did:
 *
 *   * A module that fails to load at all. `MODULE_CATALOG` validates the *declarations*, which are
 *     data; it never imports the package, so a broken `defineModule` call was invisible until
 *     somebody installed the module into a real application.
 *   * A lifecycle that throws, or one that reports ready after being shut down.
 *   * A financial or tenant-owning module that forgot `tenantScoped`, which is the single
 *     declaration that decides whether every query it runs is scoped.
 *
 * Before this existed, `npm run test:modules` pointed at a directory with no spec files in it and
 * reported success — a script that tested nothing and said so in green.
 */

const MODULES_ROOT = __dirname;

/** Module directories on disk, so a new module is covered the moment it is added. */
const directories = readdirSync(MODULES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(MODULES_ROOT, entry.name, 'src')))
  .map((entry) => entry.name)
  .sort();

/** Modules that own tenant data and must say so. */
const MUST_BE_TENANT_SCOPED = new Set([
  'wallet',
  'ledger',
  'transactions',
  'settlement',
  'reconciliation',
  'export',
  'import',
  'sync',
  'rag',
  'agent',
]);

function loggerStub() {
  const lines: unknown[] = [];

  const log = (...args: unknown[]) => {
    lines.push(args);
  };

  return {
    lines,
    logger: { info: log, warn: log, error: log, debug: log, child: () => loggerStub().logger },
  };
}

describe('the module packages', () => {
  it('finds every module directory', () => {
    // A guard on the suite itself: if the glob breaks, every test below silently passes.
    expect(directories.length).toBeGreaterThan(10);
  });

  it.each(directories)('%s loads and exposes a definition', async (name) => {
    /*
     * The check the catalog cannot make. `MODULE_CATALOG` validates declarations as data and never
     * imports the package, so a `defineModule` that throws at import time was invisible here.
     */
    const loaded = (await import(`./${name}/src/index.ts`)) as Record<string, unknown>;

    const definition = Object.values(loaded).find(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'metadata' in (value as Record<string, unknown>) &&
        'create' in (value as Record<string, unknown>),
    ) as { metadata: { id: string }; create: unknown; tenantScoped?: boolean } | undefined;

    expect(definition).toBeDefined();
    expect(typeof definition?.create).toBe('function');
  });

  it.each(directories)('%s matches its catalog entry', async (name) => {
    const loaded = (await import(`./${name}/src/index.ts`)) as Record<string, unknown>;

    const definition = Object.values(loaded).find(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'metadata' in (value as Record<string, unknown>),
    ) as { metadata: { id: string } } | undefined;

    const catalogEntry = MODULE_CATALOG.find(
      (entry) => entry.metadata.id === definition?.metadata.id,
    );

    // A module whose id is not in the catalog cannot be installed, and nothing else would say so.
    expect({ name, inCatalog: Boolean(catalogEntry) }).toEqual({ name, inCatalog: true });
  });

  it.each(directories)('%s builds an instance with a working lifecycle', async (name) => {
    const loaded = (await import(`./${name}/src/index.ts`)) as Record<string, unknown>;

    const definition = Object.values(loaded).find(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'create' in (value as Record<string, unknown>) &&
        'configSchema' in (value as Record<string, unknown>),
    ) as
      | {
          metadata: { id: string };
          configSchema: { parse: (input: unknown) => unknown };
          create: (context: unknown) => {
            moduleId: string;
            initialize: () => Promise<void>;
            shutdown: () => Promise<void>;
            healthIndicator?: () => { check: () => Promise<{ status: string; detail?: string }> };
          };
        }
      | undefined;

    if (!definition) return;

    const { logger } = loggerStub();
    const config = definition.configSchema.parse({});

    const instance = definition.create({ config, logger, moduleId: definition.metadata.id });

    expect(instance.moduleId).toBe(definition.metadata.id);

    /*
     * A module given no database either starts without one or refuses — and refusing is the
     * correct behaviour, which is why this accepts both. What it does not accept is a module that
     * starts *broken*: initializing successfully with no store behind it produces a module that
     * reports healthy and fails on the first request.
     *
     * So the assertion is on the refusal being *legible*: it must name the module and what it
     * needs, rather than throwing whatever the driver threw.
     */
    let started = true;

    try {
      await instance.initialize();
    } catch (error) {
      started = false;

      const message = error instanceof Error ? error.message : String(error);

      expect({ name, mentionsModule: message.includes(definition.metadata.id) }).toEqual({
        name,
        mentionsModule: true,
      });
      expect(message.length).toBeGreaterThan(20);
    }

    const indicator = instance.healthIndicator?.();

    if (indicator && started) {
      const health = await indicator.check();

      // `ok` or `degraded` — a module may legitimately start in a reduced state when an optional
      // dependency is absent. What it may not do is report a status outside its own vocabulary.
      expect({ name, status: health.status }).toEqual({
        name,
        status: expect.stringMatching(/^(ok|degraded)$/),
      });

      if (health.status === 'degraded') {
        // A degraded module must say why, or an operator has a yellow light and no next step.
        expect((health.detail ?? '').length).toBeGreaterThan(10);
      }
    }

    await expect(instance.shutdown()).resolves.toBeUndefined();

    if (indicator && started) {
      // After shutdown it must stop claiming to be healthy — a module reporting `ok` while
      // stopped is one a health check will never catch.
      expect((await indicator.check()).status).not.toBe('ok');
    }
  });

  it.each(directories)('%s declares tenant scoping when it owns tenant data', async (name) => {
    /*
     * The single declaration that decides whether every query the module runs is scoped. A
     * financial module that forgot it returns every organization's money, and nothing fails.
     */
    if (!MUST_BE_TENANT_SCOPED.has(name)) return;

    const loaded = (await import(`./${name}/src/index.ts`)) as Record<string, unknown>;

    const definition = Object.values(loaded).find(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'tenantScoped' in (value as Record<string, unknown>),
    ) as { tenantScoped?: boolean } | undefined;

    expect({ name, tenantScoped: definition?.tenantScoped }).toEqual({ name, tenantScoped: true });
  });
});

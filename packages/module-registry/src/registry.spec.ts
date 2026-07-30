import { beforeEach, describe, expect, it } from 'vitest';
import {
  alwaysHealthy,
  defineModule,
  type ModuleInstance,
  type TrustosModule,
} from '@trustos/module-sdk';
import { z } from 'zod';
import { ModuleRegistry } from './registry';

/**
 * Registry behaviour, tested against small synthetic modules rather than the
 * real seven. The real catalog is covered by `catalog.spec.ts`; what matters
 * here is the registry's own rules, and those are easier to state and to break
 * with two-line modules.
 */

interface Trace {
  events: string[];
}

function makeModule(
  id: string,
  options: {
    dependencies?: Array<{ moduleId: string; optional?: boolean }>;
    permissions?: string[];
    routePath?: string;
    trace?: Trace;
    failOnInitialize?: boolean;
    failOnShutdown?: boolean;
  } = {},
): { module: TrustosModule; instance: ModuleInstance } {
  const permissions = (options.permissions ?? [`${id}.thing.read`]).map((key) => ({
    key,
    description: 'A permission.',
  }));

  const module = defineModule({
    metadata: {
      id,
      name: id,
      description: `Synthetic module ${id}.`,
      version: '0.1.0',
      minimumFrameworkVersion: '0.1.0',
      owner: 'Tests',
    },
    dependencies: (options.dependencies ?? []).map((dependency) => ({
      moduleId: dependency.moduleId,
      versionRange: '^0.1.0',
      optional: dependency.optional ?? false,
      reason: 'Synthetic dependency.',
    })),
    configSchema: z.object({}),
    permissions,
    routes: [
      {
        method: 'GET',
        path: options.routePath ?? `/${id}/things`,
        permission: permissions[0]?.key ?? `${id}.thing.read`,
        summary: 'List things.',
      },
    ],
    tenantScoped: true,
    create: () => instance,
  });

  const instance: ModuleInstance = {
    moduleId: id,
    initialize: () => {
      options.trace?.events.push(`init:${id}`);
      return options.failOnInitialize
        ? Promise.reject(new Error(`${id} cannot start`))
        : Promise.resolve();
    },
    shutdown: () => {
      options.trace?.events.push(`stop:${id}`);
      return options.failOnShutdown
        ? Promise.reject(new Error(`${id} cannot stop`))
        : Promise.resolve();
    },
    healthIndicator: () => alwaysHealthy(id, 'synthetic'),
  };

  return { module, instance };
}

/**
 * A module object assembled directly, bypassing `defineModule`.
 *
 * Only used to reach registry checks that `defineModule` makes unreachable from
 * inside this repository. Production module code always goes through
 * `defineModule`.
 */
function rawModule(id: string, permissionKey: string): TrustosModule {
  return {
    metadata: {
      id,
      name: id,
      description: `Hand-built module ${id}.`,
      version: '0.1.0',
      minimumFrameworkVersion: '0.1.0',
      owner: 'Tests',
      stability: 'experimental',
      tags: [],
    },
    dependencies: [],
    configSchema: z.object({}),
    permissions: [{ key: permissionKey, description: 'A permission.', suggestedRoles: [] }],
    auditEvents: [],
    routes: [],
    migrations: [],
    featureFlags: [],
    environment: [],
    extensionPoints: [],
    tenantScoped: true,
    create: () => {
      throw new Error('not used');
    },
  };
}

describe('ModuleRegistry registration', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
  });

  it('registers a module and reports it', () => {
    const { module, instance } = makeModule('alpha');
    registry.register(module, instance);

    expect(registry.has('alpha')).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.describe()[0]?.permissions).toBe(1);
  });

  it('refuses the same module twice', () => {
    const first = makeModule('alpha');
    const second = makeModule('alpha');

    registry.register(first.module, first.instance);
    expect(() => registry.register(second.module, second.instance)).toThrowError(
      /already registered/,
    );
  });

  it('refuses two modules claiming the same permission key', () => {
    // Built by hand rather than through `defineModule`, which would reject a
    // key outside the module namespace before the registry saw it. The registry
    // does not assume every module went through `defineModule` — a module from
    // outside this repository, or one built against an older SDK, would not
    // have — so the check is defence in depth rather than a repeat.
    registry.register(rawModule('alpha', 'shared.thing.read'));

    // A merged permission is a single grant that opens two doors.
    expect(() => registry.register(rawModule('beta', 'shared.thing.read'))).toThrowError(
      /already claimed by module "alpha"/,
    );
  });

  it('refuses two modules claiming the same route', () => {
    registry.register(makeModule('alpha', { routePath: '/things' }).module);

    // Nest would bind whichever controller was registered last, silently.
    expect(() =>
      registry.register(makeModule('beta', { routePath: '/things' }).module),
    ).toThrowError(/Route GET \/things is already claimed/);
  });

  it('aggregates declarations across registered modules', () => {
    registry.register(makeModule('alpha').module);
    registry.register(makeModule('beta').module);

    expect(registry.permissions()).toHaveLength(2);
    expect(registry.routes()).toHaveLength(2);
  });

  it('says which module is not registered', () => {
    expect(() => registry.require('ghost')).toThrowError(/Module "ghost" is not registered/);
  });
});

describe('ModuleRegistry ordering', () => {
  it('returns registered modules in dependency order', () => {
    const registry = new ModuleRegistry();
    registry.register(makeModule('top', { dependencies: [{ moduleId: 'base' }] }).module);
    registry.register(makeModule('base').module);

    expect(registry.dependencyOrder().map((module) => module.metadata.id)).toEqual(['base', 'top']);
  });

  it('refuses to order when a required dependency is missing, naming the reason', () => {
    const registry = new ModuleRegistry();
    registry.register(makeModule('top', { dependencies: [{ moduleId: 'base' }] }).module);

    // Otherwise the failure surfaces at the dependent module's first database
    // call, and the error names the wrong module.
    expect(() => registry.dependencyOrder()).toThrowError(
      /"top" requires "base" \(Synthetic dependency\.\)/,
    );
  });

  it('tolerates a missing optional dependency', () => {
    const registry = new ModuleRegistry();
    registry.register(
      makeModule('top', { dependencies: [{ moduleId: 'base', optional: true }] }).module,
    );

    expect(registry.dependencyOrder().map((module) => module.metadata.id)).toEqual(['top']);
  });
});

describe('ModuleRegistry lifecycle', () => {
  it('initializes in dependency order and shuts down in reverse', async () => {
    const trace: Trace = { events: [] };
    const registry = new ModuleRegistry();

    const base = makeModule('base', { trace });
    const top = makeModule('top', { trace, dependencies: [{ moduleId: 'base' }] });
    registry.register(top.module, top.instance);
    registry.register(base.module, base.instance);

    await registry.initializeAll();
    expect(trace.events).toEqual(['init:base', 'init:top']);
    expect(registry.startedModules()).toEqual(['base', 'top']);

    await registry.shutdownAll();
    expect(trace.events).toEqual(['init:base', 'init:top', 'stop:top', 'stop:base']);
  });

  it('rolls back a failed start-up by stopping what already started', async () => {
    const trace: Trace = { events: [] };
    const registry = new ModuleRegistry();

    const base = makeModule('base', { trace });
    const top = makeModule('top', {
      trace,
      dependencies: [{ moduleId: 'base' }],
      failOnInitialize: true,
    });
    registry.register(base.module, base.instance);
    registry.register(top.module, top.instance);

    // A half-started application is worse than one that refuses to start: it
    // serves traffic against modules whose invariants were never established.
    await expect(registry.initializeAll()).rejects.toThrow(/"top" failed to initialize/);
    expect(trace.events).toEqual(['init:base', 'init:top', 'stop:base']);
    expect(registry.startedModules()).toEqual([]);
  });

  it('refuses to start a module registered without an instance', async () => {
    const registry = new ModuleRegistry();
    registry.register(makeModule('alpha').module);

    await expect(registry.initializeAll()).rejects.toThrow(/without an instance/);
  });

  it('keeps stopping after a shutdown failure and reports it', async () => {
    const trace: Trace = { events: [] };
    const registry = new ModuleRegistry();

    const base = makeModule('base', { trace });
    const top = makeModule('top', {
      trace,
      dependencies: [{ moduleId: 'base' }],
      failOnShutdown: true,
    });
    registry.register(base.module, base.instance);
    registry.register(top.module, top.instance);

    await registry.initializeAll();
    const result = await registry.shutdownAll();

    // A shutdown that stops at the first failure leaks whatever the remaining
    // modules were holding.
    expect(result.failures).toEqual([{ id: 'top', error: 'top cannot stop' }]);
    expect(result.stopped).toEqual(['base']);
  });

  it('exposes a health indicator per started module', async () => {
    const registry = new ModuleRegistry();
    const alpha = makeModule('alpha');
    registry.register(alpha.module, alpha.instance);

    const indicators = registry.healthIndicators();
    expect(indicators.map((indicator) => indicator.name)).toEqual(['module:alpha']);
    expect((await indicators[0]?.check())?.status).toBe('ok');
  });
});

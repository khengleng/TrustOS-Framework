import { describe, expect, it } from 'vitest';
import { createTestModuleContext } from '@trustos/module-sdk';
import { createEvents, eventsConfigSchema, eventsModule } from './events.module';

/*
 * `@trustos/module-events` is a contract wrapper.
 *
 * The behaviour lives in the framework packages it fronts and is tested where it is
 * implemented; what this package owns is the declaration the platform reads and the
 * lifecycle the runtime drives. Those are what these tests cover. The isolation tests
 * are contract-level for the same reason: this package runs no queries of its own, so
 * the thing that can go wrong here is declaring the contract wrongly.
 */

describe('events configuration validation', () => {
  it('installs with no configuration at all', () => {
    expect(eventsConfigSchema.parse({})).toEqual({ enabled: true });
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    // A typo in a deployment's configuration should stop the boot. Ignored, it becomes a
    // setting somebody believes is applied and never is.
    expect(eventsConfigSchema.safeParse({ enable: false }).success).toBe(false);
  });

  it('rejects a non-boolean enabled rather than coercing it', () => {
    // The string "false" is truthy, so coercion here would switch on a module somebody
    // had deliberately switched off.
    expect(eventsConfigSchema.safeParse({ enabled: 'false' }).success).toBe(false);
  });
});

describe('events tenant isolation', () => {
  /*
   * This package reaches no database and mounts no route, so it owns no query a missing
   * organization filter could escape through. Isolation for the events domain is enforced,
   * and tested, in the framework packages it fronts.
   *
   * These tests pin that precondition rather than asserting it in prose. The day this
   * module grows a query or an endpoint of its own, they fail — and it then needs real
   * isolation tests rather than this delegation.
   *
   * Deliberately absent: assertions that the module is tenant-scoped and that its keys
   * are namespaced. `defineModule` refuses to construct a module that fails either, so
   * a test for them here could never fail.
   */
  it('mounts no route of its own', () => {
    expect(eventsModule.routes).toEqual([]);
  });

  it('initializes with no database client at all', async () => {
    const { context } = createTestModuleContext(eventsModule, { prisma: null });

    await expect(createEvents(context).initialize()).resolves.toBeUndefined();
  });

  it('declares audit events, because it fronts something that changes state', () => {
    // Not enforced by defineModule, which only requires the actions it does declare to
    // be unique and namespaced.
    expect(eventsModule.auditEvents.length).toBeGreaterThan(0);
  });
});

describe('events lifecycle', () => {
  it('is ready and healthy after initialize', async () => {
    const { context } = createTestModuleContext(eventsModule, { prisma: null });
    const instance = createEvents(context);

    await instance.initialize();

    expect(instance.ready).toBe(true);
    expect((await instance.healthIndicator().check()).status).toBe('ok');
  });

  it('stays unready and reports degraded when disabled by configuration', async () => {
    const { context } = createTestModuleContext(eventsModule, {
      prisma: null,
      config: { enabled: false },
    });
    const instance = createEvents(context);

    await instance.initialize();

    // A module that is switched off but reports healthy is indistinguishable from one
    // that is working, which is how a disabled dependency survives a release.
    expect(instance.ready).toBe(false);
    expect((await instance.healthIndicator().check()).status).toBe('degraded');
  });

  it('is no longer ready after shutdown', async () => {
    const { context } = createTestModuleContext(eventsModule, { prisma: null });
    const instance = createEvents(context);

    await instance.initialize();
    await instance.shutdown();

    expect(instance.ready).toBe(false);
  });

  it('tolerates shutdown without a preceding initialize', async () => {
    // The runtime shuts down every registered module when a boot fails partway, including
    // the ones it had not reached yet.
    const { context } = createTestModuleContext(eventsModule, { prisma: null });

    await expect(createEvents(context).shutdown()).resolves.toBeUndefined();
  });
});

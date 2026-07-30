import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { alwaysHealthy } from './health';
import {
  defineModule,
  ModuleDefinitionError,
  moduleAuditActions,
  modulePermissionKeys,
  type ModuleDefinitionInput,
} from './definition';

/**
 * `defineModule` is the enforcement point of the module system, so its negative
 * cases matter more than its positive one. Each test below corresponds to a way
 * a reusable module could quietly weaken every application that installs it.
 */

const metadata = {
  id: 'demo',
  name: 'Demo',
  description: 'A module used by the SDK tests.',
  version: '0.1.0',
  minimumFrameworkVersion: '0.1.0',
  owner: 'Platform Engineering',
};

function input(overrides: Partial<ModuleDefinitionInput<unknown>> = {}) {
  return {
    metadata,
    configSchema: z.object({ enabled: z.boolean().default(true) }),
    tenantScoped: true as const,
    create: () => ({
      moduleId: 'demo',
      initialize: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      healthIndicator: () => alwaysHealthy('demo', 'no external dependency'),
    }),
    ...overrides,
  } as ModuleDefinitionInput<unknown>;
}

describe('defineModule', () => {
  it('accepts a well-formed module and applies declaration defaults', () => {
    const module = defineModule(input());

    expect(module.metadata.id).toBe('demo');
    expect(module.metadata.stability).toBe('experimental');
    expect(module.tenantScoped).toBe(true);
    expect(module.permissions).toEqual([]);
    expect(module.routes).toEqual([]);
  });

  it('refuses a module that is not tenant-scoped', () => {
    expect(() => defineModule(input({ tenantScoped: false as unknown as true }))).toThrowError(
      /tenantScoped must be true/,
    );
  });

  it('refuses a permission key outside the module namespace', () => {
    expect(
      () =>
        defineModule(
          input({
            permissions: [{ key: 'message.send', description: 'Send a message.' }],
          }),
        ),
      // Two modules defining `message.send` would share one grant, so a role
      // given the permission for one would silently hold it for the other.
    ).toThrowError(/must start with "demo\."/);
  });

  it('refuses an audit action, flag key or env var outside the namespace', () => {
    expect(() =>
      defineModule(
        input({
          auditEvents: [{ action: 'thing.created', entityType: 'Thing', description: 'Created.' }],
        }),
      ),
    ).toThrowError(/audit action "thing.created"/);

    expect(() =>
      defineModule(
        input({
          featureFlags: [{ key: 'other.flag', description: 'A flag.', defaultValue: false }],
        }),
      ),
    ).toThrowError(/feature flag "other.flag"/);

    expect(() =>
      defineModule(input({ environment: [{ name: 'SOME_KEY', description: 'A key.' }] })),
    ).toThrowError(/must start with "DEMO_"/);
  });

  it('refuses a route whose permission the module does not declare', () => {
    expect(
      () =>
        defineModule(
          input({
            permissions: [{ key: 'demo.thing.read', description: 'Read things.' }],
            routes: [
              {
                method: 'POST',
                path: '/demo/things',
                permission: 'demo.thing.write',
                summary: 'Create a thing.',
              },
            ],
          }),
        ),
      // Otherwise a module's authorization surface would depend on what else
      // happens to be installed alongside it.
    ).toThrowError(/does not declare/);
  });

  it('requires every route to name a permission', () => {
    expect(() =>
      defineModule(
        input({
          routes: [{ method: 'GET', path: '/demo/things', summary: 'List things.' }],
        }),
      ),
    ).toThrowError(/routes\[0\] permission/);
  });

  it('rejects duplicate permissions, routes and migrations', () => {
    let error: unknown;
    try {
      defineModule(
        input({
          permissions: [
            { key: 'demo.thing.read', description: 'Read.' },
            { key: 'demo.thing.read', description: 'Read again.' },
          ],
          routes: [
            {
              method: 'GET',
              path: '/demo/things',
              permission: 'demo.thing.read',
              summary: 'List.',
            },
            {
              method: 'GET',
              path: '/demo/things',
              permission: 'demo.thing.read',
              summary: 'List again.',
            },
          ],
          migrations: [
            { id: 'init', description: 'Initial.', schemaFragment: 'prisma/a.prisma' },
            { id: 'init', description: 'Initial again.', schemaFragment: 'prisma/b.prisma' },
          ],
        }),
      );
    } catch (caught) {
      error = caught;
    }

    const problems = (error as ModuleDefinitionError).problems;
    expect(problems).toContain('duplicate permission key "demo.thing.read".');
    expect(problems).toContain('duplicate route "GET /demo/things".');
    expect(problems).toContain('duplicate migration id "init".');
  });

  it('refuses a configuration schema that does not accept {}', () => {
    expect(
      () => defineModule(input({ configSchema: z.object({ apiKey: z.string() }) })),
      // A module that cannot start without configuration turns `add-module`
      // into an installation that leaves the application unable to boot.
    ).toThrowError(/configSchema must accept \{\}/);
  });

  it('refuses a self-dependency and duplicate dependencies', () => {
    expect(() =>
      defineModule(
        input({
          dependencies: [{ moduleId: 'demo', versionRange: '^0.1.0', reason: 'Circular.' }],
        }),
      ),
    ).toThrowError(/cannot depend on itself/);

    expect(() =>
      defineModule(
        input({
          dependencies: [
            { moduleId: 'file-storage', versionRange: '^0.1.0', reason: 'Blobs.' },
            { moduleId: 'file-storage', versionRange: '^0.1.0', reason: 'Blobs again.' },
          ],
        }),
      ),
    ).toThrowError(/duplicate dependency "file-storage"/);
  });

  it('reports every problem at once rather than the first', () => {
    let error: unknown;
    try {
      defineModule(
        input({
          permissions: [{ key: 'nope.read', description: 'Read.' }],
          featureFlags: [{ key: 'nope.flag', description: 'Flag.', defaultValue: false }],
        }),
      );
    } catch (caught) {
      error = caught;
    }

    // Fixing declarations one failure per run is how a module ends up with the
    // minimum number of declarations someone had patience for.
    expect((error as ModuleDefinitionError).problems.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects an invalid module id before anything else', () => {
    expect(() =>
      defineModule(input({ metadata: { ...metadata, id: 'Demo Module' } })),
    ).toThrowError(/lowercase words separated by single hyphens/);
  });

  it('exposes permission keys and audit actions for seeding and docs', () => {
    const module = defineModule(
      input({
        permissions: [{ key: 'demo.thing.read', description: 'Read.' }],
        auditEvents: [{ action: 'demo.thing.read', entityType: 'Thing', description: 'Read.' }],
      }),
    );

    expect(modulePermissionKeys(module)).toEqual(['demo.thing.read']);
    expect(moduleAuditActions(module)).toEqual(['demo.thing.read']);
  });
});

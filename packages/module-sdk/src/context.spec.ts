import { describe, expect, it } from 'vitest';
import { createNullLogger } from '@trustos/logging';
import { isApiError } from '@trustos/errors';
import { z } from 'zod';
import { createModuleContext, InMemoryTenantSettingsStore, parseModuleConfig } from './context';
import { RecordingAuditPort } from './testing';

const configSchema = z.object({
  enabled: z.boolean().default(true),
  senderName: z.string().min(1).max(60).default('TrustOS'),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

function build(config?: unknown) {
  const settings = new InMemoryTenantSettingsStore();
  const context = createModuleContext({
    moduleId: 'demo',
    configSchema,
    ...(config === undefined ? {} : { config }),
    logger: createNullLogger(),
    audit: new RecordingAuditPort(),
    tenantSettings: settings,
  });
  return { context, settings };
}

describe('createModuleContext', () => {
  it('applies schema defaults so a module installs with no configuration', () => {
    const { context } = build();
    expect(context.config).toEqual({ enabled: true, senderName: 'TrustOS', maxAttempts: 3 });
  });

  it('validates configuration at construction, not at first use', () => {
    // A misconfigured module must fail when the application starts, not when a
    // customer happens to trigger the code path that reads the bad value.
    expect(() => build({ maxAttempts: 99 })).toThrowError(/misconfigured/);
  });

  it('never puts configuration detail in the client-facing message', () => {
    try {
      build({ senderName: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      expect((error as Error).message).toBe('A module is misconfigured.');
      // The detail belongs in the log context, where it is useful and not
      // visible to a caller probing how the server is wired.
      expect(JSON.stringify((error as { context?: unknown }).context)).toContain('senderName');
    }
  });
});

describe('resolveConfig', () => {
  it('returns the base configuration when a tenant has no overrides', async () => {
    const { context } = build({ senderName: 'Wing' });
    expect((await context.resolveConfig('org_acme')).senderName).toBe('Wing');
  });

  it('applies a tenant override without affecting other tenants', async () => {
    const { context, settings } = build({ senderName: 'Wing' });
    await settings.write('demo', 'org_acme', { senderName: 'Acme' });

    expect((await context.resolveConfig('org_acme')).senderName).toBe('Acme');
    expect((await context.resolveConfig('org_rival')).senderName).toBe('Wing');
    // The base configuration itself is untouched.
    expect(context.config.senderName).toBe('Wing');
  });

  it('validates a tenant override through the module schema', async () => {
    const { context, settings } = build();
    await settings.write('demo', 'org_acme', { maxAttempts: 500 });

    // A stored override must not be able to put a module into a state its own
    // schema forbids — otherwise configuration becomes a way around validation.
    await expect(context.resolveConfig('org_acme')).rejects.toThrow(/misconfigured/);
  });

  it('refuses to resolve configuration without a tenant', async () => {
    const { context } = build();
    await expect(context.resolveConfig('')).rejects.toThrow(/without a tenant/);
  });

  it('does not leak one tenant settings into another module', async () => {
    const { context, settings } = build({ senderName: 'Wing' });
    await settings.write('other-module', 'org_acme', { senderName: 'Wrong' });

    expect((await context.resolveConfig('org_acme')).senderName).toBe('Wing');
  });
});

describe('parseModuleConfig', () => {
  it('reports the failing path so the problem is findable', () => {
    try {
      parseModuleConfig(configSchema, { maxAttempts: 'three' }, 'demo');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(JSON.stringify((error as { context?: unknown }).context)).toContain('maxAttempts');
    }
  });
});

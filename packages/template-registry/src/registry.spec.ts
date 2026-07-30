import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  compareSemver,
  findTemplate,
  isFrameworkCompatible,
  requireTemplate,
} from './registry';
import { templateManifestSchema } from './schema';

describe('template registry', () => {
  it('ships the six approved templates', () => {
    // An exact list rather than a count. Adding a template is a decision, and a test that
    // only counted would pass when one was replaced by another.
    expect(TEMPLATES.map((template) => template.id).sort()).toEqual([
      'generic-saas',
      'learning',
      'merchant',
      'payment-gateway',
      'telegram-mini-app',
      'workflow-enabled-saas',
    ]);
  });

  it('every manifest satisfies the schema', () => {
    for (const template of TEMPLATES) {
      expect(() => templateManifestSchema.parse(template)).not.toThrow();
    }
  });

  it('every template names an owner and states what it excludes', () => {
    for (const template of TEMPLATES) {
      expect(template.owner.length).toBeGreaterThan(0);
      expect(template.outOfScope.length).toBeGreaterThan(0);
      expect(template.migrationNotes.length).toBeGreaterThan(0);
    }
  });

  it('every template wires the framework modules rather than reimplementing them', () => {
    for (const template of TEMPLATES) {
      // A template that skipped tenancy or audit would be generating an app
      // that silently opts out of the framework's security model.
      expect(template.includedModules).toContain('tenancy');
      expect(template.includedModules).toContain('audit');
      expect(template.includedModules).toContain('rbac');
      expect(template.includedModules).toContain('auth');
    }
  });

  it('every template declares at least one entity and one deployment target', () => {
    for (const template of TEMPLATES) {
      expect(template.entities.length).toBeGreaterThan(0);
      expect(template.deploymentTargets.length).toBeGreaterThan(0);
    }
  });

  it('rejects a manifest with an unknown field', () => {
    const manifest = { ...TEMPLATES[0], somethingNew: true };
    expect(() => templateManifestSchema.parse(manifest)).toThrow();
  });

  it('rejects a version range in place of an exact version', () => {
    const manifest = { ...TEMPLATES[0], version: '^0.1.0' };
    expect(() => templateManifestSchema.parse(manifest)).toThrow(/exact semantic version/);
  });
});

describe('lookup', () => {
  it('finds a template by id', () => {
    expect(findTemplate('merchant')?.displayName).toBe('TrustOS Merchant');
    expect(findTemplate('nope')).toBeUndefined();
  });

  it('lists the alternatives when the id is wrong', () => {
    expect(() => requireTemplate('merchnat')).toThrow(/Available templates: /);
  });
});

describe('framework compatibility', () => {
  it('accepts an equal or newer framework and rejects an older one', () => {
    const template = requireTemplate('merchant');
    expect(isFrameworkCompatible(template, '0.1.0')).toBe(true);
    expect(isFrameworkCompatible(template, '0.2.0')).toBe(true);
    expect(isFrameworkCompatible(template, '1.0.0')).toBe(true);
    expect(isFrameworkCompatible(template, '0.0.9')).toBe(false);
  });
});

describe('compareSemver', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.1.0', '1.0.9', 1],
    ['2.0.0', '1.9.9', 1],
    ['0.1.0', '0.10.0', -1],
  ])('compares %s to %s', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected);
  });
});

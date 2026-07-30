import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  checkCompatibility,
  compareSemver,
  effectiveModules,
  findTemplate,
  isFrameworkCompatible,
  requireTemplate,
  resolveTemplateChain,
  templateChildren,
  templatesByCategory,
} from './registry';
import { TEMPLATE_CATEGORIES, missingModuleDependencies, templateManifestSchema } from './schema';

describe('template registry', () => {
  it('ships the approved catalog', () => {
    // An exact list rather than a count. Adding a template is a decision, and a test that
    // only counted would pass when one was replaced by another.
    expect(TEMPLATES.map((template) => template.id).sort()).toEqual([
      'admin-portal',
      'clinic',
      'collection',
      'crm',
      'customer-portal',
      'developer-portal',
      'digital-bank',
      'ecommerce',
      'education',
      'erp',
      'generic-saas',
      'gold-shop',
      'government',
      'helpdesk',
      'hospital',
      'insurance',
      'learning',
      'marketplace',
      'merchant',
      'messenger-miniapp',
      'microloan',
      'ngo',
      'payment-gateway',
      'school',
      'staff-portal',
      'telegram-mini-app',
      'telegram-miniapp',
      'wallet',
      'whatsapp-miniapp',
      'workflow-enabled-saas',
    ]);
  });

  it('has no duplicate ids', () => {
    // The generated industry catalog is concatenated onto the hand-written one. Two manifests
    // claiming the same id would give `requireTemplate` a first-wins answer nobody chose.
    const ids = TEMPLATES.map((template) => template.id);

    expect(new Set(ids).size).toBe(ids.length);
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

describe('the industry catalog', () => {
  it('puts every template in a real category', () => {
    for (const template of TEMPLATES) {
      expect(TEMPLATE_CATEGORIES).toContain(template.category);
    }
  });

  it('closes every module list under its own prerequisites', () => {
    /*
     * A manifest naming `wallet` without `ledger` generates an application whose wallet cannot
     * compute a balance, and it fails on the first request in a project nobody has opened yet.
     */
    for (const template of TEMPLATES) {
      expect({
        id: template.id,
        missing: missingModuleDependencies(template.includedModules),
      }).toEqual({ id: template.id, missing: [] });
    }
  });

  it('gives every deprecated template somewhere to go', () => {
    const deprecated = TEMPLATES.filter((template) => template.status === 'deprecated');

    expect(deprecated.map((template) => template.id)).toEqual(['telegram-mini-app']);

    for (const template of deprecated) {
      expect(findTemplate(template.supersededBy as string)).toBeDefined();
    }
  });

  it('resolves an inheritance chain parent-first', () => {
    expect(resolveTemplateChain('hospital').map((template) => template.id)).toEqual([
      'clinic',
      'hospital',
    ]);
    expect(resolveTemplateChain('marketplace').map((template) => template.id)).toEqual([
      'merchant',
      'ecommerce',
      'marketplace',
    ]);
    expect(resolveTemplateChain('crm').map((template) => template.id)).toEqual(['crm']);
  });

  it('never points a chain at a template that is not in the registry', () => {
    for (const template of TEMPLATES) {
      if (!template.extends) continue;
      expect(findTemplate(template.extends)).toBeDefined();
    }
  });

  it('unions a child’s modules with its parents’', () => {
    // A child cannot honestly drop a parent's module: the parent's files are layered in and
    // they import what they import.
    const parent = requireTemplate('clinic').includedModules;

    for (const module of parent) {
      expect(effectiveModules('hospital')).toContain(module);
    }
  });

  it('advertises a child’s inherited entities', () => {
    /*
     * Somebody choosing `hospital` gets patients. A manifest listing only wards would make them
     * think it did not, and they would pick the wrong template.
     */
    expect(requireTemplate('hospital').entities).toContain('Patient');
    expect(requireTemplate('marketplace').entities).toEqual(
      expect.arrayContaining(['Merchant', 'Product', 'Seller']),
    );
  });

  it('finds a template’s children and its category peers', () => {
    expect(templateChildren('telegram-miniapp').map((template) => template.id)).toEqual([
      'whatsapp-miniapp',
      'messenger-miniapp',
    ]);
    expect(templatesByCategory('health').map((template) => template.id)).toEqual([
      'clinic',
      'hospital',
    ]);
  });

  it('warns rather than blocks on a deprecated or experimental template', () => {
    /*
     * A template somebody has already built on must keep generating, or an upgrade becomes a
     * rewrite. The warning names the successor; the generation still happens.
     */
    const deprecated = checkCompatibility(requireTemplate('telegram-mini-app'), '0.1.0');

    expect(deprecated.compatible).toBe(true);
    expect(deprecated.warnings.join(' ')).toMatch(/deprecated.*telegram-miniapp/);

    const experimental = checkCompatibility(requireTemplate('crm'), '0.1.0');

    expect(experimental.compatible).toBe(true);
    expect(experimental.warnings.join(' ')).toMatch(/experimental/);

    const stable = checkCompatibility(requireTemplate('merchant'), '0.1.0');

    expect(stable.warnings).toEqual([]);
  });

  it('reports why an incompatible template cannot generate', () => {
    const report = checkCompatibility(requireTemplate('merchant'), '0.0.1');

    expect(report.compatible).toBe(false);
    expect(report.reason).toMatch(/Needs framework 0\.1\.0 or newer/);
  });
});

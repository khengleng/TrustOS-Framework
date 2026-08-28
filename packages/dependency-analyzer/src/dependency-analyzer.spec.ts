import { describe, expect, it } from 'vitest';
import { analyzeDependencies, dependants, topologicalOrder, type GraphModule } from './index';

/**
 * Three of the six problems here never fail at runtime, which is the reason the analyzer exists.
 * The tests are written from the failure each check prevents rather than from the check.
 */

const module = (
  id: string,
  version: string,
  dependencies: GraphModule['dependencies'] = [],
  layer?: string,
): GraphModule => ({ id, version, dependencies, layer });

describe('cycles', () => {
  it('reports the path, not the set', () => {
    // "a → b → c → a" tells a reader which edge to cut. "{a,b,c} form a cycle" makes them draw it.
    const report = analyzeDependencies({
      modules: [
        module('a', '1.0.0', [{ moduleId: 'b', versionRange: '^1.0.0' }]),
        module('b', '1.0.0', [{ moduleId: 'c', versionRange: '^1.0.0' }]),
        module('c', '1.0.0', [{ moduleId: 'a', versionRange: '^1.0.0' }]),
      ],
    });

    const cycle = report.findings.find((finding) => finding.kind === 'cycle');

    expect(cycle?.detail).toMatch(/Dependency cycle: a → b → c → a/);
    expect(report.ok).toBe(false);
  });

  it('reports one cycle once, however it is entered', () => {
    const report = analyzeDependencies({
      modules: [
        module('a', '1.0.0', [{ moduleId: 'b', versionRange: '^1.0.0' }]),
        module('b', '1.0.0', [{ moduleId: 'a', versionRange: '^1.0.0' }]),
      ],
    });

    expect(report.findings.filter((finding) => finding.kind === 'cycle')).toHaveLength(1);
  });

  it('produces no install order when a cycle makes ordering impossible', () => {
    const report = analyzeDependencies({
      modules: [
        module('a', '1.0.0', [{ moduleId: 'b', versionRange: '^1.0.0' }]),
        module('b', '1.0.0', [{ moduleId: 'a', versionRange: '^1.0.0' }]),
      ],
    });

    expect(report.installOrder).toEqual([]);
  });
});

describe('missing dependencies', () => {
  it('fails on a required one and only notes an optional one', () => {
    // Reporting an absent optional dependency as an error would make every optional dependency
    // mandatory in practice.
    const report = analyzeDependencies({
      modules: [
        module('a', '1.0.0', [
          { moduleId: 'missing', versionRange: '^1.0.0' },
          { moduleId: 'nice-to-have', versionRange: '^1.0.0', optional: true },
        ]),
      ],
    });

    const findings = report.findings.filter((finding) => finding.kind === 'missing_dependency');

    expect(findings.map((finding) => finding.severity)).toEqual(['error', 'info']);
    expect(findings[1]?.detail).toMatch(/will run without it/);
  });
});

describe('version conflicts', () => {
  it('names both dependants and says one has to move', () => {
    /*
     * Which dependant loses is decided by whoever installed last, which is why this fails
     * differently on different machines.
     */
    const report = analyzeDependencies({
      modules: [
        module('core', '2.0.0'),
        module('a', '1.0.0', [{ moduleId: 'core', versionRange: '^1.0.0' }]),
        module('b', '1.0.0', [{ moduleId: 'core', versionRange: '^2.0.0' }]),
      ],
    });

    const conflict = report.findings.find((finding) => finding.kind === 'version_conflict');

    expect(conflict?.detail).toMatch(
      /core is installed at 2\.0\.0, which does not satisfy a \(needs \^1\.0\.0\)/,
    );
    expect(conflict?.remediation).toMatch(/One of them has to move/);
  });

  it('is silent when every range is satisfied', () => {
    const report = analyzeDependencies({
      modules: [
        module('core', '1.5.0'),
        module('a', '1.0.0', [{ moduleId: 'core', versionRange: '^1.0.0' }]),
        module('b', '1.0.0', [{ moduleId: 'core', versionRange: '~1.5.0' }]),
      ],
    });

    expect(report.findings.filter((finding) => finding.kind === 'version_conflict')).toEqual([]);
  });
});

describe('unused modules', () => {
  it('reports nothing when no entry point is given', () => {
    // Without entry points every module looks unused, and a tool that reports everything reports
    // nothing.
    const report = analyzeDependencies({ modules: [module('orphan', '1.0.0')] });

    expect(report.findings.filter((finding) => finding.kind === 'unused_module')).toEqual([]);
  });

  it('uses reachability, not "has no dependants"', () => {
    // `b` has a dependant — `orphan` — but nothing reaches either from the entry point.
    const report = analyzeDependencies({
      modules: [
        module('app', '1.0.0', [{ moduleId: 'used', versionRange: '^1.0.0' }]),
        module('used', '1.0.0'),
        module('orphan', '1.0.0', [{ moduleId: 'b', versionRange: '^1.0.0' }]),
        module('b', '1.0.0'),
      ],
      entryPoints: ['app'],
    });

    expect(
      report.findings.filter((finding) => finding.kind === 'unused_module').map((f) => f.moduleId),
    ).toEqual(['orphan', 'b']);
  });

  it('warns rather than failing, because an unused module breaks nothing today', () => {
    const report = analyzeDependencies({
      modules: [module('app', '1.0.0'), module('orphan', '1.0.0')],
      entryPoints: ['app'],
    });

    expect(report.ok).toBe(true);
    expect(report.findings[0]?.remediation).toMatch(/still runs its migrations/);
  });
});

describe('breaking changes', () => {
  it('flags a version that crossed a boundary since the recorded state', () => {
    const report = analyzeDependencies({
      modules: [module('a', '0.3.0')],
      previousVersions: { a: '0.2.0' },
    });

    expect(report.findings.find((finding) => finding.kind === 'breaking_change')?.detail).toMatch(
      /0\.2\.0 to 0\.3\.0/,
    );
  });

  it('says nothing about a compatible move', () => {
    const report = analyzeDependencies({
      modules: [module('a', '0.2.9')],
      previousVersions: { a: '0.2.0' },
    });

    expect(report.findings.filter((finding) => finding.kind === 'breaking_change')).toEqual([]);
  });
});

describe('layering', () => {
  it('refuses a dependency that points upward', () => {
    /*
     * A core module depending on a product module means core cannot be reused without the
     * product, which is the moment a framework stops being one.
     */
    const report = analyzeDependencies({
      modules: [
        module('core', '1.0.0', [{ moduleId: 'product', versionRange: '^1.0.0' }], 'core'),
        module('product', '1.0.0', [], 'product'),
      ],
      layerRules: { core: [], product: ['core'] },
    });

    const violation = report.findings.find((finding) => finding.kind === 'architecture_violation');

    expect(violation?.detail).toMatch(/core \(core\) depends on product \(product\)/);
    expect(report.ok).toBe(false);
  });

  it('allows a dependency that points downward', () => {
    const report = analyzeDependencies({
      modules: [
        module('product', '1.0.0', [{ moduleId: 'core', versionRange: '^1.0.0' }], 'product'),
        module('core', '1.0.0', [], 'core'),
      ],
      layerRules: { core: [], product: ['core'] },
    });

    expect(report.findings.filter((finding) => finding.kind === 'architecture_violation')).toEqual(
      [],
    );
  });
});

describe('ordering', () => {
  it('puts dependencies first', () => {
    const modules = [
      module('app', '1.0.0', [{ moduleId: 'mid', versionRange: '^1.0.0' }]),
      module('mid', '1.0.0', [{ moduleId: 'base', versionRange: '^1.0.0' }]),
      module('base', '1.0.0'),
    ];

    expect(topologicalOrder(modules)).toEqual(['base', 'mid', 'app']);
  });

  it('is deterministic regardless of input order', () => {
    // An install order that depends on map iteration differs between a laptop and CI.
    const a = topologicalOrder([module('b', '1.0.0'), module('a', '1.0.0'), module('c', '1.0.0')]);
    const b = topologicalOrder([module('c', '1.0.0'), module('b', '1.0.0'), module('a', '1.0.0')]);

    expect(a).toEqual(b);
  });
});

describe('dependants', () => {
  it('finds everything that would break, transitively', () => {
    const modules = [
      module('base', '1.0.0'),
      module('mid', '1.0.0', [{ moduleId: 'base', versionRange: '^1.0.0' }]),
      module('top', '1.0.0', [{ moduleId: 'mid', versionRange: '^1.0.0' }]),
      module('optional', '1.0.0', [{ moduleId: 'base', versionRange: '^1.0.0', optional: true }]),
    ];

    // The optional dependant is absent: it degrades rather than breaking.
    expect(dependants(modules, 'base')).toEqual(['mid', 'top']);
  });
});

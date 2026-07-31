import { describe, expect, it } from 'vitest';
import {
  FRAMEWORK_LAYERS,
  groupByRule,
  layerOf,
  validateArchitecture,
  architectureRuleSchema,
} from './index';

/**
 * Each test is a decay this catches before it compounds. The layering ones matter most: nothing
 * fails at runtime, and by the time it is noticed the cost of finding out is the cost of a rewrite.
 */

const file = (path: string, content: string) => ({ path, content });

describe('layering', () => {
  it('places a package in the most specific layer', () => {
    expect(layerOf('packages/errors/src/x.ts', FRAMEWORK_LAYERS)?.name).toBe('foundation');
    expect(layerOf('packages/audit/src/x.ts', FRAMEWORK_LAYERS)?.name).toBe('platform');
    expect(layerOf('packages/anything/src/x.ts', FRAMEWORK_LAYERS)?.name).toBe('capability');
    expect(layerOf('apps/api/src/x.ts', FRAMEWORK_LAYERS)?.name).toBe('product');
  });

  it('refuses a foundation package reaching up', () => {
    // A foundation package that imports a product one cannot be reused without the product.
    const report = validateArchitecture({
      files: [file('packages/errors/src/x.ts', "import { A } from '@trustos/audit';\n")],
    });

    expect(report.ok).toBe(false);
    expect(report.violations[0]).toMatchObject({ ruleId: 'no-upward-dependency', line: 1 });
  });

  it('allows a downward dependency', () => {
    const report = validateArchitecture({
      files: [file('packages/audit/src/x.ts', "import { ApiError } from '@trustos/errors';\n")],
    });

    expect(report.violations).toEqual([]);
  });
});

describe('dependencies', () => {
  it('refuses a deep import into another package', () => {
    // A deep import binds to a file layout that is not part of the contract.
    const report = validateArchitecture({
      files: [file('packages/a/src/x.ts', "import { y } from '@trustos/b/src/internal';\n")],
    });

    expect(report.violations.map((v) => v.ruleId)).toContain('no-cross-package-deep-import');
  });

  it('refuses an import a package never declared', () => {
    // An undeclared import works in the monorepo and fails when the package is installed alone.
    const report = validateArchitecture({
      files: [file('packages/a/src/x.ts', "import { y } from '@trustos/b';\n")],
      declaredDependencies: { a: ['errors'] },
    });

    expect(report.violations.map((v) => v.ruleId)).toContain('declared-dependencies-only');
  });

  it('lets a test import anything', () => {
    // Forcing a test fixture into package.json puts test-only packages into every install.
    const report = validateArchitecture({
      files: [file('packages/a/src/x.spec.ts', "import { y } from '@trustos/b';\n")],
      declaredDependencies: { a: ['errors'] },
    });

    expect(report.violations.map((v) => v.ruleId)).not.toContain('declared-dependencies-only');
  });
});

describe('security rules', () => {
  it('catches a credential literal', () => {
    const report = validateArchitecture({
      files: [file('packages/a/src/x.ts', "const token = 'ghp_abcdefghijklmnopqrstuvwxyz01';\n")],
    });

    expect(report.violations[0]?.ruleId).toBe('no-secret-in-source');
  });

  it('does not flag a comment explaining the rule', () => {
    // Otherwise a doc comment saying "never use console.log here" violates the rule it explains.
    const report = validateArchitecture({
      files: [
        file(
          'packages/a/src/x.ts',
          '// never call console.log in a package\nexport const x = 1;\n',
        ),
      ],
    });

    expect(report.violations).toEqual([]);
  });

  it('catches console in a package but not in the CLI', () => {
    // Printing to stdout *is* the CLI's output; routing it through a structured logger would
    // emit JSON where a human expects a table.
    expect(
      validateArchitecture({ files: [file('packages/a/src/x.ts', 'console.log(1);\n')] })
        .violations,
    ).toHaveLength(1);

    expect(
      validateArchitecture({ files: [file('packages/cli/src/x.ts', 'console.log(1);\n')] })
        .violations,
    ).toEqual([]);
  });

  it('catches raw SQL built from a string', () => {
    const report = validateArchitecture({
      files: [
        file('packages/a/src/x.ts', 'db.$queryRawUnsafe(`SELECT * FROM t WHERE id = ${id}`);\n'),
      ],
    });

    expect(report.violations.map((v) => v.ruleId)).toContain('no-raw-sql-interpolation');
  });

  it('catches floating-point arithmetic on money', () => {
    const report = validateArchitecture({
      files: [file('packages/a/src/x.ts', 'const total = amount * 1.05;\n')],
    });

    expect(report.violations.map((v) => v.ruleId)).toContain('no-float-money');
  });
});

describe('naming and structure', () => {
  it('allows the filenames the frameworks require', () => {
    // A rule that fights the framework it generates for is a rule that gets switched off.
    for (const path of ['apps/admin/src/app/page.tsx', 'apps/admin/src/app/[id]/route.ts']) {
      expect(
        validateArchitecture({ files: [file(path, 'export const x = 1;\n')] }).violations,
      ).toEqual([]);
    }
  });

  it('accepts the dotted role convention Nest uses', () => {
    // A naming rule with eighty violations on day one is not a standard.
    for (const path of ['packages/a/src/audit.service.ts', 'packages/a/src/nest/scope.guard.ts']) {
      expect(
        validateArchitecture({ files: [file(path, 'export const x = 1;\n')] }).violations,
      ).toEqual([]);
    }
  });

  it('warns about a file that is not kebab-case', () => {
    const report = validateArchitecture({
      files: [file('packages/a/src/MyThing.ts', 'export const x = 1;\n')],
    });

    expect(report.violations[0]).toMatchObject({ ruleId: 'kebab-case-files', severity: 'warning' });
    expect(report.ok).toBe(true);
  });

  it('warns about a test in a separate tree', () => {
    const report = validateArchitecture({
      files: [file('packages/a/__tests__/thing.spec.ts', 'export const x = 1;\n')],
    });

    expect(report.violations.map((v) => v.ruleId)).toContain('spec-beside-source');
  });
});

describe('suppression', () => {
  it('honours an inline ignore with a rule id and a reason', () => {
    const report = validateArchitecture({
      files: [
        file(
          'packages/a/src/x.ts',
          '// architecture-ignore: no-secret-in-source — a development seed password\n' +
            "const token = 'ghp_abcdefghijklmnopqrstuvwxyz01';\n",
        ),
      ],
    });

    expect(report.violations).toEqual([]);
  });

  it('ignores a suppression with no reason, or naming another rule', () => {
    /*
     * A blanket disable with no reason is how a rule stops meaning anything: the suppression
     * outlives the person who understood it, and the next reader cannot tell whether it holds.
     */
    for (const comment of [
      '// architecture-ignore: no-secret-in-source — x',
      '// architecture-ignore: no-console-in-packages — wrong rule entirely here',
      '// eslint-disable-next-line',
    ]) {
      const report = validateArchitecture({
        files: [
          file(
            'packages/a/src/x.ts',
            `${comment}\nconst token = 'ghp_abcdefghijklmnopqrstuvwxyz01';\n`,
          ),
        ],
      });

      // Two: the string matches both the GitHub-token pattern and the generic credential one.
      expect(report.violations.length).toBeGreaterThan(0);
    }
  });
});

describe('generated code', () => {
  it('does not treat an import inside a template literal as an import', () => {
    /*
     * A code generator writes whole files as backtick templates. Counting those makes the
     * generator appear to depend on everything it can generate for — wrong, and unfixable, since
     * not importing them is the point.
     */
    const report = validateArchitecture({
      files: [
        file(
          'packages/errors/src/generate.ts',
          'export const template = `\n' + "import { A } from '@trustos/audit';\n" + '`;\n',
        ),
      ],
      declaredDependencies: { errors: [] },
    });

    expect(report.violations).toEqual([]);
  });
});

describe('rules', () => {
  it('refuses a security rule that is only a warning', () => {
    // An unenforced security rule is a comment.
    expect(() =>
      architectureRuleSchema.parse({
        id: 'x',
        kind: 'security',
        description: 'd',
        appliesTo: 'packages/',
        severity: 'warning',
        remediation: 'r',
      }),
    ).toThrow();
  });

  it('groups violations with errors first', () => {
    const report = validateArchitecture({
      files: [
        file('packages/a/src/MyThing.ts', 'export const x = 1;\n'),
        file('packages/errors/src/x.ts', "import { A } from '@trustos/audit';\n"),
      ],
    });

    expect(groupByRule(report)[0]?.severity).toBe('error');
  });

  it('ignores dist and node_modules', () => {
    const report = validateArchitecture({
      files: [file('packages/a/dist/x.ts', 'console.log(1);\n')],
    });

    expect(report.filesChecked).toBe(0);
  });
});

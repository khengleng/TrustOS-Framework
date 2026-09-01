import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { TEMPLATES } from '@trustsystem/template-registry';
import { validateTemplate } from './validate-template';

/**
 * Template validation, run against the real templates.
 *
 * This is the test that keeps `trustos validate-template --all` honest: if a
 * template ever ships without isolation tests, without a health-checked API,
 * with an undeclared placeholder or with something secret-shaped in it, this
 * fails before CI gets as far as generating anything.
 */

const TEMPLATES_ROOT = join(__dirname, '..', '..', '..', 'templates');

type Report = Awaited<ReturnType<typeof validateTemplate>>;

/*
 * Every template is validated once and the reports shared.
 *
 * Each aggregate test below asks a different question of the same evidence, and
 * each used to re-validate all 24 templates to ask it — roughly ninety full
 * validations where twenty-four answer everything. That was slow enough to
 * exceed the five-second default whenever the suite ran in parallel with the
 * rest of the repository, so `npm run validate` reported the CLI capability
 * BROKEN on a tree where every one of these assertions passes in isolation. A
 * validator that cries wolf is not a validator.
 *
 * The assertions are unchanged; only the redundant work is gone.
 */
const reports = new Map<string, Report>();

beforeAll(async () => {
  const validated = await Promise.all(
    TEMPLATES.map(async (template) => {
      return [
        template.id,
        await validateTemplate(template.id, { templatesRoot: TEMPLATES_ROOT }),
      ] as const;
    }),
  );

  for (const [id, report] of validated) reports.set(id, report);
}, 120_000);

/** Fails loudly rather than letting a missing report read as a template with no failures. */
function reportFor(templateId: string): Report {
  const report = reports.get(templateId);
  if (!report) {
    throw new Error(`No validation report for ${templateId} — the shared setup did not run`);
  }
  return report;
}

describe('validateTemplate', () => {
  it.each(TEMPLATES.map((template) => template.id))('%s passes every check', (templateId) => {
    const report = reportFor(templateId);

    const failures = report.checks.filter((check) => check.status === 'fail');
    expect(
      failures.map((check) => `${check.name}: ${check.detail}`),
      `${templateId} failed validation`,
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('runs the full set of checks, not a subset', () => {
    const report = reportFor('merchant');

    expect(report.checks.map((check) => check.name).sort()).toEqual([
      'build configuration',
      'dependencies',
      'deployment configuration',
      'documentation',
      'framework version',
      'health endpoint',
      'model collisions',
      'monetary precision',
      'no committed secrets',
      'no unresolved placeholders',
      'registry metadata',
      'required files',
      'required modules',
      'safe paths',
      'tenant scope',
      'test configuration',
      'valid package references',
    ]);
  });

  it('confirms every template ships tenant-isolation tests', () => {
    for (const template of TEMPLATES) {
      const check = reportFor(template.id).checks.find(
        (entry) => entry.name === 'test configuration',
      );

      expect(check?.status, template.id).toBe('pass');
      expect(check?.detail, template.id).toContain('tenant isolation');
    }
  });

  it('confirms every template ships AGENTS.md and the generated docs', () => {
    for (const template of TEMPLATES) {
      const check = reportFor(template.id).checks.find((entry) => entry.name === 'required files');

      expect(check?.status, template.id).toBe('pass');
    }
  });

  it('confirms every Railway-capable template ships railway.toml', () => {
    const railwayTemplates = TEMPLATES.filter((entry) =>
      entry.deploymentTargets.includes('railway'),
    );

    // A filter that matched nothing would make this test vacuous.
    expect(railwayTemplates.length).toBeGreaterThan(0);

    for (const template of railwayTemplates) {
      const check = reportFor(template.id).checks.find(
        (entry) => entry.name === 'deployment configuration',
      );

      expect(check?.status, template.id).toBe('pass');
    }
  });

  it('rejects an unknown template rather than validating nothing', async () => {
    await expect(
      validateTemplate('not-a-template', { templatesRoot: TEMPLATES_ROOT }),
    ).rejects.toThrow(/Unknown template/);
  });
});

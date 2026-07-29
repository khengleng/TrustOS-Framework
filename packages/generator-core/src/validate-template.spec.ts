import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { TEMPLATES } from '@trustos/template-registry';
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

describe('validateTemplate', () => {
  it.each(TEMPLATES.map((template) => template.id))('%s passes every check', async (templateId) => {
    const report = await validateTemplate(templateId, { templatesRoot: TEMPLATES_ROOT });

    const failures = report.checks.filter((check) => check.status === 'fail');
    expect(
      failures.map((check) => `${check.name}: ${check.detail}`),
      `${templateId} failed validation`,
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('runs the full set of checks, not a subset', async () => {
    const report = await validateTemplate('merchant', { templatesRoot: TEMPLATES_ROOT });

    expect(report.checks.map((check) => check.name).sort()).toEqual([
      'build configuration',
      'deployment configuration',
      'health endpoint',
      'no committed secrets',
      'no unresolved placeholders',
      'registry metadata',
      'required files',
      'safe paths',
      'test configuration',
      'valid package references',
    ]);
  });

  it('confirms every template ships tenant-isolation tests', async () => {
    for (const template of TEMPLATES) {
      const report = await validateTemplate(template.id, { templatesRoot: TEMPLATES_ROOT });
      const check = report.checks.find((entry) => entry.name === 'test configuration');

      expect(check?.status, template.id).toBe('pass');
      expect(check?.detail, template.id).toContain('tenant isolation');
    }
  });

  it('confirms every template ships AGENTS.md and the generated docs', async () => {
    for (const template of TEMPLATES) {
      const report = await validateTemplate(template.id, { templatesRoot: TEMPLATES_ROOT });
      const check = report.checks.find((entry) => entry.name === 'required files');

      expect(check?.status, template.id).toBe('pass');
    }
  });

  it('confirms every Railway-capable template ships railway.toml', async () => {
    for (const template of TEMPLATES.filter((entry) =>
      entry.deploymentTargets.includes('railway'),
    )) {
      const report = await validateTemplate(template.id, { templatesRoot: TEMPLATES_ROOT });
      const check = report.checks.find((entry) => entry.name === 'deployment configuration');

      expect(check?.status, template.id).toBe('pass');
    }
  });

  it('rejects an unknown template rather than validating nothing', async () => {
    await expect(
      validateTemplate('not-a-template', { templatesRoot: TEMPLATES_ROOT }),
    ).rejects.toThrow(/Unknown template/);
  });
});

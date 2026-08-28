import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { REQUIRED_NODE_VERSION, runDoctor } from './doctor';
import { printDoctorReport } from '../program';
import { createCapturingOutput } from '../output';

/**
 * Doctor tests.
 *
 * The rule under test: a missing *optional* tool is a WARN and never a FAIL.
 * A diagnostic that exits non-zero because someone has no Railway CLI trains
 * people to ignore it, and then it stops catching the real problems.
 */

const TEMPLATES_ROOT = join(__dirname, '..', '..', '..', '..', 'templates');

/** Probe that reports every tool as present. */
const allPresent = async (command: string) =>
  ({
    npm: '10.8.2',
    git: 'git version 2.43.0',
    psql: 'psql (PostgreSQL) 17.8',
    railway: 'railway 5.30.1',
  })[command] ?? null;

/** Probe that reports every tool as absent. */
const nonePresent = async () => null;

describe('runDoctor', () => {
  it('passes on a fully equipped machine', async () => {
    const report = await runDoctor({ probe: allPresent, templatesRoot: TEMPLATES_ROOT });

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('checks everything the spec requires', async () => {
    const report = await runDoctor({ probe: allPresent, templatesRoot: TEMPLATES_ROOT });

    expect(report.checks.map((check) => check.name)).toEqual([
      'Node.js',
      'npm',
      'Git',
      'PostgreSQL client',
      'Railway CLI',
      'Framework packages',
      'Working directory',
    ]);
  });

  it('warns but does not fail when optional tooling is missing', async () => {
    const report = await runDoctor({ probe: nonePresent, templatesRoot: TEMPLATES_ROOT });

    const optional = report.checks.filter((check) =>
      ['Git', 'PostgreSQL client', 'Railway CLI'].includes(check.name),
    );
    expect(optional.map((check) => check.status)).toEqual(['WARN', 'WARN', 'WARN']);

    // npm genuinely is required, so its absence is the only failure here.
    const failures = report.checks.filter((check) => check.status === 'FAIL');
    expect(failures.map((check) => check.name)).toEqual(['npm']);
  });

  it('fails on a Node version older than the framework requires', async () => {
    const report = await runDoctor({
      nodeVersion: '18.20.8',
      probe: allPresent,
      templatesRoot: TEMPLATES_ROOT,
    });

    const node = report.checks.find((check) => check.name === 'Node.js');
    expect(node?.status).toBe('FAIL');
    expect(node?.detail).toContain(REQUIRED_NODE_VERSION);
    expect(node?.remedy).toContain('nvm install');
    expect(report.ok).toBe(false);
  });

  it('accepts a newer Node version', async () => {
    const report = await runDoctor({
      nodeVersion: '22.11.0',
      probe: allPresent,
      templatesRoot: TEMPLATES_ROOT,
    });

    expect(report.checks.find((check) => check.name === 'Node.js')?.status).toBe('PASS');
  });

  it('fails on an npm older than required', async () => {
    const report = await runDoctor({
      probe: async (command) => (command === 'npm' ? '9.0.0' : allPresent(command)),
      templatesRoot: TEMPLATES_ROOT,
    });

    const npm = report.checks.find((check) => check.name === 'npm');
    expect(npm?.status).toBe('FAIL');
    expect(npm?.remedy).toContain('npm@latest');
  });

  it('fails when the templates directory cannot be found', async () => {
    const report = await runDoctor({ probe: allPresent, templatesRoot: null });

    const framework = report.checks.find((check) => check.name === 'Framework packages');
    expect(framework?.status).toBe('FAIL');
    expect(framework?.remedy).toContain('--templates-root');
    expect(report.ok).toBe(false);
  });

  it('reports the framework version it found', async () => {
    const report = await runDoctor({ probe: allPresent, templatesRoot: TEMPLATES_ROOT });

    const framework = report.checks.find((check) => check.name === 'Framework packages');
    expect(framework?.detail).toMatch(/TrustOS framework v\d+\.\d+\.\d+/);
  });

  it('fails when the working directory is not writable', async () => {
    const report = await runDoctor({
      probe: allPresent,
      templatesRoot: TEMPLATES_ROOT,
      cwd: '/this/path/does/not/exist',
    });

    expect(report.checks.find((check) => check.name === 'Working directory')?.status).toBe('FAIL');
  });

  it('gives every non-passing check a remedy', async () => {
    const report = await runDoctor({ probe: nonePresent, templatesRoot: null, cwd: '/nope' });

    for (const check of report.checks.filter((entry) => entry.status !== 'PASS')) {
      expect(check.remedy, `${check.name} has no remedy`).toBeTruthy();
    }
  });
});

describe('printDoctorReport', () => {
  it('renders PASS, WARN and FAIL, and returns the exit code', async () => {
    const report = await runDoctor({ probe: nonePresent, templatesRoot: null });
    const output = createCapturingOutput();

    const code = printDoctorReport(report, {}, output);
    const text = output.lines.join('\n');

    expect(code).toBe(1);
    expect(text).toContain('PASS');
    expect(text).toContain('WARN');
    expect(text).toContain('FAIL');
    // Warnings are explicitly framed as not-a-problem.
    expect(text).toContain('optional tooling; not a problem');
  });

  it('emits JSON with --json', async () => {
    const report = await runDoctor({ probe: allPresent, templatesRoot: TEMPLATES_ROOT });
    const output = createCapturingOutput();

    const code = printDoctorReport(report, { json: true }, output);
    const parsed = JSON.parse(output.lines.join('\n')) as { ok: boolean; checks: unknown[] };

    expect(code).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toHaveLength(7);
  });

  it('says the machine is ready when nothing failed', async () => {
    const report = await runDoctor({ probe: allPresent, templatesRoot: TEMPLATES_ROOT });
    const output = createCapturingOutput();

    printDoctorReport(report, {}, output);
    expect(output.lines.join('\n')).toContain('Ready to generate TrustOS applications.');
  });
});

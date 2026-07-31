import { describe, expect, it } from 'vitest';
import { runQualityGates, assertGatesPassed, waiverSchema, COVERAGE_FLOOR } from './index';

/** The tests are about *which* gates may be waived, which is the only real decision here. */

const clean = {
  files: [{ path: 'packages/a/src/thing.ts', content: 'export const x = 1;\n' }],
  tests: { passed: 10, failed: 0 },
  coverage: { lines: 92 },
  lint: { errors: 0, warnings: 3 },
  formatting: { unformattedFiles: 0 },
  now: new Date('2026-07-01'),
};

describe('gates', () => {
  it('passes a clean change', () => {
    const report = runQualityGates(clean);

    expect(report.passed).toBe(true);
    expect(report.blocking).toEqual([]);
  });

  it('skips a gate it has no data for rather than passing it', () => {
    // A gate that passes because nothing was measured is a gate that always passes.
    const report = runQualityGates({ now: clean.now });

    expect(report.results.every((result) => result.status === 'skipped')).toBe(true);
  });

  it('fails when no tests ran', () => {
    // A suite that runs nothing reports green, and a change that deletes the tests it breaks
    // passes every other gate.
    const report = runQualityGates({ ...clean, tests: { passed: 0, failed: 0 } });

    expect(report.blocking.map((result) => result.gate)).toContain('testing');
  });

  it('fails below the coverage floor', () => {
    const report = runQualityGates({ ...clean, coverage: { lines: COVERAGE_FLOOR - 1 } });

    expect(report.blocking.map((result) => result.gate)).toEqual(['coverage']);
  });

  it('never blocks on performance', () => {
    /*
     * A number from a shared CI machine. Failing a build on it teaches people to re-run until it
     * passes, which destroys the signal and the habit together.
     */
    const report = runQualityGates({
      ...clean,
      performance: { budgetMs: 100, measuredMs: 900, label: 'boot' },
    });

    expect(report.passed).toBe(true);
    expect(report.results.find((result) => result.gate === 'performance')?.status).toBe('fail');
  });

  it('catches a security violation through the architecture rules', () => {
    const report = runQualityGates({
      ...clean,
      files: [
        {
          path: 'packages/a/src/bad.ts',
          content: "const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz012345';\n",
        },
      ],
    });

    expect(report.blocking.map((result) => result.gate)).toContain('security');
  });
});

describe('waivers', () => {
  const waiver = {
    gate: 'coverage' as const,
    reason: 'Coverage drops while the reporting module is being rewritten.',
    approvedBy: 'platform-team',
    expiresAt: '2026-08-01',
  };

  it('lets a waived gate pass and says who signed it off', () => {
    const report = runQualityGates({
      ...clean,
      coverage: { lines: 40 },
      waivers: [waiver],
    });

    expect(report.passed).toBe(true);
    expect(report.waived[0]?.detail).toMatch(/Waived by platform-team until 2026-08-01/);
  });

  it('lets an expired waiver lapse so the gate fails again', () => {
    // A waiver buys time; when the time is up the problem is back rather than forgotten.
    const report = runQualityGates({
      ...clean,
      coverage: { lines: 40 },
      waivers: [{ ...waiver, expiresAt: '2026-06-01' }],
    });

    expect(report.passed).toBe(false);
  });

  it('refuses a waiver on a gate that cannot be waived', () => {
    /*
     * The first time a security gate fires under deadline pressure the waiver is used, and then
     * it is always used.
     */
    for (const gate of ['security', 'architecture', 'testing'] as const) {
      expect(() => waiverSchema.parse({ ...waiver, gate })).toThrow();
    }
  });

  it('refuses a waiver with no expiry', () => {
    expect(() =>
      waiverSchema.parse({ gate: 'lint', reason: 'x'.repeat(20), approvedBy: 'me' }),
    ).toThrow();
  });

  it('refuses a waiver with a token reason', () => {
    expect(() =>
      waiverSchema.parse({
        gate: 'lint',
        reason: 'later',
        approvedBy: 'me',
        expiresAt: '2026-08-01',
      }),
    ).toThrow();
  });
});

describe('assertGatesPassed', () => {
  it('names every failing gate', () => {
    const report = runQualityGates({
      ...clean,
      coverage: { lines: 10 },
      lint: { errors: 4, warnings: 0 },
    });

    expect(() => assertGatesPassed(report)).toThrow(/coverage.*lint|lint.*coverage/s);
  });
});

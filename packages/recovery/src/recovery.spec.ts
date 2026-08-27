import { describe, expect, it } from 'vitest';
import { BackupInventory, assuranceOf, backupRecordSchema } from '@trustos/backup';
import {
  RESTORE_CHECKS,
  assertTestValidates,
  evaluateRestoreTest,
  measuredRestoreMinutes,
  recoveryProcedureSchema,
  restoreTestSchema,
  reviewProcedures,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const REQUIRED = RESTORE_CHECKS.filter((check) => check !== 'sample_records_readable');

function checks(overrides: Partial<Record<string, boolean>> = {}) {
  return REQUIRED.map((check) => ({
    check,
    passed: overrides[check] ?? true,
    detail: overrides[check] === false ? 'Observed a mismatch against the source snapshot.' : null,
  }));
}

function test(overrides: Record<string, unknown> = {}) {
  return restoreTestSchema.parse({
    restoreTestId: 'rt_20260515',
    backupId: 'bk_pg_20260601',
    source: 'postgresql',
    procedureId: 'rp.postgres-full',
    targetEnvironment: 'isolated',
    isolationNotes:
      'Restored into a throwaway namespace with no network route to production and its own credentials.',
    startedAt: '2026-05-15T02:00:00.000Z',
    completedAt: '2026-05-15T02:47:00.000Z',
    checks: checks(),
    performedBy: 'usr_platform',
    observations: 'The index rebuild took nineteen minutes, which the procedure does not mention.',
    ...overrides,
  });
}

function backup(overrides: Record<string, unknown> = {}) {
  return backupRecordSchema.parse({
    backupId: 'bk_pg_20260601',
    source: 'postgresql',
    scope: 'trustos_production',
    environment: 'production',
    startedAt: '2026-06-01T02:00:00.000Z',
    completedAt: '2026-06-01T02:14:00.000Z',
    location: 's3://trustos-backups-eu/postgres/2026-06-01.dump',
    sameFailureDomain: false,
    encrypted: true,
    encryptionMethod: 'AES-256-GCM, key held in the platform KMS.',
    classification: 'HIGHLY_RESTRICTED',
    retentionDays: 3650,
    checksum: 'sha256:9f2c4a1b7e33',
    checksumVerifiedAt: '2026-06-01T02:20:00.000Z',
    verifiedAt: '2026-06-01T02:30:00.000Z',
    verificationNotes: 'Row counts match the source within the replication window.',
    ...overrides,
  });
}

function procedure(overrides: Record<string, unknown> = {}) {
  return recoveryProcedureSchema.parse({
    procedureId: 'rp.postgres-full',
    title: 'Full PostgreSQL restore',
    source: 'postgresql',
    appliesTo: 'The primary database is unavailable or its contents are corrupt.',
    steps: [
      {
        title: 'Provision an isolated target',
        action: 'Create a namespace with no route to production and its own database credentials.',
        verification: 'The target cannot resolve the production database host.',
        observedMinutes: 6,
      },
      {
        title: 'Load the dump',
        action: 'Restore the most recent verified dump into the target.',
        verification: 'The restore command exits zero and the schema version matches.',
        observedMinutes: 22,
      },
    ],
    decisionAuthority: 'Platform lead, or the incident commander during a declared SEV1.',
    ownerId: 'usr_platform',
    lastReviewedAt: '2026-04-01T00:00:00.000Z',
    lastExercisedAt: '2026-05-15T02:47:00.000Z',
    ...overrides,
  });
}

describe('where a restore test runs', () => {
  it('cannot target production', () => {
    /*
     * A restore test that writes to production is an outage with a rehearsal attached. This is the
     * one refusal here that would be inconvenient to work around, which is the point.
     */
    expect(() => test({ targetEnvironment: 'production' })).toThrow();
  });

  it('says how the target was isolated', () => {
    // So a reader can judge whether it really was, rather than taking the word "isolated" for it.
    expect(test().isolationNotes).toContain('no network route');
  });
});

describe('evaluating a restore test', () => {
  it('passes when every required check passed', () => {
    const outcome = evaluateRestoreTest(test());
    expect(outcome.succeeded).toBe(true);
    expect(outcome.durationMinutes).toBe(47);
  });

  it('fails on a failed check', () => {
    const outcome = evaluateRestoreTest(test({ checks: checks({ ledger_balances: false }) }));

    expect(outcome.succeeded).toBe(false);
    expect(outcome.failedChecks).toEqual(['ledger_balances']);
  });

  it('reports an omitted check separately from a failed one', () => {
    /*
     * Treating them the same lets a test pass by leaving out the check it would have failed, and
     * the omission is invisible in a summary that counts only failures.
     */
    const partial = test({ checks: checks().filter((entry) => entry.check !== 'ledger_balances') });
    const outcome = evaluateRestoreTest(partial);

    expect(outcome.failedChecks).toEqual([]);
    expect(outcome.missingChecks).toEqual(['ledger_balances']);
    expect(outcome.reason).toContain('not a check that passed');
  });

  it('treats a restored ledger that does not balance as a failure, not a caveat', () => {
    // Corrupt data presented as a recovery, discovered later by a reconciliation nobody connects to it.
    expect(
      evaluateRestoreTest(test({ checks: checks({ ledger_balances: false }) })).succeeded,
    ).toBe(false);
  });

  it('requires a failed check to say what was observed', () => {
    expect(() =>
      test({
        checks: [{ check: 'schema_matches', passed: false, detail: null }],
      }),
    ).toThrow(/says what was observed/);
  });

  it('refuses a check recorded twice', () => {
    expect(() =>
      test({
        checks: [
          { check: 'database_restored', passed: true, detail: null },
          {
            check: 'database_restored',
            passed: false,
            detail: 'Actually it failed on the second attempt.',
          },
        ],
      }),
    ).toThrow(/recorded twice/);
  });

  it('measures the duration rather than accepting an estimate', () => {
    // From the timestamps, and this is the number an RTO should be derived from.
    expect(
      evaluateRestoreTest(test({ completedAt: '2026-05-15T04:00:00.000Z' })).durationMinutes,
    ).toBe(120);
  });
});

describe('validating a backup from a test', () => {
  it('lets a successful test complete the backup', () => {
    /*
     * The gate between the packages: a backup's strongest claim can only be set from an event that
     * actually happened.
     */
    const inventory = new BackupInventory([backup()]);
    const outcome = assertTestValidates({
      test: test(),
      backup: inventory.require('bk_pg_20260601'),
    });

    const updated = inventory.recordRestoreTest({
      backupId: 'bk_pg_20260601',
      restoreTestId: outcome.restoreTestId,
      at: test().completedAt,
    });

    expect(assuranceOf(updated).fullyValidated).toBe(true);
  });

  it('refuses a failed test', () => {
    expect(() =>
      assertTestValidates({
        test: test({ checks: checks({ application_starts: false }) }),
        backup: backup(),
      }),
    ).toThrow(/did not succeed/);
  });

  it('refuses a test that restored a different backup', () => {
    expect(() =>
      assertTestValidates({ test: test({ backupId: 'bk_pg_20260401' }), backup: backup() }),
    ).toThrow(/validates the backup it restored/);
  });
});

describe('the measured restore time', () => {
  it('takes the slowest successful run, not the fastest', () => {
    /*
     * An RTO set from the best run is an RTO met once. The number that matters is what happens when
     * the restore is slow, because that is the run that coincides with the incident.
     */
    const measured = measuredRestoreMinutes(
      [test(), test({ restoreTestId: 'rt_20260401', completedAt: '2026-05-15T04:00:00.000Z' })],
      'postgresql',
    );

    expect(measured?.minutes).toBe(120);
    expect(measured?.sampleSize).toBe(2);
  });

  it('ignores failed runs', () => {
    const measured = measuredRestoreMinutes(
      [
        test(),
        test({
          restoreTestId: 'rt_failed',
          completedAt: '2026-05-15T06:00:00.000Z',
          checks: checks({ ledger_balances: false }),
        }),
      ],
      'postgresql',
    );

    expect(measured?.minutes).toBe(47);
  });

  it('has no answer when nothing was ever restored', () => {
    // Which is what the continuity gap analysis needs to hear, rather than a plausible default.
    expect(measuredRestoreMinutes([], 'postgresql')).toBeNull();
  });
});

describe('reviewing procedures', () => {
  it('finds one nobody has ever followed', () => {
    /*
     * The finding that matters. A procedure written eighteen months ago refers to a console that
     * has been redesigned and a role that was renamed, and none of that is visible from reading it.
     */
    const findings = reviewProcedures({
      procedures: [procedure({ lastExercisedAt: null })],
      tests: [],
      at: NOW,
    });

    expect(findings[0]?.kind).toBe('never_exercised');
    expect(findings[0]?.severity).toBe('high');
  });

  it('counts a restore test as having exercised it', () => {
    const findings = reviewProcedures({
      procedures: [procedure({ lastExercisedAt: null })],
      tests: [test()],
      at: NOW,
    });

    expect(findings.some((finding) => finding.kind === 'never_exercised')).toBe(false);
  });

  it('finds one that has gone stale', () => {
    const findings = reviewProcedures({
      procedures: [procedure({ lastExercisedAt: '2025-01-01T00:00:00.000Z' })],
      tests: [],
      at: NOW,
    });

    expect(findings.some((finding) => finding.kind === 'stale_procedure')).toBe(true);
  });

  it('finds one with no measured step durations', () => {
    // Any RTO derived from it is an estimate, and the estimate is always shorter than the run.
    const unmeasured = procedure({
      steps: procedure().steps.map((step) => ({ ...step, observedMinutes: null })),
    });

    const findings = reviewProcedures({ procedures: [unmeasured], tests: [test()], at: NOW });
    expect(findings.some((finding) => finding.kind === 'no_measured_duration')).toBe(true);
  });

  it('is quiet about a well-kept procedure', () => {
    expect(reviewProcedures({ procedures: [procedure()], tests: [test()], at: NOW })).toHaveLength(
      0,
    );
  });
});

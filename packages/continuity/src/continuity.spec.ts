import { describe, expect, it } from 'vitest';
import { ServiceRegistry, runbookSchema, serviceSchema } from '@trustsystem/sre-core';
import { BackupInventory, backupRecordSchema } from '@trustsystem/backup';
import { restoreTestSchema, RESTORE_CHECKS } from '@trustsystem/recovery';
import { drPlanSchema } from '@trustsystem/disaster-recovery';
import {
  assertContinuityProven,
  businessProcessSchema,
  continuityStatus,
  gapAnalysis,
  observedBackupIntervalMinutes,
  tierMismatches,
} from './index';

function process(overrides: Record<string, unknown> = {}) {
  return businessProcessSchema.parse({
    processId: 'bp.accept-payment',
    name: 'Accepting a merchant payment',
    description: 'A merchant accepts a payment, it is priced, recorded and posted to the ledger.',
    criticality: 'critical',
    rtoMinutes: 60,
    rpoMinutes: 1440,
    serviceIds: ['payments.api'],
    backupSources: ['postgresql'],
    drPlanIds: ['dr.region-failure'],
    ownerId: 'usr_product',
    approvedByBusinessOwner: true,
    manualWorkaround: null,
    lastReviewedAt: '2026-05-01T00:00:00.000Z',
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
    lastRestoreTestAt: '2026-05-15T02:47:00.000Z',
    lastRestoreTestId: 'rt_20260515',
    ...overrides,
  });
}

function dailyInventory() {
  return new BackupInventory([
    backup(),
    backup({
      backupId: 'bk_pg_20260531',
      startedAt: '2026-05-31T02:00:00.000Z',
      completedAt: '2026-05-31T02:14:00.000Z',
    }),
  ]);
}

function restoreTest(overrides: Record<string, unknown> = {}) {
  return restoreTestSchema.parse({
    restoreTestId: 'rt_20260515',
    backupId: 'bk_pg_20260601',
    source: 'postgresql',
    procedureId: 'rp.postgres-full',
    targetEnvironment: 'isolated',
    isolationNotes: 'Restored into a throwaway namespace with no network route to production.',
    startedAt: '2026-05-15T02:00:00.000Z',
    completedAt: '2026-05-15T02:47:00.000Z',
    checks: RESTORE_CHECKS.filter((check) => check !== 'sample_records_readable').map((check) => ({
      check,
      passed: true,
      detail: null,
    })),
    performedBy: 'usr_platform',
    ...overrides,
  });
}

function drPlan(overrides: Record<string, unknown> = {}) {
  return drPlanSchema.parse({
    planId: 'dr.region-failure',
    scenario: 'region_failure',
    title: 'Primary region unavailable',
    trigger:
      'Every instance in the primary region fails readiness for more than ten minutes and the provider confirms a regional event.',
    serviceIds: ['payments.api'],
    ownerId: 'usr_platform',
    decisionAuthority: 'Head of Platform',
    deputyAuthority: 'On-call platform lead',
    procedure: [
      {
        title: 'Confirm the region is genuinely unavailable',
        action: 'Probe from a second region before failing over.',
        verification: 'Two independent probes agree.',
        performedBy: 'Platform on-call',
      },
    ],
    dataDecision:
      'Fail over at the standby last confirmed replication position; later writes replay from the event log.',
    communication: {
      audiences: ['Merchants with active integrations'],
      channels: ['Status page hosted outside the primary region'],
      spokespersonRole: 'Head of Platform',
      cadenceMinutes: 30,
    },
    validation: ['A synthetic payment completes end to end against the recovered region.'],
    failback: {
      procedure:
        'Resynchronize from the secondary, verify balance, and cut back during a scheduled window.',
      dataReconciliation:
        'Writes during failover are replayed into the primary and reconciled against the ledger.',
      decisionAuthority: 'Head of Platform with the finance controller',
    },
    rtoMinutes: 60,
    rpoMinutes: 5,
    lastReviewedAt: '2026-04-15T00:00:00.000Z',
    exercises: [
      {
        exerciseId: 'ex_20260401',
        performedAt: '2026-04-01T00:00:00.000Z',
        kind: 'full',
        achievedMinutes: 42,
        succeeded: true,
        findings: [],
        evidenceRef: 'docs/dr/evidence/2026-04-01.md',
      },
    ],
    ...overrides,
  });
}

describe('setting targets', () => {
  it('does not default them', () => {
    // The specification is explicit: do not invent targets. A default becomes everybody's number.
    expect(() => businessProcessSchema.parse({ ...process(), rtoMinutes: undefined })).toThrow();
    expect(() => businessProcessSchema.parse({ ...process(), rpoMinutes: undefined })).toThrow();
  });

  it('refuses a critical process with a target that is not critical', () => {
    expect(() => process({ rtoMinutes: 2880 })).toThrow(/is not critical/);
  });

  it('requires the business to sign off on a critical process', () => {
    // The cost of meeting an RTO is a business decision, not an engineering proposal.
    expect(() => process({ approvedByBusinessOwner: false })).toThrow(/signed off by the business/);
  });
});

describe('the gap between promised and demonstrated', () => {
  it('reports an RTO nobody has measured as unproven, not as met', () => {
    /*
     * Neither met nor missed. An RTO with no measurement behind it is aspiration formatted as
     * commitment, and reporting it as met is how a scorecard stops meaning anything.
     */
    const gaps = gapAnalysis({ processes: [process()] });

    expect(gaps[0]?.kind).toBe('unproven');
    expect(gaps[0]?.demonstratedMinutes).toBeNull();
  });

  it('reports an RTO the evidence does not support', () => {
    const gaps = gapAnalysis({
      processes: [process()],
      restoreTests: [restoreTest({ completedAt: '2026-05-15T04:00:00.000Z' })],
      drPlans: [drPlan()],
    });

    expect(gaps[0]?.kind).toBe('unmet');
    expect(gaps[0]?.demonstratedMinutes).toBe(120);
    expect(gaps[0]?.evidence).toBe('rt_20260515');
  });

  it('takes the worst demonstrated number, not the best', () => {
    /*
     * Recovery is sequential in practice — the database restores, then the application starts,
     * then the failover completes. Taking the best describes a recovery nobody has performed.
     */
    const gaps = gapAnalysis({
      processes: [process({ rtoMinutes: 45 })],
      restoreTests: [restoreTest()],
      drPlans: [drPlan()],
    });

    // The failover took 42 minutes and the restore took 47. Reporting 42 describes a recovery
    // that skipped the restore.
    expect(gaps[0]?.demonstratedMinutes).toBe(47);
  });

  it('is quiet when the evidence supports the target', () => {
    const gaps = gapAnalysis({
      processes: [process()],
      restoreTests: [restoreTest()],
      drPlans: [drPlan()],
    });

    expect(gaps).toHaveLength(0);
  });
});

describe('an RPO that cannot be met', () => {
  it('calls a zero RPO against daily backups unfounded, not merely unmet', () => {
    /*
     * The finding worth having. This is arithmetic, not a shortfall to work on: up to a day of data
     * would be lost whatever the target says — and the target reads perfectly reasonably in a
     * spreadsheet, which is why it survives review after review.
     */
    const gaps = gapAnalysis({
      processes: [process({ rpoMinutes: 0 })],
      inventory: dailyInventory(),
      restoreTests: [restoreTest()],
      drPlans: [drPlan()],
    });

    const rpo = gaps.find((gap) => gap.objective === 'rpo');
    expect(rpo?.kind).toBe('unfounded');
    expect(rpo?.detail).toContain('arithmetic');
    expect(rpo?.demonstratedMinutes).toBe(1440);
  });

  it('accepts a daily RPO against daily backups', () => {
    const gaps = gapAnalysis({
      processes: [process()],
      inventory: dailyInventory(),
      restoreTests: [restoreTest()],
      drPlans: [drPlan()],
    });

    expect(gaps).toHaveLength(0);
  });

  it('reads the interval from what happened, not from what was scheduled', () => {
    // The schedule is the intent; the gap between completions is the fact.
    expect(observedBackupIntervalMinutes(dailyInventory(), 'postgresql', 'production')).toBe(1440);
  });

  it('says the recovery point is unknown when there is only one backup', () => {
    const gaps = gapAnalysis({
      processes: [process()],
      inventory: new BackupInventory([backup()]),
      restoreTests: [restoreTest()],
      drPlans: [drPlan()],
    });

    expect(gaps[0]?.kind).toBe('unproven');
  });
});

describe('the dashboard row', () => {
  function status(overrides: Record<string, unknown> = {}) {
    return continuityStatus({
      process: process(),
      inventory: dailyInventory(),
      restoreTests: [restoreTest()],
      drPlans: [drPlan()],
      ...overrides,
    });
  }

  it('reaches proven only with a restore, an exercise and no gaps', () => {
    /*
     * Deliberately hard. A dashboard where most rows are green because green is the default teaches
     * its readers to ignore it.
     */
    expect(status().state).toBe('proven');
  });

  it('is unproven when nothing was ever restored', () => {
    expect(
      status({
        inventory: new BackupInventory([
          backup({ lastRestoreTestAt: null, lastRestoreTestId: null }),
        ]),
        restoreTests: [],
      }).state,
    ).toBe('unproven');
  });

  it('is at risk when a target is contradicted by evidence', () => {
    expect(status({ process: process({ rtoMinutes: 30 }) }).state).toBe('at_risk');
  });

  it('is partial when a plan exists and has never been exercised', () => {
    expect(status({ drPlans: [drPlan({ exercises: [] })] }).state).toBe('partial');
  });

  it('carries the dates the dashboard shows', () => {
    const row = status();
    expect(row.lastSuccessfulBackupAt).toBe('2026-06-01T02:14:00.000Z');
    expect(row.lastRestoreTestAt).toBe('2026-05-15T02:47:00.000Z');
    expect(row.drPlansExercised).toBe(1);
  });

  it('refuses to be reported as passing on anything less', () => {
    // Never mark PASS without evidence, as a function rather than as reviewer discipline.
    expect(() => assertContinuityProven(status())).not.toThrow();

    const neverRestored = status({
      inventory: new BackupInventory([
        backup({ lastRestoreTestAt: null, lastRestoreTestId: null }),
      ]),
      restoreTests: [],
    });

    expect(() => assertContinuityProven(neverRestored)).toThrow(/cannot be reported/);
  });
});

describe('tier mismatches', () => {
  it('finds a critical process running on a service nobody is woken for', () => {
    /*
     * The 3am surprise: the business calls the process critical, the service registry calls it
     * tier 3, and therefore nobody is on call for it. Each record is internally consistent.
     */
    const registry = new ServiceRegistry({
      runbooks: [
        runbookSchema.parse({
          runbookId: 'rb.outage',
          title: 'Outage',
          trigger: 'The service is unavailable for more than two minutes.',
          severityHint: 'SEV2',
          steps: [
            { title: 'Confirm', action: 'Check readiness on every instance.', verification: null },
          ],
          escalateTo: 'Platform on-call.',
          lastReviewedAt: '2026-05-01T00:00:00.000Z',
          ownerId: 'usr_platform',
        }),
      ],
      services: [
        serviceSchema.parse({
          serviceId: 'payments.api',
          name: 'Payments API',
          description: 'Accepts payment requests and posts them to the ledger.',
          tier: 'tier_3',
          ownerTeam: 'payments',
          onCallRotation: null,
          runbookIds: [],
          environment: 'production',
          registeredAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    });

    const mismatches = tierMismatches({ processes: [process()], registry });

    expect(mismatches[0]?.tier).toBe('tier_3');
    expect(mismatches[0]?.detail).toContain('nobody on call');
  });

  it('is quiet when the tier matches the criticality', () => {
    const registry = {
      get: () => ({ tier: 'tier_1', onCallRotation: 'payments-primary' }),
    } as never;
    expect(tierMismatches({ processes: [process()], registry })).toHaveLength(0);
  });
});

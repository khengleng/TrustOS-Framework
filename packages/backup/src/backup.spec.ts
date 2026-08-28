import { describe, expect, it } from 'vitest';
import {
  BackupInventory,
  assertFullyValidated,
  assuranceOf,
  backupRecordSchema,
  describeAssurance,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

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
    sizeBytes: 4_812_003_221,
    encrypted: true,
    encryptionMethod: 'AES-256-GCM, key held in the platform KMS.',
    classification: 'HIGHLY_RESTRICTED',
    retentionDays: 3650,
    checksum: 'sha256:9f2c4a1b7e33',
    checksumVerifiedAt: '2026-06-01T02:20:00.000Z',
    verifiedAt: '2026-06-01T02:30:00.000Z',
    verificationNotes:
      'Row counts match the source within the replication window; all expected tables present.',
    lastRestoreTestAt: '2026-05-15T00:00:00.000Z',
    lastRestoreTestId: 'rt_20260515',
    ...overrides,
  });
}

describe('the four claims', () => {
  it('does not call a completed job a validated backup', () => {
    /*
     * The sentence the package is built around. A job that exits zero has written bytes somewhere.
     * It has not established that they are complete, readable, or that anything can be
     * reconstructed from them.
     */
    const assurance = assuranceOf(
      backup({
        checksumVerifiedAt: null,
        verifiedAt: null,
        lastRestoreTestAt: null,
        lastRestoreTestId: null,
      }),
    );

    expect(assurance.completed).toBe(true);
    expect(assurance.fullyValidated).toBe(false);
  });

  it('still refuses when only the restore is missing', () => {
    // Checksummed and inspected is a strong claim. It is not evidence that a restore works.
    const assurance = assuranceOf(backup({ lastRestoreTestAt: null, lastRestoreTestId: null }));

    expect(assurance.contentsVerified).toBe(true);
    expect(assurance.fullyValidated).toBe(false);
    expect(assurance.outstanding.join(' ')).toContain('hypothesis');
  });

  it('accepts all four', () => {
    expect(assuranceOf(backup()).fullyValidated).toBe(true);
    expect(() => assertFullyValidated(backup())).not.toThrow();
  });

  it('describes thin evidence unflatteringly', () => {
    /*
     * Read by the readiness scorecard, which must never mark a backup item as passing on the
     * strength of a job that exited zero.
     */
    const description = describeAssurance(
      backup({
        checksumVerifiedAt: null,
        verifiedAt: null,
        lastRestoreTestAt: null,
        lastRestoreTestId: null,
      }),
    );

    expect(description).toContain('the job completed');
    expect(description).toContain('hypothesis');
  });

  it('names what is outstanding when it refuses', () => {
    try {
      assertFullyValidated(backup({ lastRestoreTestAt: null, lastRestoreTestId: null }));
      expect.unreachable('should have refused');
    } catch (error) {
      const outstanding =
        (error as { context?: { outstanding?: string[] } }).context?.outstanding ?? [];
      expect(outstanding).toHaveLength(1);
    }
  });
});

describe('recording a backup', () => {
  it('requires a database backup to be encrypted', () => {
    expect(() => backup({ encrypted: false, encryptionMethod: null })).toThrow(/is encrypted/);
  });

  it('requires encryption to say how', () => {
    /*
     * "Encrypted" covers a managed volume and an encrypted archive, and only one of those survives
     * somebody copying the volume.
     */
    expect(() => backup({ encryptionMethod: null })).toThrow(/Say how/);
  });

  it('refuses a verified checksum with no checksum', () => {
    expect(() => backup({ checksum: null })).toThrow(/nothing to compare against/);
  });

  it('refuses a backup that both completed and failed', () => {
    expect(() => backup({ failureReason: 'The connection dropped at 40%.' })).toThrow(
      /either completed or failed/,
    );
  });

  it('requires a restore-test claim to name its report', () => {
    // Otherwise the strongest claim in the record is the one with no evidence behind it.
    expect(() => backup({ lastRestoreTestId: null })).toThrow(/names its report/);
  });
});

describe('the inventory', () => {
  it('keeps failures', () => {
    /*
     * An inventory of successes cannot answer the question that matters after an incident: when
     * did this last work, and how many times did it fail before anybody noticed?
     */
    const inventory = new BackupInventory([
      backup(),
      backup({
        backupId: 'bk_pg_20260602',
        completedAt: null,
        checksum: null,
        checksumVerifiedAt: null,
        verifiedAt: null,
        verificationNotes: null,
        lastRestoreTestAt: null,
        lastRestoreTestId: null,
        failureReason: 'The connection to the backup volume dropped at 40%.',
      }),
    ]);

    expect(inventory.list()).toHaveLength(2);
    expect(inventory.lastSuccessful('postgresql', 'production')?.backupId).toBe('bk_pg_20260601');
  });

  it('finds a backup nobody has ever restored', () => {
    const inventory = new BackupInventory([
      backup({ lastRestoreTestAt: null, lastRestoreTestId: null }),
    ]);
    const finding = inventory.analyse(NOW).find((entry) => entry.kind === 'never_restored');

    expect(finding?.severity).toBe('high');
  });

  it('finds a backup stored where its own outage would take it', () => {
    // Whatever takes out the source takes out the backup, and that is discovered during the outage.
    const inventory = new BackupInventory([backup({ sameFailureDomain: true })]);

    expect(inventory.analyse(NOW).some((entry) => entry.kind === 'same_failure_domain')).toBe(true);
  });

  it('finds one that has gone stale', () => {
    const inventory = new BackupInventory([backup()]);
    expect(
      inventory
        .analyse(new Date('2026-06-05T00:00:00.000Z'))
        .some((entry) => entry.kind === 'stale'),
    ).toBe(true);
  });

  it('reports a failure and stops there', () => {
    // A failed backup has no age, no checksum and no restore to comment on.
    const inventory = new BackupInventory([
      backup({
        completedAt: null,
        checksum: null,
        checksumVerifiedAt: null,
        verifiedAt: null,
        verificationNotes: null,
        lastRestoreTestAt: null,
        lastRestoreTestId: null,
        failureReason: 'Out of disk on the backup volume.',
      }),
    ]);

    expect(inventory.analyse(NOW).map((entry) => entry.kind)).toEqual(['failed']);
  });

  it('notes retention shorter than the classification suggests', () => {
    const inventory = new BackupInventory([backup({ retentionDays: 30 })]); // 30 days for HIGHLY_RESTRICTED
    const finding = inventory
      .analyse(NOW)
      .find((entry) => entry.kind === 'retention_below_classification');

    expect(finding?.severity).toBe('low');
  });

  it('is quiet about a well-kept backup', () => {
    expect(new BackupInventory([backup()]).analyse(NOW)).toHaveLength(0);
  });

  it('records a restore test against a backup', () => {
    const inventory = new BackupInventory([
      backup({ lastRestoreTestAt: null, lastRestoreTestId: null }),
    ]);
    const updated = inventory.recordRestoreTest({
      backupId: 'bk_pg_20260601',
      restoreTestId: 'rt_20260601',
      at: '2026-06-01T06:00:00.000Z',
    });

    expect(assuranceOf(updated).fullyValidated).toBe(true);
  });

  it('answers when a source was last restored from', () => {
    const inventory = new BackupInventory([backup()]);
    expect(inventory.lastRestoreTested('postgresql', 'production')?.lastRestoreTestAt).toBe(
      '2026-05-15T00:00:00.000Z',
    );
  });

  it('says nothing was ever restored when nothing was', () => {
    const inventory = new BackupInventory([
      backup({ lastRestoreTestAt: null, lastRestoreTestId: null }),
    ]);
    expect(inventory.lastRestoreTested('postgresql', 'production')).toBeNull();
  });
});

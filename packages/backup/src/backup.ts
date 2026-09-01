import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { DATA_CLASSIFICATION_LEVELS, obligationsFor } from '@trustsystem/data-classification';

/**
 * The backup inventory.
 *
 * One sentence in the specification determines the whole design: *do not assume backup success
 * from job completion alone*. A job that exits zero has written bytes somewhere. It has not
 * established that the bytes are complete, that they are readable, that they are encrypted, or
 * that anything can be reconstructed from them — and every one of those has failed in production
 * somewhere while the job kept reporting success.
 *
 * So a backup here has **four independent states**, and they are separate fields rather than one
 * status enum, because a status enum forces a false ordering and somebody eventually sets it to
 * "verified" from the job runner:
 *
 *   `completed`  the job finished. The weakest claim, and the only one a job can make itself.
 *   `checksum`   the bytes read back match what was written. Catches truncation and bit rot.
 *   `verified`   the backup was inspected — row counts, schema, expected tables.
 *   `restored`   a restore was actually performed and the result checked. The only claim that
 *                means what "we have backups" is usually taken to mean.
 *
 * `fullyValidated` requires the last one. A backup that has never been restored is a hypothesis.
 */

export const BACKUP_SOURCES = [
  'postgresql',
  'configuration',
  'file_storage',
  'product_definitions',
  'policies',
  'workflow_definitions',
  'audit_archive',
  'secrets_metadata',
] as const;
export type BackupSource = (typeof BACKUP_SOURCES)[number];

/**
 * What each source needs, beyond bytes.
 *
 * `audit_archive` is the interesting entry: an audit trail is append-only and legally significant,
 * so a backup of it that cannot be shown to be unmodified is not evidence of anything. It requires
 * a checksum, always.
 */
export const SOURCE_REQUIREMENTS: Record<
  BackupSource,
  {
    readonly description: string;
    readonly requiresEncryption: boolean;
    readonly requiresChecksum: boolean;
    /** How stale a backup of this may be before it is a finding, in hours. */
    readonly maximumAgeHours: number;
  }
> = {
  postgresql: {
    description: 'The authoritative database. Everything else can be rebuilt; this cannot.',
    requiresEncryption: true,
    requiresChecksum: true,
    maximumAgeHours: 24,
  },
  configuration: {
    description: 'Environment configuration, excluding secret values.',
    requiresEncryption: true,
    requiresChecksum: false,
    maximumAgeHours: 168,
  },
  file_storage: {
    description: 'Uploaded documents and generated artefacts.',
    requiresEncryption: true,
    requiresChecksum: true,
    maximumAgeHours: 24,
  },
  product_definitions: {
    description: 'Financial product definitions and their versions.',
    requiresEncryption: true,
    requiresChecksum: false,
    maximumAgeHours: 168,
  },
  policies: {
    description: 'Policy documents and their approved versions.',
    requiresEncryption: true,
    requiresChecksum: false,
    maximumAgeHours: 168,
  },
  workflow_definitions: {
    description: 'Workflow definitions, including in-flight instance state.',
    requiresEncryption: true,
    requiresChecksum: false,
    maximumAgeHours: 24,
  },
  audit_archive: {
    description:
      'The audit trail. Append-only and legally significant, so a copy that cannot be shown to be unmodified is not evidence.',
    requiresEncryption: true,
    requiresChecksum: true,
    maximumAgeHours: 24,
  },
  secrets_metadata: {
    description:
      'Which secrets exist, where and when they rotate — never their values. A backup containing secret values is a second place they leak from.',
    requiresEncryption: true,
    requiresChecksum: true,
    maximumAgeHours: 168,
  },
};

export const backupRecordSchema = z
  .object({
    backupId: z.string().min(3).max(64),
    source: z.enum(BACKUP_SOURCES),
    /** What was backed up, specifically — the database name, the bucket, the path. */
    scope: z.string().min(3).max(300),
    environment: z.enum(['development', 'staging', 'production']),

    startedAt: z.string().datetime(),
    /** Null while a backup is running. A backup with no completion is not a backup. */
    completedAt: z.string().datetime().nullable().default(null),

    /**
     * Where it is. A location inside the same failure domain as the source is not a backup, and
     * `sameFailureDomain` says which this is rather than leaving it to be inferred from a path.
     */
    location: z.string().min(3).max(500),
    sameFailureDomain: z.boolean(),

    sizeBytes: z.number().int().nonnegative().nullable().default(null),

    encrypted: z.boolean(),
    /** How, so a reader can tell managed-at-rest encryption from an encrypted archive. */
    encryptionMethod: z.string().min(3).max(120).nullable().default(null),

    /** The classification of what is inside, which decides the residency and retention rules. */
    classification: z.enum(DATA_CLASSIFICATION_LEVELS),

    retentionDays: z.number().int().positive().max(3650),

    /** Bytes read back match bytes written. */
    checksum: z.string().min(8).max(200).nullable().default(null),
    checksumVerifiedAt: z.string().datetime().nullable().default(null),

    /** Contents inspected — row counts, schema, expected tables. */
    verifiedAt: z.string().datetime().nullable().default(null),
    verificationNotes: z.string().max(2000).nullable().default(null),

    /** A restore was actually performed from this backup and the result checked. */
    lastRestoreTestAt: z.string().datetime().nullable().default(null),
    lastRestoreTestId: z.string().min(3).max(64).nullable().default(null),

    /** Set when the job failed. A failed backup is recorded, not discarded. */
    failureReason: z.string().min(5).max(2000).nullable().default(null),

    organizationId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict()
  .superRefine((backup, ctx) => {
    const requirements = SOURCE_REQUIREMENTS[backup.source];

    if (requirements.requiresEncryption && !backup.encrypted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['encrypted'],
        message: `A ${backup.source} backup is encrypted. ${requirements.description}`,
      });
    }

    if (backup.encrypted && backup.encryptionMethod === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['encryptionMethod'],
        message:
          'Say how. "Encrypted" covers both a managed volume and an encrypted archive, and only one of those survives the volume being copied.',
      });
    }

    if (backup.checksumVerifiedAt !== null && backup.checksum === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checksum'],
        message:
          'A checksum was verified but none was recorded, so there is nothing to compare against next time.',
      });
    }

    if (backup.completedAt !== null && backup.failureReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureReason'],
        message: 'A backup either completed or failed.',
      });
    }

    if (backup.lastRestoreTestAt !== null && backup.lastRestoreTestId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastRestoreTestId'],
        message: 'A restore test names its report, or the claim has no evidence behind it.',
      });
    }
  });

export type BackupRecord = z.infer<typeof backupRecordSchema>;

/**
 * The four claims, separately.
 *
 * Separate booleans rather than a status enum, because an enum forces an order and somebody
 * eventually sets it to `verified` from the job runner that only knows about `completed`.
 */
export interface BackupAssurance {
  readonly completed: boolean;
  readonly checksumVerified: boolean;
  readonly contentsVerified: boolean;
  readonly restoreTested: boolean;
  /** All four. The only state in which "we have backups" means what people take it to mean. */
  readonly fullyValidated: boolean;
  /** What is missing, in the order it should be obtained. */
  readonly outstanding: string[];
}

export function assuranceOf(backup: BackupRecord): BackupAssurance {
  const completed = backup.completedAt !== null && backup.failureReason === null;
  const checksumVerified = backup.checksumVerifiedAt !== null;
  const contentsVerified = backup.verifiedAt !== null;
  const restoreTested = backup.lastRestoreTestAt !== null;

  const outstanding: string[] = [];
  if (!completed) outstanding.push('The job has not completed successfully.');
  if (!checksumVerified) outstanding.push('The bytes have not been read back and compared.');
  if (!contentsVerified) outstanding.push('The contents have not been inspected.');
  if (!restoreTested) {
    outstanding.push(
      'Nothing has ever been restored from it, so it is a hypothesis rather than a backup.',
    );
  }

  return {
    completed,
    checksumVerified,
    contentsVerified,
    restoreTested,
    fullyValidated: completed && checksumVerified && contentsVerified && restoreTested,
    outstanding,
  };
}

export interface BackupFinding {
  readonly kind:
    | 'never_restored'
    | 'stale'
    | 'unencrypted'
    | 'same_failure_domain'
    | 'retention_below_classification'
    | 'failed'
    | 'no_checksum';
  readonly backupId: string;
  readonly severity: 'high' | 'medium' | 'low';
  readonly detail: string;
}

/**
 * The inventory.
 *
 * Deliberately holds every attempt including failures. A backup inventory that only records
 * successes cannot answer the question that matters after an incident — "when did this last work,
 * and how many times did it fail before somebody noticed?"
 */
export class BackupInventory {
  private readonly backups = new Map<string, BackupRecord>();

  constructor(backups: readonly BackupRecord[] = []) {
    for (const backup of backups) this.record(backup);
  }

  record(backup: BackupRecord): void {
    this.backups.set(backup.backupId, backup);
  }

  get(backupId: string): BackupRecord | null {
    return this.backups.get(backupId) ?? null;
  }

  require(backupId: string): BackupRecord {
    const backup = this.get(backupId);
    if (!backup) throw ApiError.notFound(`Backup ${backupId} is not in the inventory.`);
    return backup;
  }

  list(filter: { source?: BackupSource; environment?: string } = {}): BackupRecord[] {
    return [...this.backups.values()].filter((backup) => {
      if (filter.source && backup.source !== filter.source) return false;
      if (filter.environment && backup.environment !== filter.environment) return false;
      return true;
    });
  }

  /** The most recent backup of a source that actually completed. */
  lastSuccessful(source: BackupSource, environment: string): BackupRecord | null {
    return (
      this.list({ source, environment })
        .filter((backup) => backup.completedAt !== null && backup.failureReason === null)
        .sort(
          (left, right) =>
            Date.parse(right.completedAt as string) - Date.parse(left.completedAt as string),
        )[0] ?? null
    );
  }

  /** The most recent backup of a source that has actually been restored from. */
  lastRestoreTested(source: BackupSource, environment: string): BackupRecord | null {
    return (
      this.list({ source, environment })
        .filter((backup) => backup.lastRestoreTestAt !== null)
        .sort(
          (left, right) =>
            Date.parse(right.lastRestoreTestAt as string) -
            Date.parse(left.lastRestoreTestAt as string),
        )[0] ?? null
    );
  }

  /** Record that a restore test was performed against a backup. */
  recordRestoreTest(input: { backupId: string; restoreTestId: string; at: string }): BackupRecord {
    const backup = this.require(input.backupId);

    const next = backupRecordSchema.parse({
      ...backup,
      lastRestoreTestAt: input.at,
      lastRestoreTestId: input.restoreTestId,
    });

    this.backups.set(next.backupId, next);
    return next;
  }

  analyse(at: Date): BackupFinding[] {
    const findings: BackupFinding[] = [];

    for (const backup of this.backups.values()) {
      const requirements = SOURCE_REQUIREMENTS[backup.source];

      if (backup.failureReason !== null) {
        findings.push({
          kind: 'failed',
          backupId: backup.backupId,
          severity: 'high',
          detail: `Failed: ${backup.failureReason}`,
        });
        continue;
      }

      if (backup.completedAt === null) continue;

      const ageHours = (at.getTime() - Date.parse(backup.completedAt)) / 3_600_000;

      if (backup.lastRestoreTestAt === null) {
        findings.push({
          kind: 'never_restored',
          backupId: backup.backupId,
          severity: 'high',
          detail:
            'Nothing has ever been restored from this backup. Until something has, it is an untested assumption ' +
            'rather than a recovery capability.',
        });
      }

      if (backup.sameFailureDomain) {
        findings.push({
          kind: 'same_failure_domain',
          backupId: backup.backupId,
          severity: 'high',
          detail:
            'Stored in the same failure domain as its source. Whatever takes out the source takes out the backup.',
        });
      }

      if (requirements.requiresChecksum && backup.checksum === null) {
        findings.push({
          kind: 'no_checksum',
          backupId: backup.backupId,
          severity: 'medium',
          detail: `A ${backup.source} backup carries a checksum; without one, truncation is undetectable.`,
        });
      }

      if (ageHours > requirements.maximumAgeHours) {
        findings.push({
          kind: 'stale',
          backupId: backup.backupId,
          severity: 'medium',
          detail: `${Math.floor(ageHours)}h old, against a maximum of ${requirements.maximumAgeHours}h for ${backup.source}.`,
        });
      }

      const obligations = obligationsFor(backup.classification);
      if (backup.retentionDays < obligations.defaultRetentionDays) {
        findings.push({
          kind: 'retention_below_classification',
          backupId: backup.backupId,
          severity: 'low',
          detail:
            `Retained ${backup.retentionDays} days; ${backup.classification} data carries a default of ` +
            `${obligations.defaultRetentionDays}. Confirm the shorter period is deliberate.`,
        });
      }
    }

    return findings;
  }
}

/**
 * The claim, stated exactly.
 *
 * Used by the readiness scorecard, which must never mark a backup item as passing on the strength
 * of a job that exited zero. The wording is deliberately unflattering when the evidence is thin.
 */
export function describeAssurance(backup: BackupRecord): string {
  const assurance = assuranceOf(backup);

  if (assurance.fullyValidated) {
    return `${backup.backupId}: completed, checksummed, inspected and restored from on ${backup.lastRestoreTestAt}.`;
  }

  if (!assurance.completed) {
    return `${backup.backupId}: ${backup.failureReason ?? 'has not completed'}.`;
  }

  return `${backup.backupId}: the job completed. ${assurance.outstanding.join(' ')}`;
}

/** Refuses to call a backup validated on anything less than a restore. */
export function assertFullyValidated(backup: BackupRecord): void {
  const assurance = assuranceOf(backup);
  if (assurance.fullyValidated) return;

  throw ApiError.conflict(`${backup.backupId} is not fully validated.`, {
    outstanding: assurance.outstanding,
  });
}

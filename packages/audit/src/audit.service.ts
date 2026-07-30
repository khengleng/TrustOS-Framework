import { deepRedact, getRequestContext, type LoggerPort } from '@trustos/logging';
import { createNullLogger } from '@trustos/logging';
import type {
  AuditQuery,
  AuditQueryResult,
  AuditRecord,
  AuditRecordInput,
  AuditSink,
} from './audit-record';

export interface AuditServiceOptions {
  sink: AuditSink;
  logger?: LoggerPort;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/**
 * Writes audit records.
 *
 * Three properties matter more than throughput here:
 *
 *   1. **Completeness** — request id, IP and user agent come from the ambient
 *      request context, so a call site that forgets them still produces a
 *      usable record.
 *   2. **Safety** — `before`/`after` are redacted with the same rules as the
 *      logger. An audit trail full of password hashes is a liability.
 *   3. **Non-blocking failure** — a sink failure is logged loudly but never
 *      converts a successful business operation into a 500. That is a
 *      deliberate trade: for a financial-grade action where the audit record
 *      is part of the contract, write it inside the same transaction as the
 *      change instead (see `withTransaction` in docs/architecture.md).
 */
export class AuditService {
  private readonly sink: AuditSink;
  private readonly logger: LoggerPort;
  private readonly now: () => Date;

  constructor(options: AuditServiceOptions) {
    this.sink = options.sink;
    this.logger = options.logger ?? createNullLogger();
    this.now = options.now ?? (() => new Date());
  }

  async record(input: AuditRecordInput): Promise<void> {
    const record = this.buildRecord(input);
    try {
      await this.sink.append(record);
    } catch (error) {
      this.logger.error(
        {
          action: record.action,
          entityType: record.entityType,
          entityId: record.entityId,
          actorId: record.actorId,
          organizationId: record.organizationId,
          requestId: record.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
        'audit record could not be written',
      );
    }
  }

  /**
   * Records a change as a before/after pair, keeping only the fields that
   * actually differ.
   *
   * Storing whole entities makes the trail unreadable and duplicates data that
   * has not changed; storing the delta answers the question an auditor
   * actually asks — what did this person change?
   */
  async recordChange(
    input: Omit<AuditRecordInput, 'before' | 'after'> & {
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const { before, after } = diffEntities(input.before, input.after);
    await this.record({ ...input, before, after });
  }

  query(query: AuditQuery): Promise<AuditQueryResult> {
    return this.sink.query(query);
  }

  private buildRecord(input: AuditRecordInput): AuditRecord {
    const context = getRequestContext();

    // `??` would be wrong here: an explicit `null` is a deliberate statement
    // ("this event has no actor" — a failed login), and must not fall through
    // to the ambient context. Only `undefined` means "fill this in for me".
    const supplied = <T>(value: T | undefined, fallback: T): T =>
      value === undefined ? fallback : value;

    return {
      action: input.action,
      entityType: input.entityType,
      entityId: supplied(input.entityId, null),
      actorId: supplied(input.actorId, context?.actor?.userId ?? null),
      actorType: supplied(input.actorType, context?.actor?.actorType ?? null),
      organizationId: supplied(input.organizationId, context?.organizationId ?? null),
      before: input.before === undefined ? null : deepRedact(input.before),
      after: input.after === undefined ? null : deepRedact(input.after),
      requestId: supplied(input.requestId, context?.requestId ?? null),
      ipAddress: supplied(input.ipAddress, context?.ipAddress ?? null),
      userAgent: supplied(input.userAgent, context?.userAgent ?? null),
      occurredAt: input.occurredAt ?? this.now(),
    };
  }
}

/** Reduces two entity snapshots to only the fields that differ. */
export function diffEntities(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (!before) return { before: null, after };
  if (!after) return { before, after: null };

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of keys) {
    if (!isEqual(before[key], after[key])) {
      changedBefore[key] = before[key] ?? null;
      changedAfter[key] = after[key] ?? null;
    }
  }

  return {
    before: Object.keys(changedBefore).length ? changedBefore : null,
    after: Object.keys(changedAfter).length ? changedAfter : null,
  };
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

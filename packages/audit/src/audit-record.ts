import type { OrganizationId, RequestId, UserId } from '@trustos/shared-types';

/**
 * What the caller supplies. Everything not given here is filled in from the
 * ambient request context by `AuditService`, so a call site cannot forget the
 * request id or the client IP.
 */
export interface AuditRecordInput {
  action: string;
  entityType: string;
  entityId?: string | null;

  /** Null only for genuinely unauthenticated events, e.g. a failed login. */
  actorId?: UserId | null;
  /** Null only for platform-level events that belong to no organization. */
  organizationId?: OrganizationId | null;

  /** State before the change. Redacted before it is written. */
  before?: unknown;
  /** State after the change. Redacted before it is written. */
  after?: unknown;

  /** Overrides for the ambient request context. Rarely needed. */
  requestId?: RequestId | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  occurredAt?: Date;
}

/** A complete record, as written to storage. */
export interface AuditRecord {
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: UserId | null;
  organizationId: OrganizationId | null;
  before: unknown;
  after: unknown;
  requestId: RequestId | null;
  ipAddress: string | null;
  userAgent: string | null;
  occurredAt: Date;
}

export interface AuditQuery {
  organizationId: OrganizationId | null;
  actorId?: UserId;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface AuditQueryResult {
  items: Array<AuditRecord & { id: string; createdAt: Date }>;
  totalItems: number;
}

/**
 * The storage port.
 *
 * Note what is absent: no `update`, no `delete`. The interface makes the
 * append-only rule structural rather than a convention, so no amount of
 * autocomplete leads a developer to a method that rewrites history.
 */
export interface AuditSink {
  append(record: AuditRecord): Promise<void>;
  query(query: AuditQuery): Promise<AuditQueryResult>;
}

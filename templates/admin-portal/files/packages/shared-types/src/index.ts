/**
 * Shared types — TrustOS Admin Portal.
 *
 * The shapes the API returns and the admin consumes. One definition, imported by both, so a
 * renamed field is a compile error rather than an empty column.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull a server-only
 * module into a browser bundle. The admin application imports this package directly, so anything
 * reachable from here reaches the client.
 */

/** ISO-8601 timestamp as it crosses the API boundary. */
export type IsoDateTime = string;

/** Fields every tenant-owned entity exposes. */
export interface TenantOwnedSummary {
  id: string;
  organizationId: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A runtime-editable setting. `isSecret` values are never returned by the API and never written */
/** to the audit trail — only the fact that they changed is. */
export interface SystemSetting {
  id: string;
  key: string;
  value: string;
  description: string;
  category: string;
  isSecret: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** What an operator did and why, attached to whatever they did it to. The gap the audit trail */
/** cannot fill: audit records the change, this records the reason. */
export interface OperatorNote {
  id: string;
  subjectType: string;
  subjectId: string;
  body: string;
  authorUserId: string | null;
  pinnedUntil: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

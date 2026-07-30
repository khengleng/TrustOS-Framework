/**
 * Shared types — TrustOS Staff Portal.
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

/** A colleague. Authorization is RBAC, never the job title in this row. */
export interface StaffProfile {
  id: string;
  userId: string;
  displayName: string;
  team: string | null;
  jobTitle: string | null;
  isAvailable: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something assigned to a person. A task originating from a workflow carries `workflowTaskId` */
/** and is *read* from the engine — completing it here must go through the engine, not around it. */
export interface StaffTask {
  id: string;
  assigneeUserId: string;
  title: string;
  detail: string | null;
  workflowTaskId: string | null;
  dueAt: Date | null;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  status: 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A stored filter set. Stored as declared filters, not as a raw query — a saved search that */
/** replayed arbitrary query text would be a stored injection. */
export interface SavedSearch {
  id: string;
  ownerUserId: string;
  name: string;
  resourceKey: string;
  filters: Record<string, unknown>;
  isShared: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something a colleague should look at. */
export interface StaffNotification {
  id: string;
  recipientUserId: string;
  subject: string;
  body: string;
  href: string | null;
  sentAt: Date;
  readAt: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

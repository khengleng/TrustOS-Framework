/**
 * Shared types — TrustOS Helpdesk.
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

/** Where tickets land before somebody picks them up. */
export interface TicketQueue {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Somebody who works tickets. */
export interface SupportAgent {
  id: string;
  userId: string;
  displayName: string;
  queueId: string | null;
  isAvailable: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Response and resolution targets per priority. Read by @trustos/workflow-sla; this template */
/** stores the numbers, not the clock. */
export interface SlaPolicy {
  id: string;
  name: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHoursOnly: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A request for help. */
export interface Ticket {
  id: string;
  reference: string;
  queueId: string;
  assigneeId: string | null;
  requesterName: string;
  requesterEmail: string | null;
  subject: string;
  body: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  status: 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
  openedAt: Date;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A message on a ticket. `isInternal` keeps a note away from the requester — and the API must */
/** filter on it, because a comment hidden only in the UI is still in the payload. */
export interface TicketComment {
  id: string;
  ticketId: string;
  authorUserId: string | null;
  body: string;
  isInternal: boolean;
  postedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

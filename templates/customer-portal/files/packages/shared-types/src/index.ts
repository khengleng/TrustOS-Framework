/**
 * Shared types — TrustOS Customer Portal.
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

/** What a customer can see and edit about themselves. */
export interface PortalProfile {
  id: string;
  userId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  timezone: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A file made available to a customer. `storageKey` is opaque and never a filename the customer */
/** supplied — see the upload guidance in @trustos/template-sdk. */
export interface PortalDocument {
  id: string;
  ownerUserId: string;
  title: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  category: 'STATEMENT' | 'CONTRACT' | 'INVOICE' | 'IDENTITY' | 'OTHER';
  availableFrom: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something the customer should see when they next log in. */
export interface PortalNotification {
  id: string;
  recipientUserId: string;
  notificationKey: string;
  subject: string;
  body: string;
  href: string | null;
  sentAt: Date;
  readAt: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A customer asking for help. */
export interface SupportRequest {
  id: string;
  requesterUserId: string;
  reference: string;
  subject: string;
  body: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  openedAt: Date;
  closedAt: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

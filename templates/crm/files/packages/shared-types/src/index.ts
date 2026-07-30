/**
 * Shared types — TrustOS CRM.
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

/** An organization or person you do business with. */
export interface Customer {
  id: string;
  name: string;
  code: string;
  industry: string | null;
  website: string | null;
  status: 'PROSPECT' | 'ACTIVE' | 'DORMANT' | 'LOST';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A person at a customer. */
export interface Contact {
  id: string;
  customerId: string;
  fullName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** An unqualified opportunity. Becomes a customer and a contact when it converts. */
export interface Lead {
  id: string;
  fullName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: 'WEB' | 'REFERRAL' | 'EVENT' | 'OUTBOUND' | 'PARTNER' | 'OTHER';
  status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'DISQUALIFIED';
  ownerUserId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A column on the board. A row rather than an enum — see the migration note. */
export interface PipelineStage {
  id: string;
  name: string;
  code: string;
  position: number;
  isWon: boolean;
  isClosed: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A deal in the pipeline. */
export interface Opportunity {
  id: string;
  customerId: string;
  stageId: string;
  name: string;
  amount: string;
  currency: string;
  expectedCloseOn: Date | null;
  ownerUserId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something that happened: a call, a meeting, a note. */
export interface Activity {
  id: string;
  customerId: string | null;
  leadId: string | null;
  kind: 'CALL' | 'MEETING' | 'EMAIL' | 'NOTE' | 'VISIT';
  subject: string;
  body: string | null;
  occurredAt: Date;
  actorUserId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something somebody has to do. */
export interface CrmTask {
  id: string;
  customerId: string | null;
  opportunityId: string | null;
  title: string;
  dueOn: Date | null;
  assigneeUserId: string | null;
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

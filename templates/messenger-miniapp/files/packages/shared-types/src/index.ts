/**
 * Shared types — TrustOS Messenger Mini App.
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

/** The Messenger-specific facts about a mini app user. A page-scoped id is only meaningful for */
/** one page — storing it without the page it belongs to makes it unresolvable later. */
export interface MessengerProfile {
  id: string;
  miniAppUserId: string;
  pageScopedId: string;
  pageRef: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

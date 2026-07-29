/**
 * Types shared between the API and the admin application — default, empty.
 *
 * Every template overrides this file. It exists so the base layer is
 * self-consistent, and to state the one rule that matters here: this module must
 * stay runtime-free.
 *
 * No imports, no side effects, nothing that pulls a server-only module into a
 * browser bundle. The admin application imports this package directly, so
 * anything reachable from here reaches the client.
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

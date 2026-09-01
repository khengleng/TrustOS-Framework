/**
 * Shared types — TrustOS Developer Portal.
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

/** A consumer of the API. Keys belong to an application, not to a person. */
export interface ApiApplication {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  description: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  status: 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REVOKED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The record of a key issued by @trustsystem/api-keys. Holds the prefix so a developer can recognize */
/** it and never the secret — see the migration note. */
export interface ApiKeyRecord {
  id: string;
  applicationId: string;
  apiKeyId: string;
  label: string;
  keyPrefix: string;
  issuedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Calls per application per day. A daily roll-up rather than a row per request: a portal that */
/** stored every call would need a retention policy and a bigger database than the product it */
/** documents. */
export interface ApiUsageRecord {
  id: string;
  applicationId: string;
  usageOn: Date;
  endpoint: string;
  callCount: number;
  errorCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A worked example shown alongside the API documentation. */
export interface CodeExample {
  id: string;
  slug: string;
  title: string;
  language: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
  body: string;
  endpoint: string | null;
  position: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A published client library. `checksum` is what a developer verifies the download against, so a */
/** release without one is worse than no release. */
export interface SdkRelease {
  id: string;
  language: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
  version: string;
  downloadUrl: string;
  checksum: string;
  releasedAt: Date;
  isCurrent: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

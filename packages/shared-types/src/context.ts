import type { OrganizationId, RequestId, UserId } from './ids';

/**
 * Who is acting. Populated by the authentication guard; absent on public routes.
 *
 * `permissions` is the effective, already-resolved permission set for the
 * actor **within `organizationId`**. Resolving it once per request keeps every
 * downstream check a pure set lookup.
 */
export interface ActorContext {
  userId: UserId;
  email: string;
  /** The organization this request is scoped to, if the actor selected one. */
  organizationId: OrganizationId | null;
  roles: string[];
  permissions: string[];
  /** True for platform staff who may operate across organizations. */
  isSuperAdmin: boolean;
  /** JWT id of the access token, retained so it can be revoked. */
  tokenId: string;
}

/** Everything about the transport-level request that logging and audit need. */
export interface RequestContext {
  requestId: RequestId;
  method: string;
  path: string;
  ipAddress: string | null;
  userAgent: string | null;
  receivedAt: Date;
  actor: ActorContext | null;
  /** Set once tenant resolution succeeds. Never trusted from the client body. */
  organizationId: OrganizationId | null;
}

export type ServiceEnvironment = 'development' | 'test' | 'production';

import type { AuthRequestMeta } from './ports';

/**
 * Authentication events.
 *
 * The auth package does not depend on @trustos/audit — it emits events and
 * lets the application decide where they go. That keeps the dependency graph
 * acyclic and means an auth failure cannot be caused by an audit failure.
 */
export type AuthEventType =
  | 'auth.registered'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.token_refreshed'
  | 'auth.token_reuse_detected'
  | 'auth.organization_selected'
  | 'auth.password_rehashed'
  | 'auth.sessions_revoked';

export interface AuthEvent {
  type: AuthEventType;
  actorId: string | null;
  organizationId: string | null;
  entityType: string;
  entityId: string | null;
  /** Never contains passwords or tokens. */
  metadata?: Record<string, unknown>;
  request: AuthRequestMeta;
}

export interface AuthEventSink {
  emit(event: AuthEvent): Promise<void> | void;
}

export const NOOP_EVENT_SINK: AuthEventSink = { emit: () => undefined };

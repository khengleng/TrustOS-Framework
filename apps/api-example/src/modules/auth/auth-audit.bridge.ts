import { AUDIT_ACTIONS, AUDIT_ENTITY, type AuditService } from '@trustos/audit';
import type { AuthEvent, AuthEventSink } from '@trustos/auth';

/**
 * Turns authentication events into audit records.
 *
 * @trustos/auth deliberately does not know about @trustos/audit — it emits
 * events. This adapter is where the application decides that "a login is worth
 * recording", which is a policy question, not an authentication question.
 */
const ACTION_BY_EVENT: Record<AuthEvent['type'], string> = {
  'auth.registered': AUDIT_ACTIONS.USER_CREATED,
  'auth.login': AUDIT_ACTIONS.LOGIN,
  'auth.login_failed': AUDIT_ACTIONS.LOGIN_FAILED,
  'auth.logout': AUDIT_ACTIONS.LOGOUT,
  'auth.token_refreshed': AUDIT_ACTIONS.TOKEN_REFRESHED,
  'auth.token_reuse_detected': AUDIT_ACTIONS.TOKEN_REUSE_DETECTED,
  'auth.organization_selected': AUDIT_ACTIONS.ORGANIZATION_SELECTED,
  'auth.password_rehashed': AUDIT_ACTIONS.PASSWORD_REHASHED,
  'auth.sessions_revoked': AUDIT_ACTIONS.SESSIONS_REVOKED,
};

export class AuthAuditBridge implements AuthEventSink {
  constructor(private readonly audit: AuditService) {}

  async emit(event: AuthEvent): Promise<void> {
    await this.audit.record({
      action: ACTION_BY_EVENT[event.type] ?? event.type,
      entityType: event.entityType || AUDIT_ENTITY.USER,
      entityId: event.entityId,
      actorId: event.actorId,
      organizationId: event.organizationId,
      // Auth events carry no before-state; the metadata is the payload.
      after: event.metadata ?? null,
      requestId: event.request.requestId,
      ipAddress: event.request.ipAddress,
      userAgent: event.request.userAgent,
    });
  }
}

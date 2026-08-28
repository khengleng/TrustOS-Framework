/**
 * Injection tokens.
 *
 * Symbols rather than strings, so two packages cannot collide on a name, and declared here
 * so a consumer can depend on a token without importing what provides it.
 */
export const APP_CONFIG_TOKEN = Symbol.for('workflow-admin.config');
export const APP_LOGGER = Symbol.for('workflow-admin.logger');
export const SECURITY_POLICY = Symbol.for('workflow-admin.security-policy');
export const SECURITY_EVENTS = Symbol.for('workflow-admin.security-events');
export const AUDIT_SERVICE = Symbol.for('workflow-admin.audit');
export const AUTHORIZER = Symbol.for('workflow-admin.authorizer');
export const IDENTITY_PROVIDER = Symbol.for('workflow-admin.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('workflow-admin.access-resolver');

export const WORKFLOW_ENGINE = Symbol.for('workflow-admin.engine');
export const WORKFLOW_DEFINITION_SERVICE = Symbol.for('workflow-admin.definition-service');
export const TASK_SERVICE = Symbol.for('workflow-admin.task-service');
export const SLA_SERVICE = Symbol.for('workflow-admin.sla-service');
export const ESCALATION_SERVICE = Symbol.for('workflow-admin.escalation-service');
export const CASE_SERVICE = Symbol.for('workflow-admin.case-service');
export const COMMENT_SERVICE = Symbol.for('workflow-admin.comment-service');
export const ATTACHMENT_SERVICE = Symbol.for('workflow-admin.attachment-service');
export const HISTORY_RECORDER = Symbol.for('workflow-admin.history');
export const MEMBER_DIRECTORY = Symbol.for('workflow-admin.member-directory');

/**
 * The registered global guards, in registration order.
 *
 * Published so a boot test can assert on the order without reaching into Nest's container
 * internals. The order *is* the security model — see the header of
 * `workflow-admin.module.ts`.
 */
export const GUARD_ORDER = Symbol.for('workflow-admin.guard-order');

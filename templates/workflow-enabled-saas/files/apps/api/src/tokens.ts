/**
 * Application injection tokens.
 *
 * Symbols rather than strings so two packages cannot collide on a token name,
 * and declared here rather than in each module so a consumer can depend on a
 * token without importing the module that provides it.
 */
export const APP_CONFIG_TOKEN = Symbol.for('product.config');
export const APP_LOGGER = Symbol.for('product.logger');
export const APP_METRICS = Symbol.for('product.metrics');
export const AUDIT_SERVICE = Symbol.for('product.audit-service');
export const AUTH_SERVICE = Symbol.for('product.auth-service');

/*
 * Workflow tokens.
 *
 * The engine and its collaborators are global providers, because one engine per process
 * shares one compiled-definition cache — a second would compile every published definition
 * twice, and the cache is only safe at all because a published version is immutable.
 */
export const WORKFLOW_ENGINE = Symbol.for('product.workflow-engine');
export const WORKFLOW_DEFINITION_SERVICE = Symbol.for('product.workflow-definition-service');
export const WORKFLOW_TASK_SERVICE = Symbol.for('product.workflow-task-service');
export const WORKFLOW_SLA_SERVICE = Symbol.for('product.workflow-sla-service');
export const WORKFLOW_HISTORY = Symbol.for('product.workflow-history');
export const WORKFLOW_AUTHORIZER = Symbol.for('product.workflow-authorizer');

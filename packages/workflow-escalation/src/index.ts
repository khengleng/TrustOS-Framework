/**
 * @trustos/workflow-escalation
 *
 * What happens when an SLA runs out.
 *
 * The requirement that shapes the package is idempotency: a breached SLA stays
 * breached, so a sweep that escalates every breach it finds pages somebody every
 * minute until the queue drains — and the response to that is to silence the pager.
 *
 * Idempotency is a unique constraint in the database, not a check in code. See the
 * header of `escalation.ts`.
 */
export * from './escalation';

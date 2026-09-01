/**
 * @trustsystem/module-workflow
 *
 * Approval workflows with task assignment, append-only history, SLA tracking and
 * escalation hooks.
 *
 * The invariant to preserve is separation of duties: a submitter cannot approve
 * their own request, and required approvals are counted as distinct actors. Read
 * `workflow.service.ts` before changing either.
 */
export * from './config';
export * from './definition';
export * from './escalation';
export * from './store';
export * from './workflow.service';
export * from './workflow.module';

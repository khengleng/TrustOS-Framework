/**
 * @trustsystem/case-management
 *
 * Cases: the container a workflow runs inside.
 *
 * The distinction from a workflow instance is the whole design, and the header of
 * `service.ts` states it — a workflow has a known shape and knows how it ends, a case is
 * work somebody owns until it is resolved and its shape is not known in advance. That is
 * why case statuses are a loose graph rather than a definition-driven machine, and why
 * closure is the one tight rule: a case closes only from `resolved`, because "closed"
 * with no record of what was decided is useless six months later.
 */
export * from './service';
export * from './prisma-store';

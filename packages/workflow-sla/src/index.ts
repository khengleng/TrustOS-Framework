/**
 * @trustos/workflow-sla
 *
 * SLA rules, the business-calendar abstraction, and SLA state.
 *
 * The design decision worth knowing: an SLA's status is *computed* from its
 * timestamps rather than stored and updated by a scheduler. The header of `sla.ts`
 * explains why — a stored status is confidently wrong for as long as the scheduler is
 * down, and a dashboard that lies about a breach is worse than no dashboard.
 *
 * This phase ships elapsed-time only. `calendar.ts` says why a real holiday calendar
 * is not something to guess at.
 */
export * from './calendar';
export * from './sla';

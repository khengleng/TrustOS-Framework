/**
 * @trustos/audit
 *
 * Append-only audit logging. The trail is evidence: it is written for every
 * security-sensitive action, it is never edited, and it never contains
 * credentials.
 */
export * from './actions';
export * from './audit-record';
export * from './audit.service';
export * from './prisma-audit-sink';
export * from './testing/in-memory-sink';

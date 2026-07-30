/**
 * @trustos/workflow-history
 *
 * Append-only workflow history, comments that cannot be silently edited, and
 * attachments that reference documents rather than copying them.
 *
 * `HistoryStore` has no `update` and no `delete` — not "there is one but do not call
 * it", genuinely no method — and the migration installs a trigger refusing both at the
 * database, the same way phase 1 protects `AuditLog`.
 *
 * History and the audit trail are both written, by one call, because they answer
 * different questions for different readers and a caller who wrote one and forgot the
 * other would produce a complete history and an audit trail with a hole in it.
 */
export * from './history';
export * from './collaboration';
export * from './prisma-store';

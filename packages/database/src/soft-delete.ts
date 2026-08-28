/**
 * Soft-delete helpers.
 *
 * The framework's rule is that application code never issues a hard delete on
 * a model carrying `deletedAt`: an audit trail that references a row nobody
 * can look up is not an audit trail. Reads must therefore exclude soft-deleted
 * rows explicitly — Prisma has no global filter, so the exclusion is a helper
 * you compose into every `where`, and forgetting it is a review finding.
 */

/** `where` fragment matching only live rows. */
export const NOT_DELETED = { deletedAt: null } as const;

/** Adds the live-rows filter to an existing `where` clause. */
export function withNotDeleted<T extends Record<string, unknown>>(
  where: T,
): T & { deletedAt: null } {
  return { ...where, deletedAt: null };
}

/** `data` fragment that retires a row. */
export function softDeleteData(now: Date = new Date()): { deletedAt: Date } {
  return { deletedAt: now };
}

/** `data` fragment that restores a row. */
export function restoreData(): { deletedAt: null } {
  return { deletedAt: null };
}

export function isSoftDeleted(row: { deletedAt?: Date | null } | null | undefined): boolean {
  return Boolean(row?.deletedAt);
}

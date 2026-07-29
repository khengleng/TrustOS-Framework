import { assertTenantMatch, scopedDelegate } from '@trustos/tenancy';

/**
 * The shape this repository needs from a Prisma client: a model delegate,
 * looked up by name.
 *
 * Deliberately loose. The framework's client and this application's client are
 * generated independently from different schemas, so they are not structurally
 * assignable to one another even though both are Prisma clients. Naming the
 * capability instead of the class keeps the repository usable with either.
 */
export type PrismaLike = object;

/**
 * A tenant-scoped repository over one Prisma model.
 *
 * Wraps the model delegate in `scopedDelegate`, so `organizationId` is added
 * to every query and every write from the ambient tenant context. A method
 * here cannot read or touch another organization's rows even if a filter is
 * forgotten — the scope is structural rather than a habit.
 *
 * Note what is *not* here: no `findUnique`. A primary-key lookup that skipped
 * the scope is the classic cross-tenant read, so `findById` goes through the
 * scoped delegate and then re-checks the loaded row.
 */
export class TenantRepository<TRow extends { id: string; organizationId: string }> {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly model: string,
  ) {}

  /** The scoped delegate. Resolved per call so the tenant context is current. */
  private get delegate(): {
    findMany: (args?: Record<string, unknown>) => Promise<TRow[]>;
    findFirst: (args?: Record<string, unknown>) => Promise<TRow | null>;
    create: (args?: Record<string, unknown>) => Promise<TRow>;
    update: (args?: Record<string, unknown>) => Promise<TRow>;
    count: (args?: Record<string, unknown>) => Promise<number>;
  } {
    const client = this.prisma as unknown as Record<string, object>;
    const delegate = client[this.model];
    if (!delegate) throw new Error(`Unknown Prisma model "${this.model}".`);
    return scopedDelegate(delegate, { model: this.model }) as never;
  }

  list(where: Record<string, unknown> = {}): Promise<TRow[]> {
    return this.delegate.findMany({
      where: { ...where, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  count(where: Record<string, unknown> = {}): Promise<number> {
    return this.delegate.count({ where: { ...where, deletedAt: null } });
  }

  /**
   * Loads one row by id.
   *
   * `assertTenantMatch` is belt and braces on top of the scoped delegate: it
   * reports another organization's row as `not_found`, never `forbidden`,
   * because a 403 would confirm the id exists somewhere else and turn this
   * endpoint into an enumeration oracle.
   */
  async findById(id: string, organizationId: string): Promise<TRow> {
    const row = await this.delegate.findFirst({ where: { id, deletedAt: null } });
    return assertTenantMatch(row, organizationId) as TRow;
  }

  create(data: Record<string, unknown>): Promise<TRow> {
    // organizationId is stamped by the scoped delegate; passing a different
    // one is refused rather than silently overwritten.
    return this.delegate.create({ data });
  }

  update(id: string, data: Record<string, unknown>): Promise<TRow> {
    return this.delegate.update({ where: { id, deletedAt: null }, data });
  }

  /** Soft delete: the row stays so the audit trail still points at something. */
  softDelete(id: string): Promise<TRow> {
    return this.delegate.update({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}

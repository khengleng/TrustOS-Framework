import { ApiError } from '@trustsystem/errors';
import { assertTenantMatch, scopedDelegate } from '@trustsystem/tenancy';
import type { PrismaLike } from './context';

/**
 * A tenant-scoped repository over one Prisma model, for module code.
 *
 * Every read and write goes through `scopedDelegate`, so `organizationId` is
 * applied structurally rather than remembered per call site. A module cannot
 * reach another organization's rows through this class even if a filter is
 * forgotten.
 *
 * Generated applications ship a near-identical `TenantRepository` for their own
 * product code. Both exist on purpose: an application has the class without
 * installing the module SDK, and a module has it without importing generated
 * application code. Neither reimplements the isolation itself — both delegate to
 * `@trustsystem/tenancy`, which is the single implementation.
 */

export interface ModuleRow {
  id: string;
  organizationId: string;
}

interface Delegate<TRow> {
  findMany(args?: Record<string, unknown>): Promise<TRow[]>;
  findFirst(args?: Record<string, unknown>): Promise<TRow | null>;
  create(args?: Record<string, unknown>): Promise<TRow>;
  update(args?: Record<string, unknown>): Promise<TRow>;
  updateMany(args?: Record<string, unknown>): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface ListOptions {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
  skip?: number;
  take?: number;
  /** Include soft-deleted rows. Off by default. */
  includeDeleted?: boolean;
}

export class ModuleRepository<TRow extends ModuleRow> {
  constructor(
    private readonly prisma: PrismaLike | null,
    private readonly model: string,
    private readonly moduleId: string,
  ) {}

  /** True when the module has a database to work against. */
  get available(): boolean {
    return this.prisma !== null;
  }

  /**
   * The scoped delegate, resolved per call so the ambient tenant context is the
   * current one rather than whichever was active at construction.
   */
  private get delegate(): Delegate<TRow> {
    if (!this.prisma) {
      throw ApiError.internal(
        `Module "${this.moduleId}" needs a database for "${this.model}" but none is configured.`,
      );
    }

    const client = this.prisma as unknown as Record<string, object | undefined>;
    const delegate = client[this.model];
    if (!delegate) {
      throw ApiError.internal(
        `Module "${this.moduleId}" expects Prisma model "${this.model}". Run the module's migration.`,
      );
    }

    return scopedDelegate(delegate, { model: this.model }) as unknown as Delegate<TRow>;
  }

  /**
   * Every method below is `async`, including the ones whose body is a single
   * delegate call.
   *
   * Resolving `this.delegate` can throw — no database, unknown model, no tenant
   * context — and it happens *before* the delegate is called. Without `async`
   * those failures would be thrown synchronously from a call site that looks
   * asynchronous, so `repository.list().catch(handle)` would never see them.
   * `async` makes every failure mode a rejection.
   */
  async list(options: ListOptions = {}): Promise<TRow[]> {
    const { where = {}, orderBy = { createdAt: 'desc' }, skip, take, includeDeleted } = options;

    return this.delegate.findMany({
      where: { ...where, ...(includeDeleted ? {} : { deletedAt: null }) },
      orderBy,
      ...(skip === undefined ? {} : { skip }),
      ...(take === undefined ? {} : { take }),
    });
  }

  async count(where: Record<string, unknown> = {}, includeDeleted = false): Promise<number> {
    return this.delegate.count({
      where: { ...where, ...(includeDeleted ? {} : { deletedAt: null }) },
    });
  }

  async findFirst(where: Record<string, unknown>): Promise<TRow | null> {
    return this.delegate.findFirst({ where: { ...where, deletedAt: null } });
  }

  /**
   * Loads one row by id.
   *
   * `assertTenantMatch` re-checks the loaded row on top of the scoped query, and
   * reports another organization's row as `not_found` rather than `forbidden` —
   * a 403 would confirm the id exists elsewhere and turn every id endpoint into
   * an enumeration oracle.
   */
  async findById(id: string, organizationId: string): Promise<TRow> {
    const row = await this.delegate.findFirst({ where: { id, deletedAt: null } });
    return assertTenantMatch(row, organizationId) as TRow;
  }

  async create(data: Record<string, unknown>): Promise<TRow> {
    // organizationId is stamped by the scoped delegate. Supplying a different
    // one is refused rather than silently corrected.
    return this.delegate.create({ data });
  }

  async update(id: string, data: Record<string, unknown>): Promise<TRow> {
    return this.delegate.update({ where: { id, deletedAt: null }, data });
  }

  /** Soft delete, so the audit trail keeps pointing at something that exists. */
  async softDelete(id: string, now: Date): Promise<TRow> {
    return this.delegate.update({ where: { id, deletedAt: null }, data: { deletedAt: now } });
  }
}

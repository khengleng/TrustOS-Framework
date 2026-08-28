import type { OrganizationId } from '@trustos/shared-types';

export interface FakeRow extends Record<string, unknown> {
  id: string;
  organizationId: OrganizationId;
}

/**
 * An in-memory stand-in for a Prisma model delegate.
 *
 * Tenant isolation is a property of the *query we build*, not of PostgreSQL,
 * so it can and should be proven without a database. This fake applies
 * equality filters exactly as Prisma would for the subset of the API the
 * scoped delegate uses, and records every call so a test can assert on the
 * arguments that would have reached the driver.
 *
 * Shipped inside the package (rather than in a test file) so product code can
 * reuse it when testing its own tenant-owned models.
 */
export class FakeModelDelegate {
  readonly calls: Array<{ method: string; args: unknown }> = [];

  constructor(private rows: FakeRow[] = []) {}

  private record(method: string, args: unknown): void {
    this.calls.push({ method, args });
  }

  private matches(row: FakeRow, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (value === null) return row[key] === null || row[key] === undefined;
      return row[key] === value;
    });
  }

  findFirst(args?: { where?: Record<string, unknown> }): Promise<FakeRow | null> {
    this.record('findFirst', args);
    return Promise.resolve(this.rows.find((row) => this.matches(row, args?.where)) ?? null);
  }

  findFirstOrThrow(args?: { where?: Record<string, unknown> }): Promise<FakeRow> {
    this.record('findFirstOrThrow', args);
    const row = this.rows.find((candidate) => this.matches(candidate, args?.where));
    if (!row) return Promise.reject(new Error('NotFoundError: No record found'));
    return Promise.resolve(row);
  }

  findUnique(args?: { where?: Record<string, unknown> }): Promise<FakeRow | null> {
    this.record('findUnique', args);
    // Deliberately ignores everything but `id`, which is what makes an
    // unscoped findUnique dangerous — and what the proxy prevents.
    const id = args?.where?.id;
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  findUniqueOrThrow(args?: { where?: Record<string, unknown> }): Promise<FakeRow> {
    this.record('findUniqueOrThrow', args);
    const row = this.rows.find((candidate) => candidate.id === args?.where?.id);
    if (!row) return Promise.reject(new Error('NotFoundError: No record found'));
    return Promise.resolve(row);
  }

  findMany(args?: { where?: Record<string, unknown> }): Promise<FakeRow[]> {
    this.record('findMany', args);
    return Promise.resolve(this.rows.filter((row) => this.matches(row, args?.where)));
  }

  count(args?: { where?: Record<string, unknown> }): Promise<number> {
    this.record('count', args);
    return Promise.resolve(this.rows.filter((row) => this.matches(row, args?.where)).length);
  }

  create(args?: { data?: Record<string, unknown> }): Promise<FakeRow> {
    this.record('create', args);
    const row = { id: `row_${this.rows.length + 1}`, ...(args?.data ?? {}) } as FakeRow;
    this.rows.push(row);
    return Promise.resolve(row);
  }

  createMany(args?: { data?: Record<string, unknown>[] }): Promise<{ count: number }> {
    this.record('createMany', args);
    const rows = (args?.data ?? []).map(
      (data, index) => ({ id: `row_${this.rows.length + index + 1}`, ...data }) as FakeRow,
    );
    this.rows.push(...rows);
    return Promise.resolve({ count: rows.length });
  }

  update(args?: {
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }): Promise<FakeRow> {
    this.record('update', args);
    const row = this.rows.find((candidate) => this.matches(candidate, args?.where));
    if (!row) return Promise.reject(new Error('NotFoundError: No record found'));
    Object.assign(row, args?.data ?? {});
    return Promise.resolve(row);
  }

  updateMany(args?: {
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }): Promise<{ count: number }> {
    this.record('updateMany', args);
    const affected = this.rows.filter((row) => this.matches(row, args?.where));
    affected.forEach((row) => Object.assign(row, args?.data ?? {}));
    return Promise.resolve({ count: affected.length });
  }

  delete(args?: { where?: Record<string, unknown> }): Promise<FakeRow> {
    this.record('delete', args);
    const index = this.rows.findIndex((row) => this.matches(row, args?.where));
    if (index === -1) return Promise.reject(new Error('NotFoundError: No record found'));
    const [row] = this.rows.splice(index, 1);
    return Promise.resolve(row as FakeRow);
  }

  deleteMany(args?: { where?: Record<string, unknown> }): Promise<{ count: number }> {
    this.record('deleteMany', args);
    const remaining = this.rows.filter((row) => !this.matches(row, args?.where));
    const removed = this.rows.length - remaining.length;
    this.rows = remaining;
    return Promise.resolve({ count: removed });
  }

  upsert(args?: {
    where?: Record<string, unknown>;
    create?: Record<string, unknown>;
    update?: Record<string, unknown>;
  }): Promise<FakeRow> {
    this.record('upsert', args);
    const existing = this.rows.find((row) => this.matches(row, args?.where));
    if (existing) {
      Object.assign(existing, args?.update ?? {});
      return Promise.resolve(existing);
    }
    return this.create({ data: args?.create ?? {} });
  }

  /** Not scoped by the proxy — present so the fail-closed path can be tested. */
  executeRaw(): Promise<number> {
    this.record('executeRaw', undefined);
    return Promise.resolve(0);
  }

  snapshot(): FakeRow[] {
    return [...this.rows];
  }
}

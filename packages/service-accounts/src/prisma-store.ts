import type { ServiceAccountRecord, ServiceAccountStatus, ServiceAccountStore } from './service';

/**
 * A row as the database has it.
 *
 * `status` is a plain `string` here because that is what a Prisma client returns for
 * an enum stored as text — naming the narrowed union in the port would make the port
 * unusable with the very client it exists to accept. `narrow` re-establishes the
 * union on the way out, and a value outside it means somebody wrote to the table by
 * hand, which is worth a loud failure rather than a silent cast.
 */
type ServiceAccountRow = Omit<ServiceAccountRecord, 'status'> & { status: string };

const STATUSES: ServiceAccountStatus[] = ['active', 'disabled', 'expired'];

function narrow(row: ServiceAccountRow): ServiceAccountRecord;
function narrow(row: ServiceAccountRow | null): ServiceAccountRecord | null;
function narrow(row: ServiceAccountRow | null): ServiceAccountRecord | null {
  if (!row) return null;
  if (!(STATUSES as string[]).includes(row.status)) {
    throw new Error(
      `Service account ${row.id} has status "${row.status}", which is not a known status. ` +
        'Refusing to treat it as active.',
    );
  }
  return { ...row, status: row.status as ServiceAccountStatus };
}

/**
 * Prisma-backed service-account store.
 *
 * A narrow delegate rather than a `PrismaClient`, for the reason phase 2 found: the
 * framework's client and a generated application's client come from different schemas
 * and are not structurally assignable.
 *
 * `findByCredentialHash` and `findByOidcClientId` run before an actor exists, so there
 * is no tenant context to scope to. Everything else takes an organization explicitly.
 */
export interface ServiceAccountDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ServiceAccountRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<ServiceAccountRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<ServiceAccountRow>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<ServiceAccountRow>;
}

export class PrismaServiceAccountStore implements ServiceAccountStore {
  constructor(private readonly delegate: ServiceAccountDelegate) {}

  async findById(id: string): Promise<ServiceAccountRecord | null> {
    return narrow(await this.delegate.findFirst({ where: { id, deletedAt: null } }));
  }

  async findByCredentialHash(hash: string): Promise<ServiceAccountRecord | null> {
    return narrow(
      await this.delegate.findFirst({ where: { credentialHash: hash, deletedAt: null } }),
    );
  }

  async findByOidcClientId(clientId: string): Promise<ServiceAccountRecord | null> {
    return narrow(
      await this.delegate.findFirst({ where: { oidcClientId: clientId, deletedAt: null } }),
    );
  }

  async findByName(
    organizationId: string | null,
    name: string,
  ): Promise<ServiceAccountRecord | null> {
    return narrow(
      await this.delegate.findFirst({ where: { organizationId, name, deletedAt: null } }),
    );
  }

  async list(organizationId: string | null): Promise<ServiceAccountRecord[]> {
    const rows = await this.delegate.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => narrow(row));
  }

  async create(
    input: Omit<ServiceAccountRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<ServiceAccountRecord> {
    return narrow(await this.delegate.create({ data: { ...input } }));
  }

  async update(id: string, patch: Partial<ServiceAccountRecord>): Promise<ServiceAccountRecord> {
    return narrow(await this.delegate.update({ where: { id }, data: { ...patch } }));
  }

  async recordUse(id: string, at: Date, ipAddress: string | null): Promise<void> {
    await this.delegate.update({
      where: { id },
      data: { lastUsedAt: at, lastUsedIp: ipAddress },
    });
  }
}

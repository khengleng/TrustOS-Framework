import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import type { AppPrismaService } from '../../../core/prisma.service';
import { ApiError } from '@trustsystem/errors';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

export interface MerchantRow {
  id: string;
  organizationId: string;
  name: string;
  legalName: string | null;
  code: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface StoreRow {
  id: string;
  organizationId: string;
  merchantId: string;
  name: string;
  code: string;
  status: 'ACTIVE' | 'CLOSED';
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface BranchRow {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  code: string;
  addressLine: string | null;
  city: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MerchantMemberRow {
  id: string;
  organizationId: string;
  merchantId: string;
  userId: string;
  position: string | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Merchant domain service.
 *
 * Every parent reference is verified through the tenant-scoped repository
 * before a child is created. Without that, a caller could attach a store to a
 * merchant in another organization by supplying its id — the row would be
 * stamped with the caller's organization, so no isolation test would fail, but
 * the data would be wrong in a way that is hard to unpick later.
 */
@Injectable()
export class MerchantService {
  private readonly merchants: TenantRepository<MerchantRow>;
  private readonly stores: TenantRepository<StoreRow>;
  private readonly branches: TenantRepository<BranchRow>;
  private readonly members: TenantRepository<MerchantMemberRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.merchants = new TenantRepository<MerchantRow>(prisma, 'merchant');
    this.stores = new TenantRepository<StoreRow>(prisma, 'store');
    this.branches = new TenantRepository<BranchRow>(prisma, 'branch');
    this.members = new TenantRepository<MerchantMemberRow>(prisma, 'merchantMember');
  }

  // --- merchants ------------------------------------------------------------

  listMerchants(): Promise<MerchantRow[]> {
    return this.merchants.list();
  }

  findMerchant(id: string, organizationId: string): Promise<MerchantRow> {
    return this.merchants.findById(id, organizationId);
  }

  async createMerchant(
    input: { name: string; code: string; legalName?: string; contactEmail?: string },
    organizationId: string,
  ): Promise<MerchantRow> {
    const merchant = await this.merchants.create({
      name: input.name,
      code: input.code,
      legalName: input.legalName ?? null,
      contactEmail: input.contactEmail ?? null,
    });

    await this.audit.record({
      action: 'merchant.created',
      entityType: 'Merchant',
      entityId: merchant.id,
      organizationId,
      after: { name: merchant.name, code: merchant.code, status: merchant.status },
    });

    return merchant;
  }

  async updateMerchantStatus(
    id: string,
    status: MerchantRow['status'],
    organizationId: string,
  ): Promise<MerchantRow> {
    const existing = await this.merchants.findById(id, organizationId);
    const before = { status: existing.status };

    const updated = await this.merchants.update(id, { status });

    await this.audit.recordChange({
      action: 'merchant.status_changed',
      entityType: 'Merchant',
      entityId: id,
      organizationId,
      before,
      after: { status: updated.status },
    });

    return updated;
  }

  // --- stores ---------------------------------------------------------------

  listStores(): Promise<StoreRow[]> {
    return this.stores.list();
  }

  async createStore(
    input: { merchantId: string; name: string; code: string; timezone?: string },
    organizationId: string,
  ): Promise<StoreRow> {
    // Reports not_found for a merchant in another organization.
    await this.merchants.findById(input.merchantId, organizationId);

    const store = await this.stores.create({
      merchantId: input.merchantId,
      name: input.name,
      code: input.code,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });

    await this.audit.record({
      action: 'merchant.store.created',
      entityType: 'Store',
      entityId: store.id,
      organizationId,
      after: { merchantId: store.merchantId, name: store.name, code: store.code },
    });

    return store;
  }

  // --- branches -------------------------------------------------------------

  listBranches(): Promise<BranchRow[]> {
    return this.branches.list();
  }

  async createBranch(
    input: { storeId: string; name: string; code: string; addressLine?: string; city?: string },
    organizationId: string,
  ): Promise<BranchRow> {
    await this.stores.findById(input.storeId, organizationId);

    const branch = await this.branches.create({
      storeId: input.storeId,
      name: input.name,
      code: input.code,
      addressLine: input.addressLine ?? null,
      city: input.city ?? null,
    });

    await this.audit.record({
      action: 'merchant.branch.created',
      entityType: 'Branch',
      entityId: branch.id,
      organizationId,
      after: { storeId: branch.storeId, name: branch.name, code: branch.code },
    });

    return branch;
  }

  // --- members --------------------------------------------------------------

  listMembers(): Promise<MerchantMemberRow[]> {
    return this.members.list();
  }

  async addMember(
    input: { merchantId: string; userId: string; position?: string; isPrimary?: boolean },
    organizationId: string,
  ): Promise<MerchantMemberRow> {
    await this.merchants.findById(input.merchantId, organizationId);

    const existing = await this.members.list({
      merchantId: input.merchantId,
      userId: input.userId,
    });
    if (existing.length > 0) {
      throw ApiError.conflict('That user is already a member of this merchant.');
    }

    const member = await this.members.create({
      merchantId: input.merchantId,
      userId: input.userId,
      position: input.position ?? null,
      isPrimary: input.isPrimary ?? false,
    });

    await this.audit.record({
      action: 'merchant.member.added',
      entityType: 'MerchantMember',
      entityId: member.id,
      organizationId,
      after: { merchantId: member.merchantId, userId: member.userId, position: member.position },
    });

    return member;
  }

  async removeMember(id: string, organizationId: string): Promise<void> {
    const existing = await this.members.findById(id, organizationId);
    const before = { merchantId: existing.merchantId, userId: existing.userId };

    await this.members.softDelete(id);

    await this.audit.record({
      action: 'merchant.member.removed',
      entityType: 'MerchantMember',
      entityId: id,
      organizationId,
      before,
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Wallet domain service.
 *
 * Every read and write goes through a tenant-scoped repository, and every parent reference is
 * verified through one before a child is created. Without that second check a caller could
 * attach a record to a parent in another organization by supplying its id — the row would be
 * stamped with the caller’s organization, so no isolation test would fail, and the data would be
 * wrong in a way that is hard to unpick later.
 *
 * Writes are audited. A financial or personal-data change with no audit row is a change nobody
 * can answer questions about six months later.
 */

export interface WalletProfileRow {
  id: string;
  organizationId: string;
  walletId: string;
  ownerName: string;
  ownerPhone: string | null;
  currency: string;
  tier: 'BASIC' | 'VERIFIED' | 'PREMIUM';
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface WalletTransferRow {
  id: string;
  organizationId: string;
  reference: string;
  fromProfileId: string;
  toProfileId: string;
  amount: string;
  currency: string;
  journalId: string | null;
  status: 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TransferLimitProfileRow {
  id: string;
  organizationId: string;
  tier: 'BASIC' | 'VERIFIED' | 'PREMIUM';
  limitKey: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class WalletService {
  private readonly walletProfiles: TenantRepository<WalletProfileRow>;
  private readonly walletTransfers: TenantRepository<WalletTransferRow>;
  private readonly transferLimitProfiles: TenantRepository<TransferLimitProfileRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.walletProfiles = new TenantRepository<WalletProfileRow>(prisma, 'walletProfile');
    this.walletTransfers = new TenantRepository<WalletTransferRow>(prisma, 'walletTransfer');
    this.transferLimitProfiles = new TenantRepository<TransferLimitProfileRow>(
      prisma,
      'transferLimitProfile',
    );
  }

  // --- wallets -----------------------------------------------------

  listWalletProfiles(): Promise<WalletProfileRow[]> {
    return this.walletProfiles.list();
  }

  findWalletProfile(id: string, organizationId: string): Promise<WalletProfileRow> {
    return this.walletProfiles.findById(id, organizationId);
  }

  async createWalletProfile(
    input: {
      walletId: string;
      ownerName: string;
      ownerPhone?: string;
      currency: string;
      tier?: 'BASIC' | 'VERIFIED' | 'PREMIUM';
      status?: 'ACTIVE' | 'FROZEN' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<WalletProfileRow> {
    const created = await this.walletProfiles.create({
      walletId: input.walletId,
      ownerName: input.ownerName,
      ownerPhone: input.ownerPhone ?? null,
      currency: input.currency,
      tier: input.tier,
      status: input.status,
    });

    await this.audit.record({
      action: 'wallet.wallet-profile.created',
      entityType: 'WalletProfile',
      entityId: created.id,
      organizationId,
      after: {
        walletId: created.walletId,
        ownerName: created.ownerName,
        ownerPhone: created.ownerPhone,
      },
    });

    return created;
  }

  async updateWalletProfile(
    id: string,
    changes: {
      ownerName?: string;
      ownerPhone?: string;
      tier?: 'BASIC' | 'VERIFIED' | 'PREMIUM';
      status?: 'ACTIVE' | 'FROZEN' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<WalletProfileRow> {
    const existing = await this.walletProfiles.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.walletProfiles.update(id, changes);

    await this.audit.recordChange({
      action: 'wallet.wallet-profile.updated',
      entityType: 'WalletProfile',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- transfers ---------------------------------------------------

  listWalletTransfers(): Promise<WalletTransferRow[]> {
    return this.walletTransfers.list();
  }

  findWalletTransfer(id: string, organizationId: string): Promise<WalletTransferRow> {
    return this.walletTransfers.findById(id, organizationId);
  }

  async createWalletTransfer(
    input: {
      reference: string;
      fromProfileId: string;
      toProfileId: string;
      amount: string;
      currency: string;
      journalId?: string;
      status?: 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';
      note?: string;
    },
    organizationId: string,
  ): Promise<WalletTransferRow> {
    await this.walletProfiles.findById(input.fromProfileId, organizationId);
    await this.walletProfiles.findById(input.toProfileId, organizationId);

    const created = await this.walletTransfers.create({
      reference: input.reference,
      fromProfileId: input.fromProfileId,
      toProfileId: input.toProfileId,
      amount: input.amount,
      currency: input.currency,
      journalId: input.journalId ?? null,
      status: input.status,
      note: input.note ?? null,
    });

    await this.audit.record({
      action: 'wallet.wallet-transfer.created',
      entityType: 'WalletTransfer',
      entityId: created.id,
      organizationId,
      after: {
        reference: created.reference,
        fromProfileId: created.fromProfileId,
        toProfileId: created.toProfileId,
      },
    });

    return created;
  }

  async updateWalletTransfer(
    id: string,
    changes: {
      fromProfileId?: string;
      toProfileId?: string;
      amount?: string;
      currency?: string;
      status?: 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';
      note?: string;
    },
    organizationId: string,
  ): Promise<WalletTransferRow> {
    const existing = await this.walletTransfers.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.walletTransfers.update(id, changes);

    await this.audit.recordChange({
      action: 'wallet.wallet-transfer.updated',
      entityType: 'WalletTransfer',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- limit profiles ----------------------------------------------

  listTransferLimitProfiles(): Promise<TransferLimitProfileRow[]> {
    return this.transferLimitProfiles.list();
  }

  findTransferLimitProfile(id: string, organizationId: string): Promise<TransferLimitProfileRow> {
    return this.transferLimitProfiles.findById(id, organizationId);
  }

  async createTransferLimitProfile(
    input: {
      tier: 'BASIC' | 'VERIFIED' | 'PREMIUM';
      limitKey: string;
      description: string;
    },
    organizationId: string,
  ): Promise<TransferLimitProfileRow> {
    const created = await this.transferLimitProfiles.create({
      tier: input.tier,
      limitKey: input.limitKey,
      description: input.description,
    });

    await this.audit.record({
      action: 'wallet.transfer-limit-profile.created',
      entityType: 'TransferLimitProfile',
      entityId: created.id,
      organizationId,
      after: { tier: created.tier, limitKey: created.limitKey, description: created.description },
    });

    return created;
  }

  async updateTransferLimitProfile(
    id: string,
    changes: {
      tier?: 'BASIC' | 'VERIFIED' | 'PREMIUM';
      limitKey?: string;
      description?: string;
    },
    organizationId: string,
  ): Promise<TransferLimitProfileRow> {
    const existing = await this.transferLimitProfiles.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.transferLimitProfiles.update(id, changes);

    await this.audit.recordChange({
      action: 'wallet.transfer-limit-profile.updated',
      entityType: 'TransferLimitProfile',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }
}

/**
 * The changed fields only, for the audit trail.
 *
 * Recording the whole row before and after makes every audit entry look like a total rewrite and
 * buries the one field that actually moved.
 */
function pick(row: object, keys: string[]): Record<string, unknown> {
  /*
   * `object` rather than `Record<string, unknown>`: an interface with declared fields
   * has no index signature, so the constrained generic would reject every row type
   * this service defines. The cast is contained to this one line.
   */
  const source = row as Record<string, unknown>;

  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

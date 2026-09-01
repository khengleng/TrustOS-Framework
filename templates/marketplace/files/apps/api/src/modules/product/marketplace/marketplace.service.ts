import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Marketplace domain service.
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

export interface SellerRow {
  id: string;
  organizationId: string;
  merchantId: string;
  displayName: string;
  code: string;
  status: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  commissionRate: string;
  payoutCurrency: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ListingRow {
  id: string;
  organizationId: string;
  sellerId: string;
  variantId: string;
  price: string;
  currency: string;
  stockOnHand: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface SellerPayoutRow {
  id: string;
  organizationId: string;
  sellerId: string;
  reference: string;
  periodStart: Date;
  periodEnd: Date;
  grossAmount: string;
  commissionAmount: string;
  netAmount: string;
  currency: string;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'FAILED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DisputeRow {
  id: string;
  organizationId: string;
  orderId: string;
  sellerId: string;
  reason: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'REJECTED';
  resolutionNote: string | null;
  openedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class MarketplaceService {
  private readonly sellers: TenantRepository<SellerRow>;
  private readonly listings: TenantRepository<ListingRow>;
  private readonly sellerPayouts: TenantRepository<SellerPayoutRow>;
  private readonly disputes: TenantRepository<DisputeRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.sellers = new TenantRepository<SellerRow>(prisma, 'seller');
    this.listings = new TenantRepository<ListingRow>(prisma, 'listing');
    this.sellerPayouts = new TenantRepository<SellerPayoutRow>(prisma, 'sellerPayout');
    this.disputes = new TenantRepository<DisputeRow>(prisma, 'dispute');
  }

  // --- sellers -----------------------------------------------------

  listSellers(): Promise<SellerRow[]> {
    return this.sellers.list();
  }

  findSeller(id: string, organizationId: string): Promise<SellerRow> {
    return this.sellers.findById(id, organizationId);
  }

  async createSeller(
    input: {
      merchantId: string;
      displayName: string;
      code: string;
      status?: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
      commissionRate: string;
      payoutCurrency: string;
    },
    organizationId: string,
  ): Promise<SellerRow> {
    const created = await this.sellers.create({
      merchantId: input.merchantId,
      displayName: input.displayName,
      code: input.code,
      status: input.status,
      commissionRate: input.commissionRate,
      payoutCurrency: input.payoutCurrency,
    });

    await this.audit.record({
      action: 'marketplace.seller.created',
      entityType: 'Seller',
      entityId: created.id,
      organizationId,
      after: {
        merchantId: created.merchantId,
        displayName: created.displayName,
        code: created.code,
      },
    });

    return created;
  }

  async updateSeller(
    id: string,
    changes: {
      merchantId?: string;
      displayName?: string;
      status?: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
      commissionRate?: string;
      payoutCurrency?: string;
    },
    organizationId: string,
  ): Promise<SellerRow> {
    const existing = await this.sellers.findById(id, organizationId);

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

    const updated = await this.sellers.update(id, changes);

    await this.audit.recordChange({
      action: 'marketplace.seller.updated',
      entityType: 'Seller',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- listings ----------------------------------------------------

  listListings(): Promise<ListingRow[]> {
    return this.listings.list();
  }

  findListing(id: string, organizationId: string): Promise<ListingRow> {
    return this.listings.findById(id, organizationId);
  }

  async createListing(
    input: {
      sellerId: string;
      variantId: string;
      price: string;
      currency: string;
      stockOnHand?: number;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<ListingRow> {
    await this.sellers.findById(input.sellerId, organizationId);

    const created = await this.listings.create({
      sellerId: input.sellerId,
      variantId: input.variantId,
      price: input.price,
      currency: input.currency,
      stockOnHand: input.stockOnHand,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'marketplace.listing.created',
      entityType: 'Listing',
      entityId: created.id,
      organizationId,
      after: { sellerId: created.sellerId, variantId: created.variantId, price: created.price },
    });

    return created;
  }

  async updateListing(
    id: string,
    changes: {
      sellerId?: string;
      variantId?: string;
      price?: string;
      currency?: string;
      stockOnHand?: number;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<ListingRow> {
    const existing = await this.listings.findById(id, organizationId);

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

    const updated = await this.listings.update(id, changes);

    await this.audit.recordChange({
      action: 'marketplace.listing.updated',
      entityType: 'Listing',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- payouts -----------------------------------------------------

  listSellerPayouts(): Promise<SellerPayoutRow[]> {
    return this.sellerPayouts.list();
  }

  findSellerPayout(id: string, organizationId: string): Promise<SellerPayoutRow> {
    return this.sellerPayouts.findById(id, organizationId);
  }

  async createSellerPayout(
    input: {
      sellerId: string;
      reference: string;
      periodStart: Date;
      periodEnd: Date;
      grossAmount: string;
      commissionAmount: string;
      netAmount: string;
      currency: string;
      status?: 'DRAFT' | 'APPROVED' | 'PAID' | 'FAILED';
    },
    organizationId: string,
  ): Promise<SellerPayoutRow> {
    await this.sellers.findById(input.sellerId, organizationId);

    const created = await this.sellerPayouts.create({
      sellerId: input.sellerId,
      reference: input.reference,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      grossAmount: input.grossAmount,
      commissionAmount: input.commissionAmount,
      netAmount: input.netAmount,
      currency: input.currency,
      status: input.status,
    });

    await this.audit.record({
      action: 'marketplace.seller-payout.created',
      entityType: 'SellerPayout',
      entityId: created.id,
      organizationId,
      after: {
        sellerId: created.sellerId,
        reference: created.reference,
        periodStart: created.periodStart,
      },
    });

    return created;
  }

  async updateSellerPayout(
    id: string,
    changes: {
      sellerId?: string;
      periodStart?: Date;
      periodEnd?: Date;
      grossAmount?: string;
      commissionAmount?: string;
      netAmount?: string;
      currency?: string;
      status?: 'DRAFT' | 'APPROVED' | 'PAID' | 'FAILED';
    },
    organizationId: string,
  ): Promise<SellerPayoutRow> {
    const existing = await this.sellerPayouts.findById(id, organizationId);

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

    const updated = await this.sellerPayouts.update(id, changes);

    await this.audit.recordChange({
      action: 'marketplace.seller-payout.updated',
      entityType: 'SellerPayout',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- disputes ----------------------------------------------------

  listDisputes(): Promise<DisputeRow[]> {
    return this.disputes.list();
  }

  findDispute(id: string, organizationId: string): Promise<DisputeRow> {
    return this.disputes.findById(id, organizationId);
  }

  async createDispute(
    input: {
      orderId: string;
      sellerId: string;
      reason: string;
      status?: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'REJECTED';
      resolutionNote?: string;
      openedAt: Date;
    },
    organizationId: string,
  ): Promise<DisputeRow> {
    await this.sellers.findById(input.sellerId, organizationId);

    const created = await this.disputes.create({
      orderId: input.orderId,
      sellerId: input.sellerId,
      reason: input.reason,
      status: input.status,
      resolutionNote: input.resolutionNote ?? null,
      openedAt: input.openedAt,
    });

    await this.audit.record({
      action: 'marketplace.dispute.created',
      entityType: 'Dispute',
      entityId: created.id,
      organizationId,
      after: { orderId: created.orderId, sellerId: created.sellerId, reason: created.reason },
    });

    return created;
  }

  async updateDispute(
    id: string,
    changes: {
      orderId?: string;
      sellerId?: string;
      reason?: string;
      status?: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'REJECTED';
      resolutionNote?: string;
      openedAt?: Date;
    },
    organizationId: string,
  ): Promise<DisputeRow> {
    const existing = await this.disputes.findById(id, organizationId);

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

    const updated = await this.disputes.update(id, changes);

    await this.audit.recordChange({
      action: 'marketplace.dispute.updated',
      entityType: 'Dispute',
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

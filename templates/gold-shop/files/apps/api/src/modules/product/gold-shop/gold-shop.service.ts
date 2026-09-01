import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Gold Shop domain service.
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

export interface GoldPriceRow {
  id: string;
  organizationId: string;
  karat: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
  pricePerGram: string;
  currency: string;
  source: string;
  quotedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface GoldItemRow {
  id: string;
  organizationId: string;
  tag: string;
  name: string;
  karat: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
  grossWeightGrams: string;
  goldWeightGrams: string;
  labourCost: string;
  currency: string;
  status: 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'MELTED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface GoldOrderRow {
  id: string;
  organizationId: string;
  reference: string;
  itemId: string;
  priceId: string;
  direction: 'SELL_TO_CUSTOMER' | 'BUY_FROM_CUSTOMER';
  customerName: string;
  customerPhone: string | null;
  goldValue: string;
  labourCost: string;
  total: string;
  currency: string;
  status: 'DRAFT' | 'CONFIRMED' | 'SETTLED' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface GoldInvoiceRow {
  id: string;
  organizationId: string;
  orderId: string;
  number: string;
  issuedAt: Date;
  total: string;
  currency: string;
  status: 'ISSUED' | 'PAID' | 'VOID';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class GoldShopService {
  private readonly goldPrices: TenantRepository<GoldPriceRow>;
  private readonly goldItems: TenantRepository<GoldItemRow>;
  private readonly goldOrders: TenantRepository<GoldOrderRow>;
  private readonly goldInvoices: TenantRepository<GoldInvoiceRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.goldPrices = new TenantRepository<GoldPriceRow>(prisma, 'goldPrice');
    this.goldItems = new TenantRepository<GoldItemRow>(prisma, 'goldItem');
    this.goldOrders = new TenantRepository<GoldOrderRow>(prisma, 'goldOrder');
    this.goldInvoices = new TenantRepository<GoldInvoiceRow>(prisma, 'goldInvoice');
  }

  // --- price quotes ------------------------------------------------

  listGoldPrices(): Promise<GoldPriceRow[]> {
    return this.goldPrices.list();
  }

  findGoldPrice(id: string, organizationId: string): Promise<GoldPriceRow> {
    return this.goldPrices.findById(id, organizationId);
  }

  async createGoldPrice(
    input: {
      karat: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
      pricePerGram: string;
      currency: string;
      source: string;
      quotedAt: Date;
    },
    organizationId: string,
  ): Promise<GoldPriceRow> {
    const created = await this.goldPrices.create({
      karat: input.karat,
      pricePerGram: input.pricePerGram,
      currency: input.currency,
      source: input.source,
      quotedAt: input.quotedAt,
    });

    await this.audit.record({
      action: 'goldshop.gold-price.created',
      entityType: 'GoldPrice',
      entityId: created.id,
      organizationId,
      after: {
        karat: created.karat,
        pricePerGram: created.pricePerGram,
        currency: created.currency,
      },
    });

    return created;
  }

  async updateGoldPrice(
    id: string,
    changes: {
      karat?: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
      pricePerGram?: string;
      currency?: string;
      source?: string;
      quotedAt?: Date;
    },
    organizationId: string,
  ): Promise<GoldPriceRow> {
    const existing = await this.goldPrices.findById(id, organizationId);

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

    const updated = await this.goldPrices.update(id, changes);

    await this.audit.recordChange({
      action: 'goldshop.gold-price.updated',
      entityType: 'GoldPrice',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- inventory ---------------------------------------------------

  listGoldItems(): Promise<GoldItemRow[]> {
    return this.goldItems.list();
  }

  findGoldItem(id: string, organizationId: string): Promise<GoldItemRow> {
    return this.goldItems.findById(id, organizationId);
  }

  async createGoldItem(
    input: {
      tag: string;
      name: string;
      karat: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
      grossWeightGrams: string;
      goldWeightGrams: string;
      labourCost: string;
      currency: string;
      status?: 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'MELTED';
    },
    organizationId: string,
  ): Promise<GoldItemRow> {
    const created = await this.goldItems.create({
      tag: input.tag,
      name: input.name,
      karat: input.karat,
      grossWeightGrams: input.grossWeightGrams,
      goldWeightGrams: input.goldWeightGrams,
      labourCost: input.labourCost,
      currency: input.currency,
      status: input.status,
    });

    await this.audit.record({
      action: 'goldshop.gold-item.created',
      entityType: 'GoldItem',
      entityId: created.id,
      organizationId,
      after: { tag: created.tag, name: created.name, karat: created.karat },
    });

    return created;
  }

  async updateGoldItem(
    id: string,
    changes: {
      name?: string;
      karat?: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
      grossWeightGrams?: string;
      goldWeightGrams?: string;
      labourCost?: string;
      currency?: string;
      status?: 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'MELTED';
    },
    organizationId: string,
  ): Promise<GoldItemRow> {
    const existing = await this.goldItems.findById(id, organizationId);

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

    const updated = await this.goldItems.update(id, changes);

    await this.audit.recordChange({
      action: 'goldshop.gold-item.updated',
      entityType: 'GoldItem',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- orders ------------------------------------------------------

  listGoldOrders(): Promise<GoldOrderRow[]> {
    return this.goldOrders.list();
  }

  findGoldOrder(id: string, organizationId: string): Promise<GoldOrderRow> {
    return this.goldOrders.findById(id, organizationId);
  }

  async createGoldOrder(
    input: {
      reference: string;
      itemId: string;
      priceId: string;
      direction: 'SELL_TO_CUSTOMER' | 'BUY_FROM_CUSTOMER';
      customerName: string;
      customerPhone?: string;
      goldValue: string;
      labourCost: string;
      total: string;
      currency: string;
      status?: 'DRAFT' | 'CONFIRMED' | 'SETTLED' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<GoldOrderRow> {
    await this.goldItems.findById(input.itemId, organizationId);
    await this.goldPrices.findById(input.priceId, organizationId);

    const created = await this.goldOrders.create({
      reference: input.reference,
      itemId: input.itemId,
      priceId: input.priceId,
      direction: input.direction,
      customerName: input.customerName,
      customerPhone: input.customerPhone ?? null,
      goldValue: input.goldValue,
      labourCost: input.labourCost,
      total: input.total,
      currency: input.currency,
      status: input.status,
    });

    await this.audit.record({
      action: 'goldshop.gold-order.created',
      entityType: 'GoldOrder',
      entityId: created.id,
      organizationId,
      after: { reference: created.reference, itemId: created.itemId, priceId: created.priceId },
    });

    return created;
  }

  async updateGoldOrder(
    id: string,
    changes: {
      itemId?: string;
      priceId?: string;
      direction?: 'SELL_TO_CUSTOMER' | 'BUY_FROM_CUSTOMER';
      customerName?: string;
      customerPhone?: string;
      goldValue?: string;
      labourCost?: string;
      total?: string;
      currency?: string;
      status?: 'DRAFT' | 'CONFIRMED' | 'SETTLED' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<GoldOrderRow> {
    const existing = await this.goldOrders.findById(id, organizationId);

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

    const updated = await this.goldOrders.update(id, changes);

    await this.audit.recordChange({
      action: 'goldshop.gold-order.updated',
      entityType: 'GoldOrder',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- invoices ----------------------------------------------------

  listGoldInvoices(): Promise<GoldInvoiceRow[]> {
    return this.goldInvoices.list();
  }

  findGoldInvoice(id: string, organizationId: string): Promise<GoldInvoiceRow> {
    return this.goldInvoices.findById(id, organizationId);
  }

  async createGoldInvoice(
    input: {
      orderId: string;
      number: string;
      issuedAt: Date;
      total: string;
      currency: string;
      status?: 'ISSUED' | 'PAID' | 'VOID';
    },
    organizationId: string,
  ): Promise<GoldInvoiceRow> {
    await this.goldOrders.findById(input.orderId, organizationId);

    const created = await this.goldInvoices.create({
      orderId: input.orderId,
      number: input.number,
      issuedAt: input.issuedAt,
      total: input.total,
      currency: input.currency,
      status: input.status,
    });

    await this.audit.record({
      action: 'goldshop.gold-invoice.created',
      entityType: 'GoldInvoice',
      entityId: created.id,
      organizationId,
      after: { orderId: created.orderId, number: created.number, issuedAt: created.issuedAt },
    });

    return created;
  }

  async updateGoldInvoice(
    id: string,
    changes: {
      orderId?: string;
      issuedAt?: Date;
      total?: string;
      currency?: string;
      status?: 'ISSUED' | 'PAID' | 'VOID';
    },
    organizationId: string,
  ): Promise<GoldInvoiceRow> {
    const existing = await this.goldInvoices.findById(id, organizationId);

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

    const updated = await this.goldInvoices.update(id, changes);

    await this.audit.recordChange({
      action: 'goldshop.gold-invoice.updated',
      entityType: 'GoldInvoice',
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

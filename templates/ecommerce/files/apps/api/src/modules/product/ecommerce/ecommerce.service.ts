import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS E-commerce domain service.
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

export interface CatalogRow {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  code: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ProductRow {
  id: string;
  organizationId: string;
  catalogId: string;
  name: string;
  sku: string;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ProductVariantRow {
  id: string;
  organizationId: string;
  productId: string;
  name: string;
  sku: string;
  price: string;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface OrderRow {
  id: string;
  organizationId: string;
  storeId: string;
  reference: string;
  customerName: string;
  customerPhone: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED';
  total: string;
  currency: string;
  placedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface OrderLineRow {
  id: string;
  organizationId: string;
  orderId: string;
  variantId: string;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class EcommerceService {
  private readonly catalogs: TenantRepository<CatalogRow>;
  private readonly products: TenantRepository<ProductRow>;
  private readonly productVariants: TenantRepository<ProductVariantRow>;
  private readonly orders: TenantRepository<OrderRow>;
  private readonly orderLines: TenantRepository<OrderLineRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.catalogs = new TenantRepository<CatalogRow>(prisma, 'catalog');
    this.products = new TenantRepository<ProductRow>(prisma, 'product');
    this.productVariants = new TenantRepository<ProductVariantRow>(prisma, 'productVariant');
    this.orders = new TenantRepository<OrderRow>(prisma, 'order');
    this.orderLines = new TenantRepository<OrderLineRow>(prisma, 'orderLine');
  }

  // --- catalogs ----------------------------------------------------

  listCatalogs(): Promise<CatalogRow[]> {
    return this.catalogs.list();
  }

  findCatalog(id: string, organizationId: string): Promise<CatalogRow> {
    return this.catalogs.findById(id, organizationId);
  }

  async createCatalog(
    input: {
      storeId: string;
      name: string;
      code: string;
      isDefault?: boolean;
    },
    organizationId: string,
  ): Promise<CatalogRow> {
    const created = await this.catalogs.create({
      storeId: input.storeId,
      name: input.name,
      code: input.code,
      isDefault: input.isDefault,
    });

    await this.audit.record({
      action: 'ecommerce.catalog.created',
      entityType: 'Catalog',
      entityId: created.id,
      organizationId,
      after: { storeId: created.storeId, name: created.name, code: created.code },
    });

    return created;
  }

  async updateCatalog(
    id: string,
    changes: {
      storeId?: string;
      name?: string;
      isDefault?: boolean;
    },
    organizationId: string,
  ): Promise<CatalogRow> {
    const existing = await this.catalogs.findById(id, organizationId);

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

    const updated = await this.catalogs.update(id, changes);

    await this.audit.recordChange({
      action: 'ecommerce.catalog.updated',
      entityType: 'Catalog',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- products ----------------------------------------------------

  listProducts(): Promise<ProductRow[]> {
    return this.products.list();
  }

  findProduct(id: string, organizationId: string): Promise<ProductRow> {
    return this.products.findById(id, organizationId);
  }

  async createProduct(
    input: {
      catalogId: string;
      name: string;
      sku: string;
      description?: string;
      status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    },
    organizationId: string,
  ): Promise<ProductRow> {
    await this.catalogs.findById(input.catalogId, organizationId);

    const created = await this.products.create({
      catalogId: input.catalogId,
      name: input.name,
      sku: input.sku,
      description: input.description ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'ecommerce.product.created',
      entityType: 'Product',
      entityId: created.id,
      organizationId,
      after: { catalogId: created.catalogId, name: created.name, sku: created.sku },
    });

    return created;
  }

  async updateProduct(
    id: string,
    changes: {
      catalogId?: string;
      name?: string;
      sku?: string;
      description?: string;
      status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    },
    organizationId: string,
  ): Promise<ProductRow> {
    const existing = await this.products.findById(id, organizationId);

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

    const updated = await this.products.update(id, changes);

    await this.audit.recordChange({
      action: 'ecommerce.product.updated',
      entityType: 'Product',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- variants ----------------------------------------------------

  listProductVariants(): Promise<ProductVariantRow[]> {
    return this.productVariants.list();
  }

  findProductVariant(id: string, organizationId: string): Promise<ProductVariantRow> {
    return this.productVariants.findById(id, organizationId);
  }

  async createProductVariant(
    input: {
      productId: string;
      name: string;
      sku: string;
      price: string;
      currency: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<ProductVariantRow> {
    await this.products.findById(input.productId, organizationId);

    const created = await this.productVariants.create({
      productId: input.productId,
      name: input.name,
      sku: input.sku,
      price: input.price,
      currency: input.currency,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'ecommerce.product-variant.created',
      entityType: 'ProductVariant',
      entityId: created.id,
      organizationId,
      after: { productId: created.productId, name: created.name, sku: created.sku },
    });

    return created;
  }

  async updateProductVariant(
    id: string,
    changes: {
      productId?: string;
      name?: string;
      sku?: string;
      price?: string;
      currency?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<ProductVariantRow> {
    const existing = await this.productVariants.findById(id, organizationId);

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

    const updated = await this.productVariants.update(id, changes);

    await this.audit.recordChange({
      action: 'ecommerce.product-variant.updated',
      entityType: 'ProductVariant',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- orders ------------------------------------------------------

  listOrders(): Promise<OrderRow[]> {
    return this.orders.list();
  }

  findOrder(id: string, organizationId: string): Promise<OrderRow> {
    return this.orders.findById(id, organizationId);
  }

  async createOrder(
    input: {
      storeId: string;
      reference: string;
      customerName: string;
      customerPhone?: string;
      status?: 'PENDING' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED';
      total: string;
      currency: string;
      placedAt: Date;
    },
    organizationId: string,
  ): Promise<OrderRow> {
    const created = await this.orders.create({
      storeId: input.storeId,
      reference: input.reference,
      customerName: input.customerName,
      customerPhone: input.customerPhone ?? null,
      status: input.status,
      total: input.total,
      currency: input.currency,
      placedAt: input.placedAt,
    });

    await this.audit.record({
      action: 'ecommerce.order.created',
      entityType: 'Order',
      entityId: created.id,
      organizationId,
      after: {
        storeId: created.storeId,
        reference: created.reference,
        customerName: created.customerName,
      },
    });

    return created;
  }

  async updateOrder(
    id: string,
    changes: {
      storeId?: string;
      customerName?: string;
      customerPhone?: string;
      status?: 'PENDING' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED';
      total?: string;
      currency?: string;
      placedAt?: Date;
    },
    organizationId: string,
  ): Promise<OrderRow> {
    const existing = await this.orders.findById(id, organizationId);

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

    const updated = await this.orders.update(id, changes);

    await this.audit.recordChange({
      action: 'ecommerce.order.updated',
      entityType: 'Order',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- order lines -------------------------------------------------

  listOrderLines(): Promise<OrderLineRow[]> {
    return this.orderLines.list();
  }

  findOrderLine(id: string, organizationId: string): Promise<OrderLineRow> {
    return this.orderLines.findById(id, organizationId);
  }

  async createOrderLine(
    input: {
      orderId: string;
      variantId: string;
      description: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
    },
    organizationId: string,
  ): Promise<OrderLineRow> {
    await this.orders.findById(input.orderId, organizationId);
    await this.productVariants.findById(input.variantId, organizationId);

    const created = await this.orderLines.create({
      orderId: input.orderId,
      variantId: input.variantId,
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      lineTotal: input.lineTotal,
    });

    await this.audit.record({
      action: 'ecommerce.order-line.created',
      entityType: 'OrderLine',
      entityId: created.id,
      organizationId,
      after: {
        orderId: created.orderId,
        variantId: created.variantId,
        description: created.description,
      },
    });

    return created;
  }

  async updateOrderLine(
    id: string,
    changes: {
      orderId?: string;
      variantId?: string;
      description?: string;
      quantity?: number;
      unitPrice?: string;
      lineTotal?: string;
    },
    organizationId: string,
  ): Promise<OrderLineRow> {
    const existing = await this.orderLines.findById(id, organizationId);

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

    const updated = await this.orderLines.update(id, changes);

    await this.audit.recordChange({
      action: 'ecommerce.order-line.updated',
      entityType: 'OrderLine',
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

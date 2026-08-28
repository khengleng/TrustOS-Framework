/**
 * Shared types — TrustOS E-commerce.
 *
 * The shapes the API returns and the admin consumes. One definition, imported by both, so a
 * renamed field is a compile error rather than an empty column.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull a server-only
 * module into a browser bundle. The admin application imports this package directly, so anything
 * reachable from here reaches the client.
 */

/** ISO-8601 timestamp as it crosses the API boundary. */
export type IsoDateTime = string;

/** Fields every tenant-owned entity exposes. */
export interface TenantOwnedSummary {
  id: string;
  organizationId: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A set of products offered by a store. */
export interface Catalog {
  id: string;
  storeId: string;
  name: string;
  code: string;
  isDefault: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something a customer can buy. Variants carry the price. */
export interface Product {
  id: string;
  catalogId: string;
  name: string;
  sku: string;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A buyable configuration of a product, with its own price. */
export interface ProductVariant {
  id: string;
  productId: string;
  name: string;
  sku: string;
  price: string;
  currency: string;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A customer purchase. `total` is stored rather than summed on read: an order is what was agreed */
/** at the time, and recomputing it from current prices rewrites history. */
export interface Order {
  id: string;
  storeId: string;
  reference: string;
  customerName: string;
  customerPhone: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED';
  total: string;
  currency: string;
  placedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One product on an order, priced as it was when the order was placed. The variant may change */
/** afterwards; the line does not. */
export interface OrderLine {
  id: string;
  orderId: string;
  variantId: string;
  description: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

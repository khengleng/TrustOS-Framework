/**
 * Shared types — TrustOS Gold Shop.
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

/** A quote at a moment. Immutable once written: an order priced against a quote that was later */
/** edited cannot be reconciled with anything. */
export interface GoldPrice {
  id: string;
  karat: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
  pricePerGram: string;
  currency: string;
  source: string;
  quotedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A physical piece held in stock, identified by its tag. */
export interface GoldItem {
  id: string;
  tag: string;
  name: string;
  karat: 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
  grossWeightGrams: string;
  goldWeightGrams: string;
  labourCost: string;
  currency: string;
  status: 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'MELTED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A customer buying or selling back a piece, priced against a recorded quote. */
export interface GoldOrder {
  id: string;
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
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The document issued for an order. */
export interface GoldInvoice {
  id: string;
  orderId: string;
  number: string;
  issuedAt: Date;
  total: string;
  currency: string;
  status: 'ISSUED' | 'PAID' | 'VOID';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

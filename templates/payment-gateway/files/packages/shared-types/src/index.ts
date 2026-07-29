/**
 * Types shared between the API and the admin application.
 *
 * Note what is absent: there is no type carrying an API key or a webhook
 * secret. Those cross the wire exactly once, in the response that creates
 * them, and are modelled there rather than in a shared shape that invites
 * reuse.
 */

export type PaymentStatus =
  'CREATED' | 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'CANCELLED';

export type MerchantAccountStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';

export interface MerchantAccountSummary {
  id: string;
  organizationId: string;
  displayName: string;
  reference: string;
  status: MerchantAccountStatus;
  defaultCurrency: string;
  createdAt: string;
}

/** Safe to render. Carries a display prefix, never the key. */
export interface ApiKeySummary {
  id: string;
  organizationId: string;
  merchantAccountId: string;
  label: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export interface PaymentSummary {
  id: string;
  organizationId: string;
  merchantAccountId: string;
  idempotencyKey: string;
  /** Minor units. 1050 USD means $10.50. */
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  reference: string;
  description: string | null;
  providerReference: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface PaymentStatusHistoryEntry {
  id: string;
  paymentId: string;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  reason: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface WebhookEndpointSummary {
  id: string;
  organizationId: string;
  merchantAccountId: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
}

/** Formats minor units for display. Never used for arithmetic. */
export function formatMinorUnits(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

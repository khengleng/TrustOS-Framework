/**
 * Payment provider interface.
 *
 * The gateway is written against this port, not against a provider SDK. The
 * only implementation in this phase is a mock — Bakong, KHQR and any real
 * provider are deliberately out of scope and must not be added without
 * approval.
 *
 * The point of shipping the seam now is that integrating a provider later
 * becomes one adapter plus its tests, rather than a rewrite of the payment
 * flow.
 */

export interface ProviderAuthorizeRequest {
  paymentId: string;
  amountMinor: number;
  currency: string;
  reference: string;
}

export interface ProviderResult {
  ok: boolean;
  /** The provider's own identifier, stored for reconciliation. */
  providerReference: string | null;
  /** Populated when `ok` is false. Safe to show an operator, not a payer. */
  failureReason: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  authorize(request: ProviderAuthorizeRequest): Promise<ProviderResult>;
  capture(paymentId: string, providerReference: string): Promise<ProviderResult>;
  cancel(paymentId: string, providerReference: string): Promise<ProviderResult>;
}

/**
 * Deterministic mock provider.
 *
 * Deterministic on purpose: a mock that succeeds at random makes tests flaky
 * and hides real failures. Authorization fails when the amount ends in `13`,
 * which gives a stable way to exercise the failure path without a flag that
 * production code might read.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async authorize(request: ProviderAuthorizeRequest): Promise<ProviderResult> {
    if (request.amountMinor % 100 === 13) {
      return {
        ok: false,
        providerReference: null,
        failureReason: 'declined_by_issuer',
      };
    }

    return {
      ok: true,
      providerReference: `mock_auth_${request.paymentId}`,
      failureReason: null,
    };
  }

  async capture(paymentId: string): Promise<ProviderResult> {
    return { ok: true, providerReference: `mock_cap_${paymentId}`, failureReason: null };
  }

  async cancel(paymentId: string): Promise<ProviderResult> {
    return { ok: true, providerReference: `mock_cnl_${paymentId}`, failureReason: null };
  }
}

export const PAYMENT_PROVIDER = Symbol.for('product.payment-provider');

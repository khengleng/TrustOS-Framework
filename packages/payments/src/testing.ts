import type { PaymentRequest, PaymentRequestStatus, PaymentRequestStore } from './payment-request';

/** An in-memory payment request store, for tests and development. */
export class InMemoryPaymentRequestStore implements PaymentRequestStore {
  readonly requests = new Map<string, PaymentRequest>();

  async create(request: PaymentRequest): Promise<PaymentRequest> {
    this.requests.set(request.id, request);
    return request;
  }

  async find(id: string, organizationId: string | null): Promise<PaymentRequest | null> {
    const request = this.requests.get(id);
    if (!request || request.organizationId !== organizationId) return null;
    return request;
  }

  async findByReference(
    reference: string,
    organizationId: string | null,
  ): Promise<PaymentRequest | null> {
    return (
      [...this.requests.values()].find(
        (request) => request.reference === reference && request.organizationId === organizationId,
      ) ?? null
    );
  }

  async update(id: string, patch: Partial<PaymentRequest>): Promise<PaymentRequest | null> {
    const request = this.requests.get(id);
    if (!request) return null;

    const updated = { ...request, ...patch } as PaymentRequest;
    this.requests.set(id, updated);
    return updated;
  }

  async list(input: {
    organizationId: string | null;
    status?: PaymentRequestStatus;
    payerId?: string;
    invoiceReference?: string;
    limit?: number;
  }): Promise<PaymentRequest[]> {
    return [...this.requests.values()]
      .filter((request) => request.organizationId === input.organizationId)
      .filter((request) => !input.status || request.status === input.status)
      .filter((request) => !input.payerId || request.payerId === input.payerId)
      .filter(
        (request) => !input.invoiceReference || request.invoiceReference === input.invoiceReference,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit ?? 200);
  }

  async expired(organizationId: string | null, at: Date, limit = 100): Promise<PaymentRequest[]> {
    return [...this.requests.values()]
      .filter((request) => request.organizationId === organizationId)
      .filter((request) => request.expiresAt <= at)
      .filter((request) => !['paid', 'cancelled', 'expired', 'refunded'].includes(request.status))
      .slice(0, limit);
  }
}

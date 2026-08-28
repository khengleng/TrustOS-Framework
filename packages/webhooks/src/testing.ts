import type {
  WebhookAttempt,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookSecret,
  WebhookSubscription,
} from './entities';
import type {
  WebhookDeliveryStore,
  WebhookEndpointStore,
  WebhookSecretStore,
  WebhookSubscriptionStore,
} from './ports';

/**
 * In-memory stores.
 *
 * For tests and for a development process. Every one of them loses everything on restart, which
 * for webhooks means losing deliveries that were accepted and never sent — so they are named for
 * what they are and exported from a file called `testing`.
 *
 * They also serve a second purpose: they are the reference for what a real implementation must
 * do. The two methods with comments in capitals — `enqueue` and `claimDue` — are the ones where
 * an implementation that looks right is wrong, and the notes here say why.
 */

export class InMemoryWebhookEndpointStore implements WebhookEndpointStore {
  readonly endpoints = new Map<string, WebhookEndpoint>();
  private readonly subscriptions: InMemoryWebhookSubscriptionStore;

  constructor(subscriptions: InMemoryWebhookSubscriptionStore) {
    this.subscriptions = subscriptions;
  }

  async create(
    endpoint: Omit<WebhookEndpoint, 'createdAt' | 'updatedAt'>,
  ): Promise<WebhookEndpoint> {
    const now = new Date();
    const stored: WebhookEndpoint = { ...endpoint, createdAt: now, updatedAt: now };
    this.endpoints.set(stored.id, stored);
    return stored;
  }

  async findById(id: string, organizationId: string | null): Promise<WebhookEndpoint | null> {
    const endpoint = this.endpoints.get(id);
    // The tenant check is part of the lookup, not a separate step a caller might skip.
    if (!endpoint || endpoint.organizationId !== organizationId) return null;
    return endpoint;
  }

  async list(filter: {
    organizationId: string | null;
    status?: WebhookEndpoint['status'];
    limit?: number;
    offset?: number;
  }): Promise<{ items: WebhookEndpoint[]; total: number }> {
    const all = [...this.endpoints.values()]
      .filter((endpoint) => endpoint.organizationId === filter.organizationId)
      .filter((endpoint) => !filter.status || endpoint.status === filter.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = filter.offset ?? 0;
    return { items: all.slice(offset, offset + (filter.limit ?? 50)), total: all.length };
  }

  async update(
    id: string,
    organizationId: string | null,
    patch: Partial<WebhookEndpoint>,
  ): Promise<WebhookEndpoint | null> {
    const endpoint = await this.findById(id, organizationId);
    if (!endpoint) return null;

    const updated = { ...endpoint, ...patch, updatedAt: new Date() };
    this.endpoints.set(id, updated);
    return updated;
  }

  async delete(id: string, organizationId: string | null): Promise<boolean> {
    const endpoint = await this.findById(id, organizationId);
    if (!endpoint) return false;
    this.endpoints.delete(id);
    return true;
  }

  async findSubscribedTo(
    eventName: string,
    organizationId: string | null,
  ): Promise<Array<WebhookEndpoint & { patterns: string[] }>> {
    void eventName;

    return [...this.endpoints.values()]
      .filter((endpoint) => endpoint.organizationId === organizationId)
      .map((endpoint) => ({
        ...endpoint,
        patterns: this.subscriptions
          .forEndpoint(endpoint.id)
          .map((subscription) => subscription.eventPattern),
      }))
      .filter((endpoint) => endpoint.patterns.length > 0);
  }
}

export class InMemoryWebhookSubscriptionStore implements WebhookSubscriptionStore {
  readonly subscriptions = new Map<string, WebhookSubscription>();

  async create(subscription: Omit<WebhookSubscription, 'createdAt'>): Promise<WebhookSubscription> {
    const stored: WebhookSubscription = { ...subscription, createdAt: new Date() };
    this.subscriptions.set(stored.id, stored);
    return stored;
  }

  async listByEndpoint(
    endpointId: string,
    organizationId: string | null,
  ): Promise<WebhookSubscription[]> {
    return [...this.subscriptions.values()].filter(
      (subscription) =>
        subscription.endpointId === endpointId && subscription.organizationId === organizationId,
    );
  }

  async delete(id: string, organizationId: string | null): Promise<boolean> {
    const subscription = this.subscriptions.get(id);
    if (!subscription || subscription.organizationId !== organizationId) return false;
    this.subscriptions.delete(id);
    return true;
  }

  /** Unscoped, for the endpoint store's join. Not part of the port. */
  forEndpoint(endpointId: string): WebhookSubscription[] {
    return [...this.subscriptions.values()].filter(
      (subscription) => subscription.endpointId === endpointId,
    );
  }
}

export class InMemoryWebhookSecretStore implements WebhookSecretStore {
  readonly secrets = new Map<string, WebhookSecret>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(secret: Omit<WebhookSecret, 'createdAt'>): Promise<WebhookSecret> {
    const stored: WebhookSecret = { ...secret, createdAt: this.now() };
    this.secrets.set(stored.id, stored);
    return stored;
  }

  async findActive(endpointId: string, organizationId: string | null): Promise<WebhookSecret[]> {
    const now = this.now();

    return [...this.secrets.values()]
      .filter(
        (secret) =>
          secret.endpointId === endpointId &&
          secret.organizationId === organizationId &&
          secret.revokedAt === null &&
          // An expiry in the past means the rotation grace period has ended and this secret no
          // longer signs. Still stored, so the history shows it existed.
          (secret.expiresAt === null || secret.expiresAt > now),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findById(id: string, organizationId: string | null): Promise<WebhookSecret | null> {
    const secret = this.secrets.get(id);
    if (!secret || secret.organizationId !== organizationId) return null;
    return secret;
  }

  async revoke(id: string, organizationId: string | null): Promise<boolean> {
    const secret = await this.findById(id, organizationId);
    if (!secret) return false;
    this.secrets.set(id, { ...secret, revokedAt: this.now() });
    return true;
  }

  async expire(id: string, organizationId: string | null, expiresAt: Date): Promise<boolean> {
    const secret = await this.findById(id, organizationId);
    if (!secret) return false;
    this.secrets.set(id, { ...secret, expiresAt });
    return true;
  }
}

export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  readonly deliveries = new Map<string, WebhookDelivery>();
  readonly attempts: WebhookAttempt[] = [];

  /**
   * The uniqueness index that makes duplicate suppression real.
   *
   * `${endpointId}|${eventId}`. In a database this is a unique constraint and the insert either
   * succeeds or violates it; here it is a Set, and the equivalent atomicity comes free from
   * JavaScript being single-threaded. A real implementation must NOT read-then-write — two
   * workers racing would both read "absent" and both insert.
   */
  private readonly enqueued = new Set<string>();

  async enqueue(delivery: Omit<WebhookDelivery, 'createdAt'>): Promise<WebhookDelivery | null> {
    const key = `${delivery.endpointId}|${delivery.eventId}`;
    if (this.enqueued.has(key)) return null;

    this.enqueued.add(key);
    const stored: WebhookDelivery = { ...delivery, createdAt: new Date() };
    this.deliveries.set(stored.id, stored);
    return stored;
  }

  async findById(id: string, organizationId: string | null): Promise<WebhookDelivery | null> {
    const delivery = this.deliveries.get(id);
    if (!delivery || delivery.organizationId !== organizationId) return null;
    return delivery;
  }

  /**
   * Claims due deliveries.
   *
   * The status flips to `in_flight` in the same step as the read. In SQL that MUST be one
   * statement — `UPDATE ... WHERE status = 'pending' ... RETURNING`, or
   * `SELECT ... FOR UPDATE SKIP LOCKED`. A store that implements this as a `SELECT` followed by
   * an `UPDATE` sends every webhook twice the moment a second worker starts.
   */
  async claimDue(options: {
    now: Date;
    limit: number;
    workerId: string;
  }): Promise<WebhookDelivery[]> {
    const due = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          delivery.status === 'pending' &&
          delivery.nextAttemptAt !== null &&
          delivery.nextAttemptAt <= options.now,
      )
      .sort((a, b) => (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0))
      .slice(0, options.limit);

    for (const delivery of due) {
      this.deliveries.set(delivery.id, { ...delivery, status: 'in_flight' });
    }

    return due;
  }

  async markResult(
    id: string,
    result: {
      status: WebhookDeliveryStatus;
      attempts: number;
      nextAttemptAt: Date | null;
      responseStatus: number | null;
      responseBody: string | null;
      responseTimeMs: number | null;
      error: string | null;
      completedAt: Date | null;
    },
  ): Promise<void> {
    const delivery = this.deliveries.get(id);
    if (!delivery) return;
    this.deliveries.set(id, { ...delivery, ...result });
  }

  async recordAttempt(attempt: WebhookAttempt): Promise<void> {
    this.attempts.push(attempt);
  }

  async listAttempts(deliveryId: string, organizationId: string | null): Promise<WebhookAttempt[]> {
    return this.attempts
      .filter(
        (attempt) => attempt.deliveryId === deliveryId && attempt.organizationId === organizationId,
      )
      .sort((a, b) => a.attempt - b.attempt);
  }

  async list(filter: {
    organizationId: string | null;
    endpointId?: string;
    status?: WebhookDeliveryStatus;
    eventName?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ items: WebhookDelivery[]; total: number }> {
    const all = [...this.deliveries.values()]
      .filter((delivery) => delivery.organizationId === filter.organizationId)
      .filter((delivery) => !filter.endpointId || delivery.endpointId === filter.endpointId)
      .filter((delivery) => !filter.status || delivery.status === filter.status)
      .filter((delivery) => !filter.eventName || delivery.eventName === filter.eventName)
      .filter((delivery) => !filter.from || delivery.createdAt >= filter.from)
      .filter((delivery) => !filter.to || delivery.createdAt <= filter.to)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = filter.offset ?? 0;
    return { items: all.slice(offset, offset + (filter.limit ?? 50)), total: all.length };
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    let removed = 0;

    for (const [id, delivery] of this.deliveries) {
      if (delivery.createdAt < cutoff) {
        this.deliveries.delete(id);
        this.enqueued.delete(`${delivery.endpointId}|${delivery.eventId}`);
        removed += 1;
      }
    }

    return removed;
  }
}

/** All four stores, wired together. One call in a test setup rather than four. */
export function createInMemoryWebhookStores(now: () => Date = () => new Date()) {
  const subscriptions = new InMemoryWebhookSubscriptionStore();
  const endpoints = new InMemoryWebhookEndpointStore(subscriptions);
  const secrets = new InMemoryWebhookSecretStore(now);
  const deliveries = new InMemoryWebhookDeliveryStore();

  return { endpoints, subscriptions, secrets, deliveries };
}

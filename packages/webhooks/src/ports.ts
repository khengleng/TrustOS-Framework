import type {
  WebhookAttempt,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookSecret,
  WebhookSubscription,
} from './entities';

/**
 * Storage ports.
 *
 * Every method takes `organizationId` explicitly rather than relying on ambient context. That is
 * repetitive on purpose: a store method with no tenant parameter is one that can be called
 * without a tenant, and the resulting query returns every organization's rows. Making the
 * parameter mandatory means forgetting it is a compile error rather than a data breach.
 *
 * `null` means platform scope, which is why the type is `string | null` and not an optional.
 * `undefined` would let a caller omit it and get the platform's view by accident.
 */

export interface WebhookEndpointStore {
  create(endpoint: Omit<WebhookEndpoint, 'createdAt' | 'updatedAt'>): Promise<WebhookEndpoint>;
  findById(id: string, organizationId: string | null): Promise<WebhookEndpoint | null>;
  list(filter: {
    organizationId: string | null;
    status?: WebhookEndpoint['status'];
    limit?: number;
    offset?: number;
  }): Promise<{ items: WebhookEndpoint[]; total: number }>;
  update(
    id: string,
    organizationId: string | null,
    patch: Partial<
      Pick<
        WebhookEndpoint,
        | 'url'
        | 'description'
        | 'status'
        | 'consecutiveFailures'
        | 'lastSuccessAt'
        | 'lastFailureAt'
        | 'lastFailureReason'
        | 'disabledAt'
        | 'disabledReason'
      >
    >,
  ): Promise<WebhookEndpoint | null>;
  delete(id: string, organizationId: string | null): Promise<boolean>;

  /**
   * Every endpoint that might want this event.
   *
   * Returns endpoints with their patterns so the caller matches in code. A `LIKE` query cannot
   * express `workflow.*.assigned`, and an implementation that tried would either be wrong or be
   * a full scan pretending not to be.
   */
  findSubscribedTo(
    eventName: string,
    organizationId: string | null,
  ): Promise<Array<WebhookEndpoint & { patterns: string[] }>>;
}

export interface WebhookSecretStore {
  create(secret: Omit<WebhookSecret, 'createdAt'>): Promise<WebhookSecret>;
  /** Active secrets for signing, newest first. Usually one; two during a rotation. */
  findActive(endpointId: string, organizationId: string | null): Promise<WebhookSecret[]>;
  findById(id: string, organizationId: string | null): Promise<WebhookSecret | null>;
  revoke(id: string, organizationId: string | null): Promise<boolean>;
  /** Sets an expiry on the current secret at the start of a rotation. */
  expire(id: string, organizationId: string | null, expiresAt: Date): Promise<boolean>;
}

export interface WebhookSubscriptionStore {
  create(subscription: Omit<WebhookSubscription, 'createdAt'>): Promise<WebhookSubscription>;
  listByEndpoint(endpointId: string, organizationId: string | null): Promise<WebhookSubscription[]>;
  delete(id: string, organizationId: string | null): Promise<boolean>;
}

export interface WebhookDeliveryStore {
  /**
   * Records a delivery to be attempted.
   *
   * Returns null when one already exists for this `(endpointId, eventId)` pair. The uniqueness is
   * a database constraint, not a prior read — **"never send duplicate webhook deliveries"** is
   * only true if two workers racing on the same event cannot both win, and a check-then-insert
   * loses that race about as often as it is run under load.
   */
  enqueue(delivery: Omit<WebhookDelivery, 'createdAt'>): Promise<WebhookDelivery | null>;

  findById(id: string, organizationId: string | null): Promise<WebhookDelivery | null>;

  /**
   * Claims deliveries that are due.
   *
   * Must be atomic: two workers polling simultaneously must not both claim the same row. In SQL
   * that is `UPDATE ... WHERE status = 'pending' AND next_attempt_at <= now() ... RETURNING`, or
   * a `SELECT ... FOR UPDATE SKIP LOCKED`. A non-atomic implementation sends every webhook twice
   * the moment a second worker starts, which is the failure this whole package is trying to
   * prevent.
   */
  claimDue(options: { now: Date; limit: number; workerId: string }): Promise<WebhookDelivery[]>;

  markResult(
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
  ): Promise<void>;

  recordAttempt(attempt: Omit<WebhookAttempt, 'id'> & { id: string }): Promise<void>;

  listAttempts(deliveryId: string, organizationId: string | null): Promise<WebhookAttempt[]>;

  list(filter: {
    organizationId: string | null;
    endpointId?: string;
    status?: WebhookDeliveryStatus;
    eventName?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ items: WebhookDelivery[]; total: number }>;

  /**
   * Deletes deliveries older than a cutoff.
   *
   * Retention, and not optional in practice: a busy endpoint produces millions of rows a year,
   * and the delivery table is the first thing to make a database unmanageable. The framework
   * ships the method; how often it runs is a deployment decision.
   */
  purgeOlderThan(cutoff: Date): Promise<number>;
}

/**
 * Encrypts a secret at rest.
 *
 * A port because key management is a deployment decision — an env var, KMS, Vault. The framework
 * ships an AES-256-GCM implementation over a configured key, which is a real improvement over
 * plaintext and is not the same thing as a hardware-backed key.
 *
 * Why encryption rather than hashing, when a password would be hashed: signing needs the secret
 * back. There is no version of HMAC that works from a hash. That makes the encryption key the
 * thing that matters, and it belongs somewhere better than the same database as the ciphertext.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

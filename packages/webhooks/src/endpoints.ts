import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import { assertValidPattern } from '@trustos/event-sdk';
import type { EventRegistry } from '@trustos/event-registry';
import {
  webhookUrlSchema,
  type WebhookEndpoint,
  type WebhookSecret,
  type WebhookSubscription,
} from './entities';
import { generateWebhookSecret } from './signature';
import { secretHint } from './secrets';
import type {
  SecretCipher,
  WebhookDeliveryStore,
  WebhookEndpointStore,
  WebhookSecretStore,
  WebhookSubscriptionStore,
} from './ports';

/**
 * Managing endpoints, subscriptions and secrets.
 *
 * Everything an integrator does before a single webhook is sent. Two behaviours here are worth
 * reading before using it:
 *
 *   * **A secret is shown exactly once.** At creation and at rotation. There is no "show secret"
 *     endpoint, because one is indistinguishable from an exfiltration endpoint to anybody who has
 *     stolen a session — and a secret that can be re-read is one that gets copied into a ticket.
 *   * **Rotation overlaps.** The old secret keeps signing for a grace period alongside the new
 *     one. A rotation that cut over instantly would break every receiver simultaneously, which in
 *     practice means nobody rotates and the secret from 2019 is still live.
 */

export interface WebhookServiceOptions {
  endpoints: WebhookEndpointStore;
  secrets: WebhookSecretStore;
  subscriptions: WebhookSubscriptionStore;
  deliveries?: WebhookDeliveryStore;
  cipher: SecretCipher;
  registry: EventRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export interface CreateEndpointInput {
  organizationId: string | null;
  url: string;
  description?: string | null;
  /** Event patterns. At least one — an endpoint subscribed to nothing never receives anything. */
  events: string[];
  actorId: string | null;
}

/** The only shape that ever carries a secret value. Returned once, never stored in a read model. */
export interface EndpointWithSecret {
  endpoint: WebhookEndpoint;
  subscriptions: WebhookSubscription[];
  /**
   * The signing secret, in plaintext.
   *
   * This is the only time it is readable. Say so in the API response and in the UI — an
   * integrator who assumes they can fetch it later will paste it somewhere they should not to
   * avoid losing it.
   */
  secret: string;
  secretHint: string;
}

/**
 * How long the previous secret keeps signing after a rotation.
 *
 * 24 hours. Long enough for a receiver on a normal deployment cadence to pick up the new one,
 * short enough that a secret being rotated because it leaked is not still live next week. A
 * caller can shorten it; a compromised secret should be revoked outright rather than rotated.
 */
export const DEFAULT_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Consecutive failures before an endpoint is disabled automatically.
 *
 * With the webhook retry preset, 20 consecutive failed deliveries is roughly a day of an endpoint
 * being unreachable. Past that it is not a blip, and continuing costs the sender capacity and the
 * receiver a log full of requests they cannot serve.
 */
export const AUTO_DISABLE_THRESHOLD = 20;

export class WebhookService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: WebhookServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Registers an endpoint and returns its secret.
   *
   * The secret is generated here rather than accepted from the caller. A caller-supplied secret is
   * one that has already been in a request body, a client log and possibly a browser's network
   * tab before it was ever used.
   */
  async createEndpoint(input: CreateEndpointInput): Promise<EndpointWithSecret> {
    const url = this.assertValidUrl(input.url);

    if (input.events.length === 0) {
      throw ApiError.validation(
        [
          {
            path: 'events',
            message: 'An endpoint subscribed to no events would never receive anything.',
          },
        ],
        'This endpoint has no event subscriptions.',
      );
    }

    this.assertKnownEvents(input.events);

    const now = this.now();
    const endpoint = await this.options.endpoints.create({
      id: this.newId('whep'),
      organizationId: input.organizationId,
      url,
      description: input.description ?? null,
      status: 'active',
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      disabledAt: null,
      disabledReason: null,
      createdById: input.actorId,
    });

    const secret = generateWebhookSecret();
    await this.options.secrets.create({
      id: this.newId('whsk'),
      endpointId: endpoint.id,
      organizationId: input.organizationId,
      secret: await this.options.cipher.encrypt(secret),
      hint: secretHint(secret),
      expiresAt: null,
      revokedAt: null,
    });

    const subscriptions: WebhookSubscription[] = [];
    for (const pattern of input.events) {
      subscriptions.push(
        await this.options.subscriptions.create({
          id: this.newId('whsb'),
          endpointId: endpoint.id,
          organizationId: input.organizationId,
          eventPattern: pattern,
          createdById: input.actorId,
        }),
      );
    }

    await this.options.audit?.record({
      action: 'webhook.endpoint.created',
      entityType: 'WebhookEndpoint',
      entityId: endpoint.id,
      actorId: input.actorId,
      organizationId: input.organizationId,
      // The URL and the patterns, never the secret. An audit trail is read by more people than a
      // secret store is, and a secret in it is a secret everywhere.
      after: { url, events: input.events },
    });

    void now;
    return { endpoint, subscriptions, secret, secretHint: secretHint(secret) };
  }

  async getEndpoint(id: string, organizationId: string | null): Promise<WebhookEndpoint> {
    const endpoint = await this.options.endpoints.findById(id, organizationId);
    if (!endpoint) throw ApiError.notFound(`No webhook endpoint with id "${id}".`);
    return endpoint;
  }

  async listEndpoints(filter: {
    organizationId: string | null;
    status?: WebhookEndpoint['status'];
    limit?: number;
    offset?: number;
  }): Promise<{ items: WebhookEndpoint[]; total: number }> {
    return this.options.endpoints.list(filter);
  }

  async updateEndpoint(
    id: string,
    organizationId: string | null,
    patch: { url?: string; description?: string | null },
    actorId: string | null,
  ): Promise<WebhookEndpoint> {
    const before = await this.getEndpoint(id, organizationId);
    const url = patch.url === undefined ? undefined : this.assertValidUrl(patch.url);

    const updated = await this.options.endpoints.update(id, organizationId, {
      ...(url === undefined ? {} : { url }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
    });

    if (!updated) throw ApiError.notFound(`No webhook endpoint with id "${id}".`);

    await this.options.audit?.record({
      action: 'webhook.endpoint.updated',
      entityType: 'WebhookEndpoint',
      entityId: id,
      actorId,
      organizationId,
      before: { url: before.url, description: before.description },
      after: { url: updated.url, description: updated.description },
    });

    return updated;
  }

  /**
   * Pauses or resumes an endpoint.
   *
   * Pausing stops new deliveries being queued. It does not cancel deliveries already pending —
   * those are events that were accepted for delivery, and silently dropping them would be a
   * different promise from the one "paused" makes.
   */
  async setStatus(
    id: string,
    organizationId: string | null,
    status: 'active' | 'paused',
    actorId: string | null,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.getEndpoint(id, organizationId);

    if (endpoint.status === 'disabled' && status === 'active') {
      /*
       * Re-enabling clears the failure counter.
       *
       * Without that, the endpoint is one failure away from being disabled again, and an operator
       * who has just fixed the receiver would watch it disable itself immediately with no
       * indication why.
       */
      const reactivated = await this.options.endpoints.update(id, organizationId, {
        status: 'active',
        consecutiveFailures: 0,
        disabledAt: null,
        disabledReason: null,
      });

      await this.options.audit?.record({
        action: 'webhook.endpoint.reactivated',
        entityType: 'WebhookEndpoint',
        entityId: id,
        actorId,
        organizationId,
        before: { status: endpoint.status, disabledReason: endpoint.disabledReason },
        after: { status: 'active' },
      });

      return reactivated!;
    }

    const updated = await this.options.endpoints.update(id, organizationId, { status });
    if (!updated) throw ApiError.notFound(`No webhook endpoint with id "${id}".`);

    await this.options.audit?.record({
      action: status === 'paused' ? 'webhook.endpoint.paused' : 'webhook.endpoint.resumed',
      entityType: 'WebhookEndpoint',
      entityId: id,
      actorId,
      organizationId,
      before: { status: endpoint.status },
      after: { status },
    });

    return updated;
  }

  async deleteEndpoint(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<void> {
    await this.getEndpoint(id, organizationId);
    await this.options.endpoints.delete(id, organizationId);

    await this.options.audit?.record({
      action: 'webhook.endpoint.deleted',
      entityType: 'WebhookEndpoint',
      entityId: id,
      actorId,
      organizationId,
    });
  }

  /**
   * Rotates the signing secret.
   *
   * A new secret is created and the old one is given an expiry. Both sign every delivery until it
   * passes, which is the whole point: a receiver has a real window to update rather than a moment.
   *
   * The returned secret is shown once. Same rule as creation, same reason.
   */
  async rotateSecret(
    endpointId: string,
    organizationId: string | null,
    options: { actorId: string | null; graceMs?: number },
  ): Promise<{ secret: string; hint: string; previousExpiresAt: Date }> {
    await this.getEndpoint(endpointId, organizationId);

    const graceMs = options.graceMs ?? DEFAULT_ROTATION_GRACE_MS;
    const expiresAt = new Date(this.now().getTime() + graceMs);

    const active = await this.options.secrets.findActive(endpointId, organizationId);

    if (active.length > 1) {
      // A second rotation while one is still in flight would leave three secrets valid, and a
      // receiver with no way to know which is current. Rotation is rare; sequencing it is fine.
      throw ApiError.conflict(
        'A rotation is already in progress for this endpoint. Wait for the previous secret to ' +
          'expire, or revoke it explicitly if it was compromised.',
        { reason: 'rotation_in_progress', endpointId },
      );
    }

    const secret = generateWebhookSecret();
    await this.options.secrets.create({
      id: this.newId('whsk'),
      endpointId,
      organizationId,
      secret: await this.options.cipher.encrypt(secret),
      hint: secretHint(secret),
      expiresAt: null,
      revokedAt: null,
    });

    for (const previous of active) {
      await this.options.secrets.expire(previous.id, organizationId, expiresAt);
    }

    await this.options.audit?.record({
      action: 'webhook.secret.rotated',
      entityType: 'WebhookEndpoint',
      entityId: endpointId,
      actorId: options.actorId,
      organizationId,
      // Hints only. The whole point of rotation is that the values do not end up in a log.
      after: {
        newSecretHint: secretHint(secret),
        previousSecretHints: active.map((entry) => entry.hint),
        previousExpiresAt: expiresAt.toISOString(),
      },
    });

    this.options.logger?.info(
      { endpointId, organizationId, expiresAt: expiresAt.toISOString() },
      'webhook signing secret rotated',
    );

    return { secret, hint: secretHint(secret), previousExpiresAt: expiresAt };
  }

  /**
   * Revokes a secret immediately, with no grace period.
   *
   * For a secret that has leaked. Deliveries signed with it stop at once, which will break a
   * receiver still using it — and that is correct: a leaked secret lets anybody forge deliveries
   * to that endpoint, and a broken integration is recoverable in a way that is not.
   */
  async revokeSecret(
    secretId: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<void> {
    const secret = await this.options.secrets.findById(secretId, organizationId);
    if (!secret) throw ApiError.notFound(`No webhook secret with id "${secretId}".`);

    const active = await this.options.secrets.findActive(secret.endpointId, organizationId);

    if (active.length <= 1 && active.some((entry) => entry.id === secretId)) {
      throw ApiError.conflict(
        'This is the only active secret for the endpoint. Rotate first — revoking it would ' +
          'leave nothing to sign with, and every delivery would fail.',
        { reason: 'last_active_secret', endpointId: secret.endpointId },
      );
    }

    await this.options.secrets.revoke(secretId, organizationId);

    await this.options.audit?.record({
      action: 'webhook.secret.revoked',
      entityType: 'WebhookEndpoint',
      entityId: secret.endpointId,
      actorId,
      organizationId,
      after: { secretHint: secret.hint },
    });
  }

  /** The signing secrets for an endpoint, decrypted. Used by the runtime, never by a controller. */
  async signingSecrets(endpointId: string, organizationId: string | null): Promise<string[]> {
    const active = await this.options.secrets.findActive(endpointId, organizationId);

    return Promise.all(active.map((entry) => this.options.cipher.decrypt(entry.secret)));
  }

  /** Secret metadata for the admin UI. Hints and dates, never values. */
  async listSecrets(
    endpointId: string,
    organizationId: string | null,
  ): Promise<Array<Omit<WebhookSecret, 'secret'>>> {
    const active = await this.options.secrets.findActive(endpointId, organizationId);

    return active.map(({ secret, ...rest }) => {
      void secret;
      return rest;
    });
  }

  async addSubscription(
    endpointId: string,
    organizationId: string | null,
    eventPattern: string,
    actorId: string | null,
  ): Promise<WebhookSubscription> {
    await this.getEndpoint(endpointId, organizationId);
    this.assertKnownEvents([eventPattern]);

    const existing = await this.options.subscriptions.listByEndpoint(endpointId, organizationId);

    if (existing.some((entry) => entry.eventPattern === eventPattern)) {
      throw ApiError.conflict(
        `This endpoint is already subscribed to "${eventPattern}". A duplicate subscription ` +
          'would send the event twice.',
        { reason: 'duplicate_subscription', endpointId, eventPattern },
      );
    }

    const subscription = await this.options.subscriptions.create({
      id: this.newId('whsb'),
      endpointId,
      organizationId,
      eventPattern,
      createdById: actorId,
    });

    await this.options.audit?.record({
      action: 'webhook.subscription.added',
      entityType: 'WebhookEndpoint',
      entityId: endpointId,
      actorId,
      organizationId,
      after: { eventPattern },
    });

    return subscription;
  }

  async removeSubscription(
    subscriptionId: string,
    endpointId: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<void> {
    const existing = await this.options.subscriptions.listByEndpoint(endpointId, organizationId);
    const target = existing.find((entry) => entry.id === subscriptionId);

    if (!target) throw ApiError.notFound(`No subscription with id "${subscriptionId}".`);

    await this.options.subscriptions.delete(subscriptionId, organizationId);

    await this.options.audit?.record({
      action: 'webhook.subscription.removed',
      entityType: 'WebhookEndpoint',
      entityId: endpointId,
      actorId,
      organizationId,
      before: { eventPattern: target.eventPattern },
    });
  }

  async listSubscriptions(
    endpointId: string,
    organizationId: string | null,
  ): Promise<WebhookSubscription[]> {
    await this.getEndpoint(endpointId, organizationId);
    return this.options.subscriptions.listByEndpoint(endpointId, organizationId);
  }

  /**
   * Records the outcome of a delivery against the endpoint's health.
   *
   * Called by the runtime. The counter is what drives automatic disabling, and a success resets
   * it — an endpoint that fails ten times, succeeds, then fails ten more is having a bad week
   * rather than being gone.
   */
  async recordOutcome(
    endpointId: string,
    organizationId: string | null,
    outcome: { succeeded: boolean; reason?: string; disableImmediately?: boolean },
  ): Promise<void> {
    const endpoint = await this.options.endpoints.findById(endpointId, organizationId);
    if (!endpoint) return;

    const now = this.now();

    if (outcome.succeeded) {
      await this.options.endpoints.update(endpointId, organizationId, {
        consecutiveFailures: 0,
        lastSuccessAt: now,
        lastFailureReason: null,
      });
      return;
    }

    const consecutiveFailures = endpoint.consecutiveFailures + 1;
    // `disableImmediately` is the 410 Gone case: the receiver has said stop, and continuing to
    // count towards a threshold would ignore an explicit instruction.
    const shouldDisable =
      outcome.disableImmediately === true || consecutiveFailures >= AUTO_DISABLE_THRESHOLD;

    await this.options.endpoints.update(endpointId, organizationId, {
      consecutiveFailures,
      lastFailureAt: now,
      lastFailureReason: outcome.reason?.slice(0, 1000) ?? null,
      ...(shouldDisable
        ? {
            status: 'disabled' as const,
            disabledAt: now,
            disabledReason:
              outcome.disableImmediately === true
                ? 'The receiver returned 410 Gone, which means stop sending.'
                : `${consecutiveFailures} consecutive failures. Last: ${outcome.reason ?? 'unknown'}`,
          }
        : {}),
    });

    if (shouldDisable) {
      this.options.logger?.warn(
        { endpointId, organizationId, consecutiveFailures, reason: outcome.reason },
        'webhook endpoint disabled automatically',
      );

      await this.options.audit?.record({
        action: 'webhook.endpoint.auto_disabled',
        entityType: 'WebhookEndpoint',
        entityId: endpointId,
        actorId: null,
        organizationId,
        after: { consecutiveFailures, reason: outcome.reason },
      });
    }
  }

  private assertValidUrl(url: string): string {
    const parsed = webhookUrlSchema.safeParse(url);

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({ path: 'url', message: issue.message })),
        'This webhook URL is not usable.',
      );
    }

    return parsed.data;
  }

  /**
   * Refuses a subscription to an event nobody publishes.
   *
   * A typo here produces silence — an integrator waiting for `user.create` that will never
   * arrive, and a support conversation that starts with "webhooks are broken". A wildcard is
   * exempt because it is deliberately open-ended.
   */
  private assertKnownEvents(patterns: string[]): void {
    for (const pattern of patterns) assertValidPattern(pattern);

    const unknown = patterns.filter(
      (pattern) => !pattern.includes('*') && !this.options.registry.has(pattern),
    );

    if (unknown.length > 0) {
      throw ApiError.validation(
        unknown.map((pattern) => ({
          path: 'events',
          message:
            `Nothing publishes "${pattern}". A subscription to an event that does not exist ` +
            'never fires, and the symptom is silence rather than an error.',
        })),
        'This subscription refers to events that do not exist.',
      );
    }
  }
}

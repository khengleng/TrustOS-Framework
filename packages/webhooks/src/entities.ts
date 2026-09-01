import { z } from 'zod';

/**
 * Webhook endpoints, subscriptions and deliveries.
 *
 * The shape is three things rather than one, and the split is load-bearing:
 *
 *   * An **endpoint** is a URL somebody owns, with secrets and health.
 *   * A **subscription** is which events that endpoint wants. Separate, so one endpoint can
 *     subscribe to several patterns, and so changing what an endpoint receives does not touch its
 *     secrets.
 *   * A **delivery** is one attempt to send one event to one endpoint. The audit trail, and the
 *     thing an integrator asks about when they say "we never got it".
 */

export const WEBHOOK_ENDPOINT_STATUSES = ['active', 'paused', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'in_flight',
  'succeeded',
  'failed',
  /** Retries exhausted. Terminal, and the one to alert on. */
  'exhausted',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * The endpoint URL.
 *
 * HTTPS only outside development. A webhook body carries business data and the signature header
 * carries proof of origin; over HTTP both are readable and the second is replayable by anybody on
 * the path.
 *
 * Everything else about a URL — where it actually resolves to — is checked at delivery time, not
 * here. See `assertSafeDestination` in `webhook-runtime`: DNS can change between validation and
 * delivery, so a check performed once at registration proves nothing about where the request
 * eventually goes.
 */
export const webhookUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((value) => value.startsWith('https://') || value.startsWith('http://localhost'), {
    message:
      'A webhook URL must use HTTPS. Over HTTP the payload is readable and the signature is ' +
      'replayable by anybody on the network path. (http://localhost is allowed for development.)',
  });

export const webhookEndpointSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  url: webhookUrlSchema,
  /** What this endpoint is for, in the integrator's words. Shown in the admin list. */
  description: z.string().max(500).nullable(),
  status: z.enum(WEBHOOK_ENDPOINT_STATUSES),

  /**
   * Consecutive failures.
   *
   * Reset by any success. Drives automatic disabling: an endpoint that has been returning 500 for
   * two days is not coming back on its own, and continuing to hammer it wastes the sender's
   * capacity and the receiver's.
   */
  consecutiveFailures: z.number().int().min(0),
  lastSuccessAt: z.date().nullable(),
  lastFailureAt: z.date().nullable(),
  lastFailureReason: z.string().max(1000).nullable(),

  /** Set when the framework disabled it, so the admin UI can explain why. */
  disabledAt: z.date().nullable(),
  disabledReason: z.string().max(500).nullable(),

  createdAt: z.date(),
  updatedAt: z.date(),
  createdById: z.string().nullable(),
});

export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

/**
 * A signing secret.
 *
 * A row rather than a column on the endpoint, because rotation needs two live at once. The value
 * is stored hashed the way a password would be — see `secrets.ts` for why that is not quite
 * possible here, and what is done instead.
 */
export const webhookSecretSchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  organizationId: z.string().nullable(),
  /** Encrypted at rest. Never returned by any read path except the one-time reveal at creation. */
  secret: z.string(),
  /** Last 4 characters, for identifying which secret a receiver is using without revealing it. */
  hint: z.string().max(8),
  createdAt: z.date(),
  /**
   * When this secret stops being used for signing.
   *
   * Set at the start of a rotation. Until it passes, both secrets sign every delivery, giving a
   * receiver a window to update. A rotation with no overlap is one that breaks every receiver at
   * the same moment.
   */
  expiresAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
});

export type WebhookSecret = z.infer<typeof webhookSecretSchema>;

export const webhookSubscriptionSchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  organizationId: z.string().nullable(),
  /** An event name pattern — see `matchesPattern` in `@trustsystem/event-sdk`. */
  eventPattern: z.string().max(200),
  createdAt: z.date(),
  createdById: z.string().nullable(),
});

export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>;

export const webhookDeliverySchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  organizationId: z.string().nullable(),

  eventId: z.string(),
  eventName: z.string(),
  eventVersion: z.string(),

  status: z.enum(WEBHOOK_DELIVERY_STATUSES),
  attempts: z.number().int().min(0),

  /**
   * When the next attempt is due.
   *
   * Null once terminal. This is what the delivery worker polls, so it is indexed with status —
   * a table scan per tick would be the first thing to fall over under load.
   */
  nextAttemptAt: z.date().nullable(),

  /** Null until a response arrives. A network failure has none, which is why it is nullable. */
  responseStatus: z.number().int().nullable(),
  /** Truncated. A receiver returning a 4 MB HTML error page should not be able to fill the table. */
  responseBody: z.string().max(4000).nullable(),
  responseTimeMs: z.number().int().min(0).nullable(),
  error: z.string().max(2000).nullable(),

  /** The signed body, kept so a redelivery is byte-identical and its signature still verifies. */
  payload: z.string(),
  signedAt: z.date(),

  createdAt: z.date(),
  completedAt: z.date().nullable(),
});

export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

/**
 * One attempt within a delivery.
 *
 * Separate from the delivery so the history shows *each* try — "we tried at 10:00 and got a 502,
 * at 10:01 and got a 502, at 10:04 and it timed out" is the answer to an integrator's question,
 * and a single row holding only the last attempt is not.
 */
export const webhookAttemptSchema = z.object({
  id: z.string(),
  deliveryId: z.string(),
  organizationId: z.string().nullable(),
  attempt: z.number().int().min(1),
  startedAt: z.date(),
  durationMs: z.number().int().min(0),
  responseStatus: z.number().int().nullable(),
  error: z.string().max(2000).nullable(),
  outcome: z.enum(['succeeded', 'failed']),
});

export type WebhookAttempt = z.infer<typeof webhookAttemptSchema>;

/**
 * Which HTTP responses count as success.
 *
 * Any 2xx. Specifically **not** 3xx: a redirect from a webhook receiver is either a
 * misconfiguration or an attempt to bounce the signed request somewhere else, and following it
 * would deliver an authenticated payload to a destination the endpoint owner never registered.
 * The runtime disables redirect following for the same reason.
 */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Whether a response status is worth retrying.
 *
 * A 4xx means the receiver understood and refused — retrying an endpoint that returns 404 or 401
 * for two days just fills their logs. The exceptions are the three that mean "not now": 408, 425
 * and 429.
 *
 * A 410 Gone is treated specially by the runtime: it is the receiver saying "stop", and the
 * endpoint is disabled rather than retried.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return status >= 500;
}

/** A receiver explicitly asking to be forgotten. */
export function isGoneStatus(status: number): boolean {
  return status === 410;
}

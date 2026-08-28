import { z } from 'zod';
import { CHANNEL_IDS } from './channels';

/**
 * Notification configuration.
 *
 * The interesting field is `enabledChannels`: it is per-organization, resolved
 * through the SDK's tenant settings, so one customer enabling Telegram does not
 * turn it on for anyone else. Only email is on by default — a channel that
 * delivers somewhere a customer has not configured is worse than one that
 * refuses.
 */
export const notificationConfigSchema = z
  .object({
    /** Sender identity used when an organization has not set its own. */
    defaultSender: z.string().trim().min(1).max(160).default('no-reply@trustos.local'),

    enabledChannels: z.array(z.enum(CHANNEL_IDS)).default(['email']),

    /**
     * Attempts before a message is dead-lettered.
     *
     * A ceiling rather than "retry forever": a permanently broken endpoint
     * retried without limit is a queue that never drains and a bill that never
     * stops.
     */
    maxAttempts: z.number().int().min(1).max(10).default(3),

    /** Timeout applied to a webhook attempt, in milliseconds. */
    webhookTimeoutMs: z.number().int().min(100).max(60_000).default(5_000),

    /** Deliveries drained per `processQueue` call. */
    batchSize: z.number().int().min(1).max(500).default(25),
  })
  .strict();

export type NotificationConfig = z.infer<typeof notificationConfigSchema>;

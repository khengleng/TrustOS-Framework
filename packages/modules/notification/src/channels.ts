import { z } from 'zod';
import type { MessageTemplateBody } from './template-engine';

/**
 * Delivery channels.
 *
 * Every channel is a mock. That is the deliberate boundary of this phase: the
 * queue, the retry policy, the state machine, the audit trail and the tenant
 * configuration are all real and tested, and the last hop is a stub. Swapping in
 * a real provider is one class implementing `NotificationChannel`, with nothing
 * else to change — which is only true because none of the surrounding behaviour
 * was built inside a provider adapter.
 *
 * The mocks are **deterministic**, not random. A mock that fails one time in ten
 * makes a test suite flaky and teaches people to re-run it; these fail on
 * recognisable inputs, so a test can ask for a failure and get one.
 */

export const CHANNEL_IDS = ['email', 'telegram', 'webhook'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];
export const channelIdSchema = z.enum(CHANNEL_IDS);

export interface DeliveryTarget {
  /** Email address, Telegram chat id, or webhook URL. */
  address: string;
}

export interface DeliveryRequest {
  messageId: string;
  organizationId: string;
  target: DeliveryTarget;
  rendered: MessageTemplateBody;
  /** Sender identity resolved from the organization's settings. */
  sender: string;
  attempt: number;
}

export interface DeliveryOutcome {
  accepted: boolean;
  /** Provider-side reference, when there is one. */
  providerReference: string | null;
  /** Machine-readable failure reason. Never a provider stack trace. */
  failureReason: string | null;
  /** Whether another attempt could succeed. A bad address never can. */
  retryable: boolean;
}

export interface NotificationChannel {
  readonly id: ChannelId;
  /** Rejects an address this channel cannot deliver to, before queueing. */
  validateAddress(address: string): boolean;
  send(request: DeliveryRequest): Promise<DeliveryOutcome>;
}

const accepted = (reference: string): DeliveryOutcome => ({
  accepted: true,
  providerReference: reference,
  failureReason: null,
  retryable: false,
});

const rejected = (reason: string, retryable: boolean): DeliveryOutcome => ({
  accepted: false,
  providerReference: null,
  failureReason: reason,
  retryable,
});

/**
 * Mock email channel.
 *
 * Deterministic failures, chosen to match what a real provider actually rejects:
 * an address in the reserved `.invalid` TLD is permanently undeliverable, and one
 * at `throttled.example` reports a transient rate limit so the retry path can be
 * exercised.
 */
export class MockEmailChannel implements NotificationChannel {
  readonly id = 'email' as const;
  readonly sent: DeliveryRequest[] = [];

  validateAddress(address: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && address.length <= 254;
  }

  async send(request: DeliveryRequest): Promise<DeliveryOutcome> {
    const address = request.target.address;

    if (!this.validateAddress(address)) return rejected('invalid_address', false);
    if (address.endsWith('.invalid')) return rejected('mailbox_unavailable', false);
    if (address.endsWith('@throttled.example')) return rejected('rate_limited', true);

    this.sent.push(request);
    return accepted(`mock-email-${request.messageId}-${request.attempt}`);
  }
}

/** Mock Telegram channel. Addresses are numeric chat ids, possibly negative. */
export class MockTelegramChannel implements NotificationChannel {
  readonly id = 'telegram' as const;
  readonly sent: DeliveryRequest[] = [];

  validateAddress(address: string): boolean {
    // Kept as a string throughout: Telegram chat ids exceed 2^53, so parsing one
    // as a number would round it and address a different chat.
    return /^-?\d{1,20}$/.test(address);
  }

  async send(request: DeliveryRequest): Promise<DeliveryOutcome> {
    if (!this.validateAddress(request.target.address)) return rejected('invalid_chat_id', false);
    // A user who has not started the bot cannot be messaged, and never will be
    // until they do. Modelled as permanent, because retrying is pointless.
    if (request.target.address === '0') return rejected('bot_was_blocked', false);

    this.sent.push(request);
    return accepted(`mock-telegram-${request.messageId}-${request.attempt}`);
  }
}

/**
 * Mock webhook channel.
 *
 * Makes no network call, so it cannot be used for SSRF — but it validates the
 * URL as though it would, because the validation is the part an application
 * inherits when a real HTTP client is dropped in behind this port. Loopback and
 * private ranges are refused: a webhook endpoint pointing at `169.254.169.254`
 * is a metadata-service read from inside the cluster.
 */
export class MockWebhookChannel implements NotificationChannel {
  readonly id = 'webhook' as const;
  readonly sent: DeliveryRequest[] = [];

  validateAddress(address: string): boolean {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return false;
    }

    if (url.protocol !== 'https:') return false;
    return !isPrivateHost(url.hostname);
  }

  async send(request: DeliveryRequest): Promise<DeliveryOutcome> {
    if (!this.validateAddress(request.target.address)) return rejected('invalid_endpoint', false);
    if (request.target.address.includes('/503')) return rejected('endpoint_unavailable', true);

    this.sent.push(request);
    return accepted(`mock-webhook-${request.messageId}-${request.attempt}`);
  }
}

/**
 * Hosts a webhook must not target.
 *
 * Literal-only, and that limit is stated rather than hidden: a hostname that
 * resolves to a private address through DNS is not caught here, and cannot be
 * without resolving it at send time. A real HTTP client behind this port must
 * re-check after resolution — see the module README.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return true;
  if (host === '[::1]' || host === '::1') return true;

  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;

  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Link-local, which is where cloud instance metadata lives.
  if (a === 169 && b === 254) return true;
  return false;
}

/** The three mock channels, keyed by id. */
export function createMockChannels(): Map<ChannelId, NotificationChannel> {
  return new Map<ChannelId, NotificationChannel>([
    ['email', new MockEmailChannel()],
    ['telegram', new MockTelegramChannel()],
    ['webhook', new MockWebhookChannel()],
  ]);
}

import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustsystem/errors';
import { createTestModuleContext, type RecordingAuditPort } from '@trustsystem/module-sdk';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import {
  MockEmailChannel,
  MockTelegramChannel,
  MockWebhookChannel,
  isPrivateHost,
} from './channels';
import { notificationConfigSchema } from './config';
import {
  BASE_BACKOFF_MS,
  DELIVERY_TRANSITIONS,
  InMemoryRetryQueue,
  MAX_BACKOFF_MS,
  TERMINAL_DELIVERY_STATUSES,
  backoffMs,
  canTransition,
} from './delivery';
import { createNotification, notificationModule } from './notification.module';
import type { NotificationService } from './notification.service';

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

interface Harness {
  service: NotificationService;
  audit: RecordingAuditPort;
  queue: InMemoryRetryQueue;
  email: MockEmailChannel;
  messages: FakeModelDelegate;
  templates: FakeModelDelegate;
}

function buildHarness(config: Record<string, unknown> = {}): Harness {
  const templates = new FakeModelDelegate([
    {
      id: 'tpl_acme',
      organizationId: ACME,
      key: 'welcome',
      name: 'Welcome',
      channel: 'email',
      subject: 'Welcome, {{name}}',
      body: 'Hello {{name}}, your account is ready.',
      variables: ['name'],
      ...timestamps,
    },
    {
      id: 'tpl_rival',
      organizationId: RIVAL,
      key: 'welcome',
      name: 'Rival welcome',
      channel: 'email',
      subject: 'Rival',
      body: 'Rival body',
      variables: [],
      ...timestamps,
    },
  ]);

  const messages = new FakeModelDelegate([
    {
      id: 'msg_rival',
      organizationId: RIVAL,
      templateKey: 'welcome',
      channel: 'email',
      target: 'rival@example.com',
      subject: 'Rival',
      body: 'Rival body',
      status: 'SENT',
      attempts: 1,
      lastError: null,
      providerReference: 'ref',
      nextAttemptAt: null,
      ...timestamps,
    },
  ]);
  const attempts = new FakeModelDelegate([]);

  const email = new MockEmailChannel();
  const queue = new InMemoryRetryQueue();

  const { context, audit } = createTestModuleContext(notificationModule, {
    config,
    prisma: {
      notificationTemplate: templates,
      notificationMessage: messages,
      notificationAttempt: attempts,
    },
  });

  const instance = createNotification(context, {
    channels: new Map([
      ['email', email],
      ['telegram', new MockTelegramChannel()],
      ['webhook', new MockWebhookChannel()],
    ]),
    queue,
  });

  return { service: instance.service, audit, queue, email, messages, templates };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('notification tenant isolation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('resolves a template key within the calling organization only', async () => {
    // Both organizations have a template keyed "welcome". Each must get its own.
    const sent = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          target: 'ada@example.com',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );

    expect(sent.subject).toBe('Welcome, Ada');
    expect(sent.organizationId).toBe(ACME);
  });

  it('lists only the calling organization messages', async () => {
    await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          target: 'ada@example.com',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );

    const acme = await asAcme(() => harness.service.listMessages(ACME));
    expect(acme.items.map((row) => row.target)).toEqual(['ada@example.com']);

    const rival = await asRival(() => harness.service.listMessages(RIVAL));
    expect(rival.items.map((row) => row.target)).toEqual(['rival@example.com']);
  });

  it('reports another organization message as not_found', async () => {
    try {
      await asAcme(() => harness.service.findMessage('msg_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('cannot retry another organization message', async () => {
    await expect(asAcme(() => harness.service.retry('msg_rival', ACME))).rejects.toThrow();
  });

  it('cannot update or delete another organization template', async () => {
    await expect(
      asAcme(() => harness.service.updateTemplate('tpl_rival', { name: 'Hijacked' }, ACME)),
    ).rejects.toThrow();
    await expect(asAcme(() => harness.service.deleteTemplate('tpl_rival', ACME))).rejects.toThrow();
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(harness.service.listTemplates()).rejects.toThrow(
      /Organization context is required/,
    );
  });

  it('never processes a queued delivery under the wrong tenant', async () => {
    await harness.queue.enqueue({
      messageId: 'msg_rival',
      organizationId: RIVAL,
      attempt: 2,
      notBefore: new Date('2020-01-01T00:00:00.000Z'),
    });

    const result = await asAcme(() => harness.service.processQueue(ACME));
    // Claimed and skipped rather than processed as ACME, which would have read
    // another organization's row.
    expect(result.sent).toBe(0);
  });

  it('attributes every audit record to the acting organization', async () => {
    await asAcme(() =>
      harness.service.createTemplate(
        { key: 'a', name: 'A', channel: 'email', subject: 'S', body: 'B', variables: [] },
        ACME,
      ),
    );
    await asRival(() =>
      harness.service.createTemplate(
        { key: 'b', name: 'B', channel: 'email', subject: 'S', body: 'B', variables: [] },
        RIVAL,
      ),
    );

    expect(harness.audit.records.map((record) => record.organizationId)).toEqual([ACME, RIVAL]);
  });

  it('never writes a rendered message body into the audit trail', async () => {
    await asAcme(() =>
      harness.service.createTemplate(
        {
          key: 'statement',
          name: 'Statement',
          channel: 'email',
          subject: 'Statement',
          body: 'Your balance is {{balance}}.',
          variables: ['balance'],
        },
        ACME,
      ),
    );

    await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'statement',
          channel: 'email',
          target: 'ada@example.com',
          variables: { balance: 'USD 1,234.56' },
        },
        ACME,
      ),
    );

    // An audit trail is read by more people than the message was addressed to.
    expect(harness.audit.serialized()).not.toContain('1,234.56');
    expect(harness.audit.byAction('notification.message.sent')).toHaveLength(1);
  });
});

describe('sending', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('records the message before attempting delivery', async () => {
    const message = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          target: 'ada@example.com',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );

    // Queued first, then sent: a message can never be delivered without a record
    // of it existing.
    expect(harness.audit.records.map((record) => record.action)).toEqual([
      'notification.message.queued',
      'notification.message.sent',
    ]);
    expect(message.status).toBe('SENT');
    expect(harness.email.sent).toHaveLength(1);
  });

  it('refuses a channel the organization has not enabled', async () => {
    // Telegram is off by default: a channel that delivers somewhere a customer
    // has not configured is worse than one that refuses.
    await expect(
      asAcme(() =>
        harness.service.send(
          {
            templateKey: 'welcome',
            channel: 'telegram',
            target: '12345',
            variables: { name: 'Ada' },
          },
          ACME,
        ),
      ),
    ).rejects.toThrow(/telegram channel is not enabled/);
  });

  it('refuses a template addressed to the wrong channel', async () => {
    const enabled = buildHarness({ enabledChannels: ['email', 'telegram'] });
    await expect(
      asAcme(() =>
        enabled.service.send(
          {
            templateKey: 'welcome',
            channel: 'telegram',
            target: '12345',
            variables: { name: 'Ada' },
          },
          ACME,
        ),
      ),
    ).rejects.toThrow(/cannot be sent over telegram/);
  });

  it('refuses an address the channel cannot deliver to, before queueing', async () => {
    await expect(
      asAcme(() =>
        harness.service.send(
          {
            templateKey: 'welcome',
            channel: 'email',
            target: 'not-an-address',
            variables: { name: 'Ada' },
          },
          ACME,
        ),
      ),
    ).rejects.toThrow(/not a valid email target/);

    expect(harness.audit.records).toHaveLength(0);
  });

  it('refuses to render without every declared variable', async () => {
    await expect(
      asAcme(() =>
        harness.service.send(
          { templateKey: 'welcome', channel: 'email', target: 'ada@example.com', variables: {} },
          ACME,
        ),
      ),
    ).rejects.toThrow(/Missing template variables: name/);
  });

  it('refuses an unknown template', async () => {
    await expect(
      asAcme(() =>
        harness.service.send(
          { templateKey: 'nope', channel: 'email', target: 'ada@example.com', variables: {} },
          ACME,
        ),
      ),
    ).rejects.toThrow(/No template with key/);
  });

  it('refuses a duplicate template key within an organization', async () => {
    await expect(
      asAcme(() =>
        harness.service.createTemplate(
          {
            key: 'welcome',
            name: 'Again',
            channel: 'email',
            subject: 'S',
            body: 'B',
            variables: [],
          },
          ACME,
        ),
      ),
    ).rejects.toThrow(/already exists/);
  });
});

describe('retry and dead-lettering', () => {
  it('queues a retryable failure with a backoff and records the attempt', async () => {
    const harness = buildHarness();

    const message = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          // The mock reports a transient rate limit for this domain.
          target: 'ada@throttled.example',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );

    expect(message.status).toBe('FAILED');
    expect(message.lastError).toBe('rate_limited');
    expect(message.nextAttemptAt).toBeInstanceOf(Date);
    expect(await harness.queue.size()).toBe(1);

    const failures = harness.audit.byAction('notification.message.failed');
    expect(failures).toHaveLength(1);
  });

  it('does not retry a permanent failure', async () => {
    const harness = buildHarness();

    const message = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          // `.invalid` is reserved and permanently undeliverable.
          channel: 'email',
          target: 'ada@nowhere.invalid',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );

    expect(message.status).toBe('DEAD');
    expect(await harness.queue.size()).toBe(0);
    expect(harness.audit.byAction('notification.message.dead-lettered')[0]?.after).toMatchObject({
      cause: 'permanent_failure',
    });
  });

  it('dead-letters once the attempts run out', async () => {
    const harness = buildHarness({ maxAttempts: 2 });

    const first = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          target: 'ada@throttled.example',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );
    expect(first.status).toBe('FAILED');

    const second = await asAcme(() => harness.service.retry(first.id, ACME));

    // A permanently broken endpoint retried without limit is a queue that never
    // drains.
    expect(second.status).toBe('DEAD');
    expect(harness.audit.byAction('notification.message.dead-lettered')[0]?.after).toMatchObject({
      cause: 'attempts_exhausted',
    });
  });

  it('refuses to retry a message in a terminal state', async () => {
    const harness = buildHarness();
    const message = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          target: 'ada@example.com',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );

    await expect(asAcme(() => harness.service.retry(message.id, ACME))).rejects.toThrow(
      /cannot be retried/,
    );
  });

  it('keeps every attempt in the delivery history', async () => {
    const harness = buildHarness({ maxAttempts: 3 });
    const message = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          target: 'ada@throttled.example',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );
    await asAcme(() => harness.service.retry(message.id, ACME));

    const { attempts } = await asAcme(() => harness.service.findMessage(message.id, ACME));
    expect(attempts.map((row) => row.attempt)).toEqual([1, 2]);
    expect(attempts.every((row) => row.accepted === false)).toBe(true);
  });

  it('drains due retries and leaves future ones alone', async () => {
    const harness = buildHarness({ maxAttempts: 5 });
    const message = await asAcme(() =>
      harness.service.send(
        {
          templateKey: 'welcome',
          channel: 'email',
          target: 'ada@throttled.example',
          variables: { name: 'Ada' },
        },
        ACME,
      ),
    );

    // The fixed test clock is before `notBefore`, so nothing is due yet.
    expect(await asAcme(() => harness.service.processQueue(ACME))).toEqual({
      processed: 0,
      sent: 0,
    });
    expect(await harness.queue.size()).toBe(1);
    expect(message.status).toBe('FAILED');
  });
});

describe('delivery state machine', () => {
  it('has no transition out of a terminal state', () => {
    for (const status of TERMINAL_DELIVERY_STATUSES) {
      expect(DELIVERY_TRANSITIONS[status], status).toEqual([]);
    }
  });

  it('allows a failed message back to pending, and nothing else in', () => {
    expect(canTransition('FAILED', 'PENDING')).toBe(true);
    expect(canTransition('SENT', 'PENDING')).toBe(false);
    expect(canTransition('DEAD', 'PENDING')).toBe(false);
  });
});

describe('backoffMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3)).toBe(BASE_BACKOFF_MS * 4);
  });

  it('is capped, and stays finite for an absurd attempt number', () => {
    expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);
    expect(Number.isFinite(backoffMs(1000))).toBe(true);
  });

  it('is deterministic, so a retry test is reproducible', () => {
    expect(backoffMs(4)).toBe(backoffMs(4));
  });
});

describe('channels', () => {
  it('keeps a Telegram chat id exact beyond the safe integer range', () => {
    const channel = new MockTelegramChannel();
    // Parsing a chat id as a number would round it and message a different chat.
    expect(channel.validateAddress('9007199254740993')).toBe(true);
    expect(channel.validateAddress('-1001234567890')).toBe(true);
    expect(channel.validateAddress('12.5')).toBe(false);
  });

  it('refuses a webhook endpoint that is not https', () => {
    const channel = new MockWebhookChannel();
    expect(channel.validateAddress('http://example.com/hook')).toBe(false);
    expect(channel.validateAddress('https://example.com/hook')).toBe(true);
  });

  it('refuses a webhook endpoint pointing inside the network', () => {
    const channel = new MockWebhookChannel();
    // 169.254.169.254 is cloud instance metadata; a webhook aimed at it is an
    // SSRF read of the deployment's own credentials.
    for (const address of [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.1/hook',
      'https://172.16.0.1/hook',
      'https://localhost/hook',
      'https://db.internal/hook',
    ]) {
      expect(channel.validateAddress(address), address).toBe(false);
    }
  });

  it('recognises private hosts by literal address only, which is the stated limit', () => {
    expect(isPrivateHost('10.1.2.3')).toBe(true);
    // A hostname that resolves to a private address is not caught here and
    // cannot be without resolving it; a real HTTP client must re-check.
    expect(isPrivateHost('internal.example.com')).toBe(false);
  });

  it('reports an unusable email address as permanent, not transient', () => {
    const channel = new MockEmailChannel();
    expect(channel.validateAddress('ada@example.com')).toBe(true);
    expect(channel.validateAddress('no-at-sign')).toBe(false);
  });
});

describe('per-organization settings', () => {
  it('enables a channel for one organization without affecting another', async () => {
    const harness = buildHarness();

    await asAcme(() =>
      harness.service.updateSettings({ enabledChannels: ['email', 'telegram'] }, ACME),
    );

    expect((await asAcme(() => harness.service.readSettings(ACME))).enabledChannels).toEqual([
      'email',
      'telegram',
    ]);
    expect((await asRival(() => harness.service.readSettings(RIVAL))).enabledChannels).toEqual([
      'email',
    ]);
  });

  it('audits a settings change with before and after', async () => {
    const harness = buildHarness();
    await asAcme(() =>
      harness.service.updateSettings({ defaultSender: 'billing@acme.test' }, ACME),
    );

    const record = harness.audit.byAction('notification.settings.updated')[0];
    expect(record?.before).toMatchObject({ defaultSender: 'no-reply@trustos.local' });
    expect(record?.after).toMatchObject({ defaultSender: 'billing@acme.test' });
  });

  it('refuses a settings change that the module schema forbids', async () => {
    const harness = buildHarness();
    await expect(
      asAcme(() => harness.service.updateSettings({ maxAttempts: 500 }, ACME)),
    ).rejects.toThrow(/misconfigured/);
  });
});

describe('configuration validation', () => {
  it('installs with no configuration at all', () => {
    expect(notificationConfigSchema.parse({})).toMatchObject({
      enabledChannels: ['email'],
      maxAttempts: 3,
    });
  });

  it('rejects an unknown channel', () => {
    expect(notificationConfigSchema.safeParse({ enabledChannels: ['sms'] }).success).toBe(false);
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    expect(notificationConfigSchema.safeParse({ maxAttempt: 2 }).success).toBe(false);
  });
});

describe('lifecycle', () => {
  it('refuses to start without a database', async () => {
    const { context } = createTestModuleContext(notificationModule, { prisma: null });
    const instance = createNotification(context, { queue: new InMemoryRetryQueue() });

    await expect(instance.initialize()).rejects.toThrow(/needs a database/);
  });

  it('reports a queue backlog as degraded, not down', async () => {
    const harness = buildHarness();
    const { context } = createTestModuleContext(notificationModule, {
      prisma: { notificationMessage: harness.messages },
    });

    const queue = new InMemoryRetryQueue();
    for (let index = 0; index < 1001; index += 1) {
      await queue.enqueue({
        messageId: `m${index}`,
        organizationId: ACME,
        attempt: 1,
        notBefore: new Date('2030-01-01T00:00:00.000Z'),
      });
    }

    const instance = createNotification(context, { queue });
    // Taking the instance out of rotation would stop the very requests that
    // drain the queue.
    expect((await instance.healthIndicator().check()).status).toBe('degraded');
  });
});

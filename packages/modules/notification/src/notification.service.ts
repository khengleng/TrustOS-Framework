import { ApiError } from '@trustsystem/errors';
import type { ModuleContext } from '@trustsystem/module-sdk';
import { buildPageMeta, type Paginated } from '@trustsystem/shared-types';
import type { ChannelId, NotificationChannel } from './channels';
import type { NotificationConfig } from './config';
import {
  backoffMs,
  canTransition,
  isTerminal,
  type DeliveryStatus,
  type RetryQueue,
} from './delivery';
import type {
  NotificationAttemptRow,
  NotificationMessageRow,
  NotificationStore,
  NotificationTemplateRow,
} from './store';
import { renderTemplate, validateTemplate } from './template-engine';

/**
 * Notification delivery for one application.
 *
 * The order of operations in `send` is the part worth reading. A message row is
 * written *before* any delivery is attempted, so a message can never be sent
 * without a record of it existing; the alternative — deliver, then record — loses
 * exactly the messages whose delivery crashed the process, which are the ones
 * anyone would want to know about.
 *
 * The actor on every audit record comes from the ambient request context via the
 * framework's `AuditService`, which is why no method here takes an `actorId`.
 */

export interface SendMessageInput {
  templateKey: string;
  channel: ChannelId;
  target: string;
  variables: Record<string, string>;
}

export interface CreateTemplateInput {
  key: string;
  name: string;
  channel: ChannelId;
  subject: string;
  body: string;
  variables: string[];
}

export interface MessageListQuery {
  status?: DeliveryStatus;
  page?: number;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 100;

export class NotificationService {
  constructor(
    private readonly context: ModuleContext<NotificationConfig>,
    private readonly store: NotificationStore,
    private readonly channels: Map<ChannelId, NotificationChannel>,
    private readonly queue: RetryQueue,
  ) {}

  // --- templates ------------------------------------------------------------

  listTemplates(): Promise<NotificationTemplateRow[]> {
    return this.store.listTemplates();
  }

  async createTemplate(
    input: CreateTemplateInput,
    organizationId: string,
  ): Promise<NotificationTemplateRow> {
    // Validated before it is stored, so an unresolvable placeholder is the
    // author's problem now rather than a failed send later.
    validateTemplate({ subject: input.subject, body: input.body }, input.variables);

    if (await this.store.findTemplate(input.key)) {
      throw ApiError.conflict(`A template with key "${input.key}" already exists.`);
    }

    const template = await this.store.createTemplate({ ...input });

    await this.context.audit.record({
      action: 'notification.template.created',
      entityType: 'NotificationTemplate',
      entityId: template.id,
      organizationId,
      after: { key: template.key, channel: template.channel, variables: template.variables },
    });

    return template;
  }

  async updateTemplate(
    id: string,
    input: Partial<Pick<CreateTemplateInput, 'name' | 'subject' | 'body' | 'variables'>>,
    organizationId: string,
  ): Promise<NotificationTemplateRow> {
    const existing = await this.store.requireTemplate(id, organizationId);

    const next = {
      subject: input.subject ?? existing.subject,
      body: input.body ?? existing.body,
    };
    validateTemplate(next, input.variables ?? existing.variables);

    // Snapshot before the write: reading the previous values afterwards would
    // make the audit record depend on the store returning a detached object,
    // which no store guarantees.
    const before = {
      name: existing.name,
      subject: existing.subject,
      body: existing.body,
      variables: existing.variables,
    };

    const updated = await this.store.updateTemplate(id, { ...input, ...next });

    await this.context.audit.record({
      action: 'notification.template.updated',
      entityType: 'NotificationTemplate',
      entityId: id,
      organizationId,
      before,
      after: {
        name: updated.name,
        subject: updated.subject,
        body: updated.body,
        variables: updated.variables,
      },
    });

    return updated;
  }

  async deleteTemplate(id: string, organizationId: string): Promise<NotificationTemplateRow> {
    const existing = await this.store.requireTemplate(id, organizationId);
    const removed = await this.store.deleteTemplate(id, this.context.clock());

    await this.context.audit.record({
      action: 'notification.template.deleted',
      entityType: 'NotificationTemplate',
      entityId: id,
      organizationId,
      before: { key: existing.key, channel: existing.channel },
    });

    return removed;
  }

  // --- sending --------------------------------------------------------------

  /**
   * Renders a template and attempts delivery once.
   *
   * A retryable failure is queued with a backoff; a permanent one is not. The
   * distinction comes from the channel, because only the transport knows whether
   * "we could not deliver this" means "not yet" or "not ever".
   */
  async send(input: SendMessageInput, organizationId: string): Promise<NotificationMessageRow> {
    const config = await this.context.resolveConfig(organizationId);

    if (!config.enabledChannels.includes(input.channel)) {
      throw ApiError.forbidden(
        `The ${input.channel} channel is not enabled for this organization.`,
        {
          reason: 'channel_disabled',
          channel: input.channel,
        },
      );
    }

    const channel = this.channels.get(input.channel);
    if (!channel) {
      throw ApiError.internal(`No adapter is registered for the ${input.channel} channel.`);
    }

    const template = await this.store.findTemplate(input.templateKey);
    if (!template) throw ApiError.notFound(`No template with key "${input.templateKey}".`);

    if (template.channel !== input.channel) {
      throw ApiError.validation(
        [{ path: 'channel', message: `Template "${template.key}" is for ${template.channel}.` }],
        `Template "${template.key}" cannot be sent over ${input.channel}.`,
      );
    }

    if (!channel.validateAddress(input.target)) {
      const message = `"${input.target}" is not a valid ${input.channel} target.`;
      throw ApiError.validation([{ path: 'target', message }], message);
    }

    const rendered = renderTemplate(
      { subject: template.subject, body: template.body },
      template.variables,
      input.variables,
    );

    const message = await this.store.createMessage({
      templateKey: template.key,
      channel: input.channel,
      target: input.target,
      subject: rendered.subject,
      body: rendered.body,
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      providerReference: null,
      nextAttemptAt: null,
    });

    await this.context.audit.record({
      action: 'notification.message.queued',
      entityType: 'NotificationMessage',
      entityId: message.id,
      organizationId,
      // The target and template, never the rendered body: a message body is
      // customer content, and an audit trail is read by more people than the
      // message was addressed to.
      after: { templateKey: template.key, channel: input.channel, target: input.target },
    });

    return this.attempt(message, organizationId, config);
  }

  /** Retries one failed message immediately, ignoring its backoff. */
  async retry(id: string, organizationId: string): Promise<NotificationMessageRow> {
    const config = await this.context.resolveConfig(organizationId);
    const message = await this.store.findMessage(id, organizationId);

    if (isTerminal(message.status)) {
      throw ApiError.conflict(`Message is ${message.status} and cannot be retried.`, {
        reason: 'terminal_delivery_state',
        status: message.status,
      });
    }

    return this.attempt(message, organizationId, config);
  }

  /**
   * Drains due retries.
   *
   * Called by whatever the application uses as a scheduler. The module does not
   * own a timer: a module that started its own interval would keep running in a
   * process that was only meant to serve one request, and would run twice in an
   * application that imported it twice.
   */
  async processQueue(organizationId: string): Promise<{ processed: number; sent: number }> {
    const config = await this.context.resolveConfig(organizationId);
    const due = await this.queue.claimDue(this.context.clock(), config.batchSize);

    let sent = 0;
    for (const item of due) {
      // A queue entry carries the organization it belongs to; anything else is
      // skipped rather than processed under the wrong tenant.
      if (item.organizationId !== organizationId) continue;

      const message = await this.store.findMessage(item.messageId, organizationId);
      const result = await this.attempt(message, organizationId, config);
      if (result.status === 'SENT') sent += 1;
    }

    return { processed: due.length, sent };
  }

  // --- reads ----------------------------------------------------------------

  async listMessages(
    organizationId: string,
    query: MessageListQuery = {},
  ): Promise<Paginated<NotificationMessageRow>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 25)));

    const [items, totalItems] = await Promise.all([
      this.store.listMessages({
        ...(query.status ? { status: query.status } : {}),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.store.countMessages(query.status),
    ]);

    return { items, meta: buildPageMeta({ page, pageSize }, totalItems) };
  }

  async findMessage(
    id: string,
    organizationId: string,
  ): Promise<{ message: NotificationMessageRow; attempts: NotificationAttemptRow[] }> {
    const message = await this.store.findMessage(id, organizationId);
    return { message, attempts: await this.store.listAttempts(message.id) };
  }

  // --- settings -------------------------------------------------------------

  async readSettings(organizationId: string): Promise<NotificationConfig> {
    return this.context.resolveConfig(organizationId);
  }

  /**
   * Changes this organization's channel settings.
   *
   * Written through the SDK's tenant settings store and validated by the module's
   * own schema, so a stored override cannot put the module into a state its schema
   * forbids.
   */
  async updateSettings(
    patch: Partial<NotificationConfig>,
    organizationId: string,
  ): Promise<NotificationConfig> {
    const before = await this.context.resolveConfig(organizationId);

    await this.context.tenantSettings.write(this.context.moduleId, organizationId, {
      ...(await this.currentOverrides(organizationId)),
      ...patch,
    });

    const after = await this.context.resolveConfig(organizationId);

    await this.context.audit.record({
      action: 'notification.settings.updated',
      entityType: 'NotificationSettings',
      entityId: organizationId,
      organizationId,
      before: { enabledChannels: before.enabledChannels, defaultSender: before.defaultSender },
      after: { enabledChannels: after.enabledChannels, defaultSender: after.defaultSender },
    });

    return after;
  }

  // --- internals ------------------------------------------------------------

  private async currentOverrides(organizationId: string): Promise<Record<string, unknown>> {
    return (await this.context.tenantSettings.read(this.context.moduleId, organizationId)) ?? {};
  }

  /**
   * One delivery attempt, with its state transition, attempt record and audit.
   *
   * Transitions go through `canTransition` rather than assignment, so a message
   * that has reached a terminal state cannot be moved out of it by a code path
   * that forgot to check.
   */
  private async attempt(
    message: NotificationMessageRow,
    organizationId: string,
    config: NotificationConfig,
  ): Promise<NotificationMessageRow> {
    const channel = this.channels.get(message.channel);
    if (!channel) throw ApiError.internal(`No adapter for the ${message.channel} channel.`);

    /*
     * A retry in flight is PENDING again.
     *
     * Without this step a second failure would need a FAILED -> FAILED
     * transition, and adding one would mean the state machine could no longer
     * say "a message in FAILED is waiting for a retry" — which is the property
     * the queue drain and every backlog count rely on.
     */
    const inFlight =
      message.status === 'FAILED'
        ? await this.transition(message, 'PENDING', { nextAttemptAt: null })
        : message;

    const attemptNumber = inFlight.attempts + 1;
    const now = this.context.clock();

    const outcome = await channel.send({
      messageId: inFlight.id,
      organizationId,
      target: { address: inFlight.target },
      rendered: { subject: inFlight.subject, body: inFlight.body },
      sender: config.defaultSender,
      attempt: attemptNumber,
    });

    await this.store.addAttempt({
      messageId: inFlight.id,
      attempt: attemptNumber,
      accepted: outcome.accepted,
      failureReason: outcome.failureReason,
      providerReference: outcome.providerReference,
    });

    if (outcome.accepted) {
      const updated = await this.transition(inFlight, 'SENT', {
        attempts: attemptNumber,
        providerReference: outcome.providerReference,
        lastError: null,
        nextAttemptAt: null,
      });

      await this.context.audit.record({
        action: 'notification.message.sent',
        entityType: 'NotificationMessage',
        entityId: inFlight.id,
        organizationId,
        after: { attempt: attemptNumber, providerReference: outcome.providerReference },
      });

      return updated;
    }

    const exhausted = attemptNumber >= config.maxAttempts;
    const willRetry = outcome.retryable && !exhausted;

    if (willRetry) {
      const notBefore = new Date(now.getTime() + backoffMs(attemptNumber));
      await this.queue.enqueue({
        messageId: inFlight.id,
        organizationId,
        attempt: attemptNumber + 1,
        notBefore,
      });

      const updated = await this.transition(inFlight, 'FAILED', {
        attempts: attemptNumber,
        lastError: outcome.failureReason,
        nextAttemptAt: notBefore,
      });

      await this.context.audit.record({
        action: 'notification.message.failed',
        entityType: 'NotificationMessage',
        entityId: inFlight.id,
        organizationId,
        after: {
          attempt: attemptNumber,
          reason: outcome.failureReason,
          nextAttemptAt: notBefore.toISOString(),
        },
      });

      return updated;
    }

    // Two ways to get here: the failure is permanent, or the attempts ran out.
    // Both are DEAD, and the reason distinguishes them in the trail.
    const dead = await this.transitionToDead(inFlight, {
      attempts: attemptNumber,
      lastError: outcome.failureReason,
      nextAttemptAt: null,
    });

    await this.context.audit.record({
      action: 'notification.message.dead-lettered',
      entityType: 'NotificationMessage',
      entityId: inFlight.id,
      organizationId,
      after: {
        attempt: attemptNumber,
        reason: outcome.failureReason,
        cause: exhausted ? 'attempts_exhausted' : 'permanent_failure',
      },
    });

    return dead;
  }

  private async transition(
    message: NotificationMessageRow,
    to: DeliveryStatus,
    patch: Partial<NotificationMessageRow>,
  ): Promise<NotificationMessageRow> {
    if (!canTransition(message.status, to)) {
      throw ApiError.conflict(`A message cannot move from ${message.status} to ${to}.`, {
        reason: 'invalid_delivery_transition',
        from: message.status,
        to,
      });
    }
    return this.store.updateMessage(message.id, { ...patch, status: to });
  }

  /**
   * Moves a message to DEAD.
   *
   * PENDING cannot reach DEAD in one step by design: the machine routes through
   * FAILED, so the history shows the attempt that failed and then the decision to
   * stop, rather than a message that jumped straight to dead with no recorded
   * failure.
   */
  private async transitionToDead(
    message: NotificationMessageRow,
    patch: Partial<NotificationMessageRow>,
  ): Promise<NotificationMessageRow> {
    const failed = await this.transition(message, 'FAILED', patch);
    return this.transition(failed, 'DEAD', patch);
  }
}

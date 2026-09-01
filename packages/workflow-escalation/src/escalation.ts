import { createHash } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';
import type { SecurityEventEmitter } from '@trustsystem/security-events';
import type {
  EscalationActionType,
  EscalationTrigger,
  WorkflowEscalationRecord,
  WorkflowPriority,
  WorkflowSlaRecord,
} from '@trustsystem/workflow-core';
import {
  evaluateCondition,
  type WorkflowEscalationRuleSpec,
} from '@trustsystem/workflow-definition';

/**
 * Escalation.
 *
 * What happens when an SLA runs out. The requirement that shapes the whole file is
 * **idempotency**: an escalation must fire once per (target, trigger, rule) however
 * many times the sweep runs.
 *
 * The reason is concrete. A breached SLA stays breached — time does not un-pass — so
 * a scheduler that escalates on every breach it finds will escalate the same breach
 * every minute until somebody clears the queue. At three in the morning that is a
 * pager going off sixty times an hour, and the response is to silence the pager,
 * which is worse than never having built escalation.
 *
 * Idempotency here is a **unique key in the database**, not a check in code. The key
 * is derived deterministically from what is being escalated, and the insert either
 * succeeds or violates a unique constraint. That is the only version that survives
 * two schedulers running at once, which a check-then-insert does not.
 */

/**
 * Notification delivery, as this package needs it.
 *
 * Deliberately narrow, and deliberately not `@trustsystem/module-notification`: the
 * notification module is an optional install, and a workflow engine that could not
 * escalate without it would be a workflow engine most deployments cannot use. The
 * module satisfies this interface; so does a logger, which is what the default does.
 */
export interface EscalationNotifier {
  readonly id: string;
  notify(input: {
    organizationId: string;
    /** User ids. Resolution to an address belongs to the notifier. */
    recipients: string[];
    templateKey: string;
    /** Non-sensitive substitution values. Never a credential, never a document body. */
    variables: Record<string, string | number | boolean | null>;
  }): Promise<{ delivered: boolean; detail?: string }>;
}

/**
 * A notifier that writes to the log.
 *
 * The default, so escalation works in a deployment with no notification module and in
 * every test. It is honest about what it is: `delivered: true` means "recorded",
 * because a log line genuinely is a delivery to whoever reads logs — and pretending
 * otherwise would make the escalation record say failed when nothing failed.
 */
export class LoggingEscalationNotifier implements EscalationNotifier {
  readonly id = 'log';

  constructor(
    private readonly logger: {
      warn(payload: Record<string, unknown>, message: string): void;
    } = { warn: () => undefined },
  ) {}

  async notify(input: {
    organizationId: string;
    recipients: string[];
    templateKey: string;
    variables: Record<string, string | number | boolean | null>;
  }): Promise<{ delivered: boolean; detail?: string }> {
    this.logger.warn(
      {
        organizationId: input.organizationId,
        recipientCount: input.recipients.length,
        templateKey: input.templateKey,
        variables: input.variables,
      },
      'workflow escalation notification',
    );
    return { delivered: true, detail: 'logged' };
  }
}

/**
 * Who to tell.
 *
 * `supervisor` is the interesting one: the framework has no org chart, so it cannot
 * answer "who is this person's manager". An application implements this, and the
 * default returns nobody rather than guessing — an escalation to the wrong person is
 * worse than one that reports it could not find anyone, because the wrong person
 * assumes somebody else is handling it.
 */
export interface EscalationRecipients {
  assignees(input: {
    organizationId: string;
    taskId: string | null;
    assigneeUserId: string | null;
    assigneeRole: string | null;
    assigneeGroupId: string | null;
  }): Promise<string[]>;

  supervisors(input: {
    organizationId: string;
    ofUserId: string | null;
    /** Fallback: everyone holding this role. Used when no org chart exists. */
    fallbackRole: string | null;
  }): Promise<string[]>;
}

/** Actions that change workflow state. Implemented by the runtime, called from here. */
export interface EscalationEffects {
  reassignTask(input: {
    organizationId: string;
    taskId: string;
    toUserId: string | null;
    toRole: string | null;
    reason: string;
  }): Promise<void>;

  addApprover(input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
    toUserId: string | null;
    toRole: string | null;
  }): Promise<void>;

  increasePriority(input: {
    organizationId: string;
    workflowInstanceId: string;
    taskId: string | null;
    to: WorkflowPriority;
  }): Promise<void>;

  /** Opens an exception case. Implemented by `@trustsystem/case-management`. */
  createIncident(input: {
    organizationId: string;
    workflowInstanceId: string;
    caseType: string;
    subject: string;
    description: string;
  }): Promise<{ caseId: string }>;
}

/**
 * Application callbacks, resolved by key.
 *
 * A key into a registry, never a URL. A definition that could name a URL would be a
 * server-side request forgery primitive writable by anybody who can author a
 * workflow — and workflow authors are administrators, not operators, so the blast
 * radius would be the whole internal network.
 */
export interface EscalationCallback {
  readonly key: string;
  invoke(input: {
    organizationId: string;
    workflowInstanceId: string | null;
    taskId: string | null;
    trigger: EscalationTrigger;
    slaId: string | null;
  }): Promise<void>;
}

export interface EscalationStore {
  /**
   * Inserts an escalation, or returns null when the idempotency key already exists.
   *
   * Must rely on a unique constraint rather than a preceding `SELECT`. A
   * check-then-insert has a window between the two, and two schedulers hitting that
   * window produce two escalations for one breach — which is the exact failure this
   * whole file exists to prevent.
   */
  claim(
    input: Omit<
      WorkflowEscalationRecord,
      'id' | 'completedAt' | 'attempts' | 'status' | 'lastError'
    >,
  ): Promise<WorkflowEscalationRecord | null>;

  update(input: {
    id: string;
    organizationId: string;
    patch: Partial<WorkflowEscalationRecord>;
  }): Promise<WorkflowEscalationRecord>;

  listForInstance(instanceId: string, organizationId: string): Promise<WorkflowEscalationRecord[]>;
  findByKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<WorkflowEscalationRecord | null>;
}

/**
 * The idempotency key.
 *
 * Derived from *what* is being escalated, not from when. Including a timestamp would
 * make every attempt unique, which is the same as having no key at all.
 *
 * The SLA id is in the key when there is one, which gives the right granularity: two
 * different SLAs on the same task escalate separately, and the same SLA breaching
 * escalates once. `ruleKey` distinguishes two rules on one step — "notify the
 * assignee" and "notify the supervisor" are both meant to fire.
 */
export function escalationIdempotencyKey(input: {
  organizationId: string;
  workflowInstanceId: string | null;
  workflowTaskId: string | null;
  workflowSlaId: string | null;
  trigger: EscalationTrigger;
  ruleKey: string;
  action: EscalationActionType;
  /**
   * Distinguishes deliberate re-escalations.
   *
   * A manual escalation of the same task twice is two intentional acts, so the caller
   * passes a discriminator. Automatic escalations leave it null and are therefore
   * once-only.
   */
  occurrence?: string | null;
}): string {
  const parts = [
    input.organizationId,
    input.workflowInstanceId ?? '-',
    input.workflowTaskId ?? '-',
    input.workflowSlaId ?? '-',
    input.trigger,
    input.ruleKey,
    input.action,
    input.occurrence ?? '-',
  ];

  // Hashed rather than concatenated: the parts include ids of unbounded length, and a
  // fixed-width key indexes better and cannot overflow a column.
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 48);
}

export interface EscalationServiceOptions {
  store: EscalationStore;
  notifier?: EscalationNotifier;
  recipients?: EscalationRecipients;
  effects?: EscalationEffects;
  callbacks?: EscalationCallback[];
  events?: SecurityEventEmitter;
  now?: () => Date;
}

export interface EscalationContext {
  organizationId: string;
  workflowInstanceId: string | null;
  workflowTaskId: string | null;
  workflowSlaId: string | null;
  trigger: EscalationTrigger;
  /** Instance data, for a conditional rule. */
  data: Record<string, unknown>;
  /** For the notification body and for choosing recipients. */
  workflowName: string;
  stepKey: string | null;
  taskTitle: string | null;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  assigneeGroupId: string | null;
  /** Discriminator for a deliberate re-escalation. Null for automatic ones. */
  occurrence?: string | null;
}

export interface EscalationOutcome {
  /** The record, or null when the rule did not apply or had already fired. */
  record: WorkflowEscalationRecord | null;
  status: 'fired' | 'skipped_duplicate' | 'skipped_condition' | 'failed';
  detail: string;
}

export class EscalationService {
  private readonly now: () => Date;
  private readonly notifier: EscalationNotifier;

  constructor(private readonly options: EscalationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.notifier = options.notifier ?? new LoggingEscalationNotifier();
  }

  /**
   * Runs the rules that match a trigger.
   *
   * Every rule is attempted even if an earlier one fails, and each returns its own
   * outcome. A failed notification must not stop a reassignment: the two are separate
   * mitigations for the same problem, and the one that works should still happen.
   */
  async escalate(input: {
    rules: WorkflowEscalationRuleSpec[];
    context: EscalationContext;
  }): Promise<EscalationOutcome[]> {
    const applicable = input.rules.filter((rule) => rule.trigger === input.context.trigger);
    const outcomes: EscalationOutcome[] = [];

    for (const rule of applicable) {
      outcomes.push(await this.runRule(rule, input.context));
    }

    return outcomes;
  }

  /** Escalations for the SLAs a sweep just claimed. */
  async escalateSlaBreaches(input: {
    breached: WorkflowSlaRecord[];
    warned: WorkflowSlaRecord[];
    /** Resolves the rules and context for an SLA. Provided by the runtime. */
    resolve: (sla: WorkflowSlaRecord) => Promise<{
      rules: WorkflowEscalationRuleSpec[];
      context: Omit<EscalationContext, 'trigger' | 'workflowSlaId'>;
    } | null>;
  }): Promise<EscalationOutcome[]> {
    const outcomes: EscalationOutcome[] = [];

    for (const [records, trigger] of [
      [input.breached, 'sla_breach'],
      [input.warned, 'sla_warning'],
    ] as const) {
      for (const sla of records) {
        const resolved = await input.resolve(sla);
        if (!resolved) continue;

        outcomes.push(
          ...(await this.escalate({
            rules: resolved.rules,
            context: { ...resolved.context, trigger, workflowSlaId: sla.id },
          })),
        );
      }
    }

    return outcomes;
  }

  private async runRule(
    rule: WorkflowEscalationRuleSpec,
    context: EscalationContext,
  ): Promise<EscalationOutcome> {
    // A conditional rule that does not apply is skipped without a record. Writing a
    // "skipped" row for every non-matching rule on every sweep would fill the table
    // with the absence of events.
    if (rule.condition && !evaluateCondition(rule.condition, context.data)) {
      return {
        record: null,
        status: 'skipped_condition',
        detail: `Rule "${rule.key}" did not match its condition.`,
      };
    }

    const idempotencyKey = escalationIdempotencyKey({
      organizationId: context.organizationId,
      workflowInstanceId: context.workflowInstanceId,
      workflowTaskId: context.workflowTaskId,
      workflowSlaId: context.workflowSlaId,
      trigger: context.trigger,
      ruleKey: rule.key,
      action: rule.action,
      occurrence: context.occurrence ?? null,
    });

    const claimed = await this.options.store.claim({
      organizationId: context.organizationId,
      workflowInstanceId: context.workflowInstanceId,
      workflowTaskId: context.workflowTaskId,
      workflowSlaId: context.workflowSlaId,
      trigger: context.trigger,
      action: rule.action,
      idempotencyKey,
      detail: { ruleKey: rule.key, stepKey: context.stepKey },
      triggeredAt: this.now(),
    });

    if (!claimed) {
      // The unique constraint refused it, which means this exact escalation already
      // fired. The normal outcome on every sweep after the first, and not an error.
      return {
        record: await this.options.store.findByKey(context.organizationId, idempotencyKey),
        status: 'skipped_duplicate',
        detail: `Rule "${rule.key}" already fired for this trigger.`,
      };
    }

    try {
      const detail = await this.performAction(rule, context);

      const completed = await this.options.store.update({
        id: claimed.id,
        organizationId: context.organizationId,
        patch: {
          status: 'succeeded',
          attempts: 1,
          completedAt: this.now(),
          detail: { ...(claimed.detail ?? {}), outcome: detail },
        },
      });

      return { record: completed, status: 'fired', detail };
    } catch (error) {
      /*
       * The record stays. A failed escalation that left no trace would mean nobody
       * knows the breach went unhandled — and "the pager did not fire and there is no
       * record of why" is the worst possible state.
       *
       * The row keeps its idempotency key, so a retry needs a deliberate act rather
       * than happening on the next sweep. A sweep that retried automatically would
       * retry a permanently broken action every minute.
       */
      const message = error instanceof Error ? error.message : String(error);

      const failed = await this.options.store.update({
        id: claimed.id,
        organizationId: context.organizationId,
        patch: {
          status: 'failed',
          attempts: claimed.attempts + 1,
          // The message, not the stack: a stack from an application callback may name
          // internal paths, and this row is readable in the administration portal.
          lastError: message.slice(0, 500),
          completedAt: this.now(),
        },
      });

      return { record: failed, status: 'failed', detail: message };
    }
  }

  private async performAction(
    rule: WorkflowEscalationRuleSpec,
    context: EscalationContext,
  ): Promise<string> {
    switch (rule.action) {
      case 'notify_assignee': {
        const recipients = await this.resolveAssignees(context);
        if (recipients.length === 0) {
          // Not an error: a pooled task legitimately has no individual assignee. The
          // outcome says so, which is more useful than a failure nobody can act on.
          return 'No individual assignee to notify (the task is pooled).';
        }
        const result = await this.notifier.notify({
          organizationId: context.organizationId,
          recipients,
          templateKey: rule.templateKey ?? 'workflow.escalation',
          variables: this.variables(context),
        });
        return `Notified ${recipients.length} assignee(s) via ${this.notifier.id}: ${
          result.detail ?? (result.delivered ? 'delivered' : 'not delivered')
        }.`;
      }

      case 'notify_supervisor': {
        const recipients = await this.options.recipients?.supervisors({
          organizationId: context.organizationId,
          ofUserId: context.assigneeUserId,
          fallbackRole: context.assigneeRole,
        });

        if (!recipients || recipients.length === 0) {
          // Reported rather than silently succeeding. An escalation that believes it
          // told a supervisor when it told nobody is how a breach goes unnoticed for a
          // week.
          throw new Error(
            'No supervisor could be resolved. The framework has no org chart; register an ' +
              'EscalationRecipients implementation, or use notify_assignee with a role.',
          );
        }

        const result = await this.notifier.notify({
          organizationId: context.organizationId,
          recipients,
          templateKey: rule.templateKey ?? 'workflow.escalation.supervisor',
          variables: this.variables(context),
        });
        return `Notified ${recipients.length} supervisor(s): ${
          result.detail ?? (result.delivered ? 'delivered' : 'not delivered')
        }.`;
      }

      case 'reassign_task': {
        if (!context.workflowTaskId) throw new Error('No task to reassign.');
        if (!this.options.effects) throw new Error('No EscalationEffects registered.');

        await this.options.effects.reassignTask({
          organizationId: context.organizationId,
          taskId: context.workflowTaskId,
          toUserId: rule.assignment?.userId ?? null,
          toRole: rule.assignment?.role ?? null,
          reason: `Escalated: ${context.trigger} on rule "${rule.key}".`,
        });
        return 'Task reassigned.';
      }

      case 'add_approver': {
        if (!context.workflowInstanceId || !context.stepKey) {
          throw new Error('No instance or step to add an approver to.');
        }
        if (!this.options.effects) throw new Error('No EscalationEffects registered.');

        await this.options.effects.addApprover({
          organizationId: context.organizationId,
          workflowInstanceId: context.workflowInstanceId,
          stepKey: context.stepKey,
          toUserId: rule.assignment?.userId ?? null,
          toRole: rule.assignment?.role ?? null,
        });
        return 'Secondary approver added.';
      }

      case 'increase_priority': {
        if (!context.workflowInstanceId) throw new Error('No instance to reprioritise.');
        if (!this.options.effects) throw new Error('No EscalationEffects registered.');

        await this.options.effects.increasePriority({
          organizationId: context.organizationId,
          workflowInstanceId: context.workflowInstanceId,
          taskId: context.workflowTaskId,
          // One step, not straight to urgent. A breach that jumps everything to
          // urgent means nothing is urgent by the end of the week.
          to: context.trigger === 'sla_breach' ? 'high' : 'normal',
        });
        return 'Priority increased.';
      }

      case 'create_incident': {
        if (!context.workflowInstanceId) throw new Error('No instance to raise a case for.');
        if (!this.options.effects) throw new Error('No EscalationEffects registered.');

        const created = await this.options.effects.createIncident({
          organizationId: context.organizationId,
          workflowInstanceId: context.workflowInstanceId,
          caseType: 'operational_exception',
          subject: `SLA ${context.trigger} on ${context.workflowName}`,
          description:
            `Step "${context.stepKey ?? 'unknown'}" of ${context.workflowName} ` +
            `${context.trigger === 'sla_breach' ? 'breached' : 'is close to breaching'} its SLA.`,
        });
        return `Exception case ${created.caseId} opened.`;
      }

      case 'callback': {
        const key = rule.callbackKey as string;
        const callback = this.options.callbacks?.find((candidate) => candidate.key === key);

        if (!callback) {
          throw new Error(
            `No escalation callback is registered under "${key}". A definition names a ` +
              'registered key, never a URL.',
          );
        }

        await callback.invoke({
          organizationId: context.organizationId,
          workflowInstanceId: context.workflowInstanceId,
          taskId: context.workflowTaskId,
          trigger: context.trigger,
          slaId: context.workflowSlaId,
        });
        return `Callback "${key}" invoked.`;
      }
    }
  }

  private async resolveAssignees(context: EscalationContext): Promise<string[]> {
    if (this.options.recipients) {
      return this.options.recipients.assignees({
        organizationId: context.organizationId,
        taskId: context.workflowTaskId,
        assigneeUserId: context.assigneeUserId,
        assigneeRole: context.assigneeRole,
        assigneeGroupId: context.assigneeGroupId,
      });
    }
    // Without a directory, only a named assignee can be reached. A role or a group
    // needs a lookup this package deliberately does not have.
    return context.assigneeUserId ? [context.assigneeUserId] : [];
  }

  /**
   * Notification variables.
   *
   * Ids, names and a step key — nothing from instance data. Instance data is
   * caller-supplied and may hold anything a product put there, and a notification is
   * the one place in the system that leaves it: an email is not covered by the
   * framework's redaction and cannot be recalled.
   */
  private variables(context: EscalationContext): Record<string, string | number | boolean | null> {
    return {
      workflowName: context.workflowName,
      stepKey: context.stepKey,
      taskTitle: context.taskTitle,
      trigger: context.trigger,
      workflowInstanceId: context.workflowInstanceId,
      taskId: context.workflowTaskId,
    };
  }

  /**
   * Escalation history for an instance.
   *
   * Includes failures. "The pager did not fire and there is no record of why" is the worst
   * possible state, so a failed escalation keeps its row, its attempt count and its reason.
   */
  history(instanceId: string, organizationId: string): Promise<WorkflowEscalationRecord[]> {
    return this.options.store.listForInstance(instanceId, organizationId);
  }

  /**
   * A manual escalation.
   *
   * Needs a reason and an occurrence discriminator: escalating the same task twice on
   * purpose is two acts, and the idempotency key has to let both through — while
   * still collapsing an accidental double-submit of one of them.
   */
  async escalateManually(input: {
    rules: WorkflowEscalationRuleSpec[];
    context: Omit<EscalationContext, 'trigger'>;
    reason: string;
    occurrence: string;
  }): Promise<EscalationOutcome[]> {
    if (!input.reason.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'A manual escalation needs a reason.' }],
        'Escalating manually requires a reason.',
      );
    }

    return this.escalate({
      rules: input.rules,
      context: { ...input.context, trigger: 'manual', occurrence: input.occurrence },
    });
  }
}

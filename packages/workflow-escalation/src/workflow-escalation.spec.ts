import { describe, expect, it } from 'vitest';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustos/security-events';
import type { WorkflowEscalationRecord, WorkflowPriority } from '@trustos/workflow-core';
import type { WorkflowEscalationRuleSpec } from '@trustos/workflow-definition';
import {
  EscalationService,
  escalationIdempotencyKey,
  LoggingEscalationNotifier,
  type EscalationContext,
  type EscalationStore,
} from './escalation';

/**
 * Escalation tests.
 *
 * The property that matters is idempotency: a breached SLA stays breached, so a sweep
 * running every minute would escalate the same breach every minute — and the response to a
 * pager firing sixty times an hour is to silence the pager. Most of this file is one
 * assertion in several shapes: the second attempt must do nothing.
 */

const ACME = 'org_acme';

class TestEscalationStore implements EscalationStore {
  readonly records = new Map<string, WorkflowEscalationRecord>();
  private counter = 0;

  async claim(
    input: Omit<
      WorkflowEscalationRecord,
      'id' | 'completedAt' | 'attempts' | 'status' | 'lastError'
    >,
  ) {
    // The unique constraint, modelled. Returning null on a duplicate *is* the idempotency
    // guarantee.
    const existing = [...this.records.values()].find(
      (record) =>
        record.organizationId === input.organizationId &&
        record.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return null;

    this.counter += 1;
    const record: WorkflowEscalationRecord = {
      ...input,
      id: `esc_${this.counter}`,
      status: 'pending',
      attempts: 0,
      lastError: null,
      completedAt: null,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(input: {
    id: string;
    organizationId: string;
    patch: Partial<WorkflowEscalationRecord>;
  }) {
    const record = this.records.get(input.id);
    if (!record) throw new Error('missing');
    const updated = { ...record, ...input.patch };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async listForInstance(instanceId: string, organizationId: string) {
    return [...this.records.values()].filter
      ? [...this.records.values()].filter(
          (record) =>
            record.workflowInstanceId === instanceId && record.organizationId === organizationId,
        )
      : [];
  }

  async findByKey(organizationId: string, idempotencyKey: string) {
    return [...this.records.values()].find
      ? ([...this.records.values()].find(
          (record) =>
            record.organizationId === organizationId && record.idempotencyKey === idempotencyKey,
        ) ?? null)
      : null;
  }
}

function context(overrides: Partial<EscalationContext> = {}): EscalationContext {
  return {
    organizationId: ACME,
    workflowInstanceId: 'wfi_1',
    workflowTaskId: 'wft_1',
    workflowSlaId: 'sla_1',
    trigger: 'sla_breach',
    data: { riskRating: 'high' },
    workflowName: 'Change Request Approval',
    stepKey: 'manager_review',
    taskTitle: 'Manager review',
    assigneeUserId: 'user_checker',
    assigneeRole: 'workflow_checker',
    assigneeGroupId: null,
    ...overrides,
  };
}

const notifyRule: WorkflowEscalationRuleSpec = {
  key: 'notify',
  trigger: 'sla_breach',
  action: 'notify_assignee',
  templateKey: 'workflow.sla.breach',
};

function build(overrides: Record<string, unknown> = {}) {
  const store = new TestEscalationStore();
  const sink = new InMemorySecurityEventSink();
  const notified: Array<{ recipients: string[]; templateKey: string; variables: unknown }> = [];

  const service = new EscalationService({
    store,
    notifier: {
      id: 'test',
      notify: async (input) => {
        notified.push(input);
        return { delivered: true, detail: 'test' };
      },
    },
    events: new SecurityEventEmitter({ sinks: [sink], application: 'test' }),
    now: () => new Date('2026-08-01T12:00:00.000Z'),
    ...overrides,
  });

  return { store, service, sink, notified };
}

// ===========================================================================
// Idempotency
// ===========================================================================

describe('the idempotency key', () => {
  it('is the same for the same target and trigger', () => {
    const input = {
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      workflowSlaId: 'sla_1',
      trigger: 'sla_breach' as const,
      ruleKey: 'notify',
      action: 'notify_assignee' as const,
    };

    // No timestamp in it. Including one would make every attempt unique, which is the same
    // as having no key at all.
    expect(escalationIdempotencyKey(input)).toBe(escalationIdempotencyKey(input));
  });

  it('differs per rule, so two rules on one step both fire', () => {
    const base = {
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      workflowSlaId: 'sla_1',
      trigger: 'sla_breach' as const,
      action: 'notify_assignee' as const,
    };

    // "Notify the assignee" and "notify the supervisor" are both meant to happen.
    expect(escalationIdempotencyKey({ ...base, ruleKey: 'a' })).not.toBe(
      escalationIdempotencyKey({ ...base, ruleKey: 'b' }),
    );
  });

  it('differs per SLA, so two SLAs on one task escalate separately', () => {
    const base = {
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      trigger: 'sla_breach' as const,
      ruleKey: 'notify',
      action: 'notify_assignee' as const,
    };

    expect(escalationIdempotencyKey({ ...base, workflowSlaId: 'a' })).not.toBe(
      escalationIdempotencyKey({ ...base, workflowSlaId: 'b' }),
    );
  });

  it('lets a deliberate re-escalation through via the occurrence discriminator', () => {
    const base = {
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      workflowSlaId: null,
      trigger: 'manual' as const,
      ruleKey: 'notify',
      action: 'notify_assignee' as const,
    };

    // Escalating the same task twice on purpose is two acts, and both must be possible —
    // while an accidental double-submit of one of them is still collapsed.
    expect(escalationIdempotencyKey({ ...base, occurrence: 'first' })).not.toBe(
      escalationIdempotencyKey({ ...base, occurrence: 'second' }),
    );
  });

  it('is fixed width, whatever the ids are', () => {
    const long = escalationIdempotencyKey({
      organizationId: 'x'.repeat(200),
      workflowInstanceId: 'y'.repeat(200),
      workflowTaskId: null,
      workflowSlaId: null,
      trigger: 'manual',
      ruleKey: 'r',
      action: 'callback',
    });

    // Hashed rather than concatenated, so it indexes well and cannot overflow a column.
    expect(long).toHaveLength(48);
  });
});

describe('escalating', () => {
  it('fires a matching rule once', async () => {
    const { service, notified } = build();

    const [outcome] = await service.escalate({ rules: [notifyRule], context: context() });

    expect(outcome).toMatchObject({ status: 'fired' });
    expect(notified).toHaveLength(1);
    expect(notified[0]?.recipients).toEqual(['user_checker']);
  });

  it('does nothing on the second attempt', async () => {
    const { service, notified } = build();

    await service.escalate({ rules: [notifyRule], context: context() });
    const [second] = await service.escalate({ rules: [notifyRule], context: context() });

    // The normal outcome on every sweep after the first, and not an error.
    expect(second).toMatchObject({ status: 'skipped_duplicate' });
    expect(notified).toHaveLength(1);
  });

  it('ignores a rule whose trigger does not match', async () => {
    const { service, notified } = build();

    await service.escalate({
      rules: [{ ...notifyRule, trigger: 'sla_warning' }],
      context: context({ trigger: 'sla_breach' }),
    });

    expect(notified).toHaveLength(0);
  });

  it('skips a conditional rule that does not apply, without writing a record', async () => {
    const { store, service } = build();

    const [outcome] = await service.escalate({
      rules: [
        {
          ...notifyRule,
          condition: { field: 'riskRating', operator: 'eq', value: 'low' },
        },
      ],
      context: context({ data: { riskRating: 'high' } }),
    });

    expect(outcome).toMatchObject({ status: 'skipped_condition', record: null });
    // Writing a "skipped" row for every non-matching rule on every sweep would fill the
    // table with the absence of events.
    expect(store.records.size).toBe(0);
  });

  it('fires a conditional rule that does apply', async () => {
    const { service, notified } = build();

    await service.escalate({
      rules: [
        {
          ...notifyRule,
          condition: { field: 'riskRating', operator: 'eq', value: 'high' },
        },
      ],
      context: context({ data: { riskRating: 'high' } }),
    });

    expect(notified).toHaveLength(1);
  });

  it('runs every rule even when an earlier one fails', async () => {
    const { service, notified } = build();

    const outcomes = await service.escalate({
      rules: [
        // No effects registered, so this one fails.
        {
          key: 'reassign',
          trigger: 'sla_breach',
          action: 'reassign_task',
          assignment: { strategy: 'role', role: 'x' },
        },
        notifyRule,
      ],
      context: context(),
    });

    // A failed reassignment must not stop the notification: they are separate mitigations
    // for the same problem, and the one that works should still happen.
    expect(outcomes[0]).toMatchObject({ status: 'failed' });
    expect(outcomes[1]).toMatchObject({ status: 'fired' });
    expect(notified).toHaveLength(1);
  });

  it('keeps a record of a failed escalation, with the reason', async () => {
    const { store, service } = build();

    await service.escalate({
      rules: [
        {
          key: 'reassign',
          trigger: 'sla_breach',
          action: 'reassign_task',
          assignment: { strategy: 'role', role: 'x' },
        },
      ],
      context: context(),
    });

    // "The pager did not fire and there is no record of why" is the worst possible state.
    const record = [...store.records.values()][0];
    expect(record).toMatchObject({ status: 'failed', attempts: 1 });
    expect(record?.lastError).toContain('EscalationEffects');
  });

  it('does not retry a failed escalation on the next sweep', async () => {
    const { service } = build();

    const rules: WorkflowEscalationRuleSpec[] = [
      {
        key: 'reassign',
        trigger: 'sla_breach',
        action: 'reassign_task',
        assignment: { strategy: 'role', role: 'x' },
      },
    ];

    await service.escalate({ rules, context: context() });
    const [second] = await service.escalate({ rules, context: context() });

    // The row keeps its idempotency key, so a retry needs a deliberate act. A sweep that
    // retried automatically would retry a permanently broken action every minute.
    expect(second).toMatchObject({ status: 'skipped_duplicate' });
  });

  it('reports rather than silently succeeding when no supervisor can be found', async () => {
    const { service, store } = build();

    await service.escalate({
      rules: [{ key: 'sup', trigger: 'sla_breach', action: 'notify_supervisor' }],
      context: context(),
    });

    // An escalation that believes it told a supervisor when it told nobody is how a breach
    // goes unnoticed for a week.
    const record = [...store.records.values()][0];
    expect(record?.status).toBe('failed');
    expect(record?.lastError).toContain('org chart');
  });

  it('notifies supervisors when a directory is registered', async () => {
    const { service, notified } = build({
      recipients: {
        assignees: async () => ['user_checker'],
        supervisors: async () => ['user_boss'],
      },
    });

    await service.escalate({
      rules: [{ key: 'sup', trigger: 'sla_breach', action: 'notify_supervisor' }],
      context: context(),
    });

    expect(notified[0]?.recipients).toEqual(['user_boss']);
  });

  it('reports a pooled task with no individual assignee as a non-failure', async () => {
    const { service } = build();

    const [outcome] = await service.escalate({
      rules: [notifyRule],
      context: context({ assigneeUserId: null }),
    });

    // Not an error: a pooled task legitimately has no individual assignee. The outcome
    // says so, which is more useful than a failure nobody can act on.
    expect(outcome.status).toBe('fired');
    expect(outcome.detail).toContain('pooled');
  });

  it('puts no instance data in a notification', async () => {
    const { service, notified } = build();

    await service.escalate({
      rules: [notifyRule],
      context: context({
        data: { customerIdentityNumber: '99887766', riskRating: 'high' },
      }),
    });

    // A notification is the one place in the system that leaves it: an email is not
    // covered by the framework's redaction and cannot be recalled.
    expect(JSON.stringify(notified)).not.toContain('99887766');
    expect(notified[0]?.variables).toMatchObject({
      workflowName: 'Change Request Approval',
      stepKey: 'manager_review',
    });
  });
});

describe('effect actions', () => {
  it('reassigns a task through the registered effects', async () => {
    const reassigned: unknown[] = [];
    const { service } = build({
      effects: {
        reassignTask: async (input: unknown) => void reassigned.push(input),
        addApprover: async () => undefined,
        increasePriority: async () => undefined,
        createIncident: async () => ({ caseId: 'case_1' }),
      },
    });

    await service.escalate({
      rules: [
        {
          key: 'reassign',
          trigger: 'sla_breach',
          action: 'reassign_task',
          assignment: { strategy: 'role', role: 'workflow_administrator' },
        },
      ],
      context: context(),
    });

    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]).toMatchObject({ toRole: 'workflow_administrator' });
  });

  it('raises priority one step rather than straight to urgent', async () => {
    const raised: Array<{ to: WorkflowPriority }> = [];
    const { service } = build({
      effects: {
        reassignTask: async () => undefined,
        addApprover: async () => undefined,
        increasePriority: async (input: { to: WorkflowPriority }) => void raised.push(input),
        createIncident: async () => ({ caseId: 'case_1' }),
      },
    });

    await service.escalate({
      rules: [{ key: 'bump', trigger: 'sla_breach', action: 'increase_priority' }],
      context: context(),
    });

    // A breach that jumps everything to urgent means nothing is urgent by the end of the
    // week.
    expect(raised[0]?.to).toBe('high');
  });

  it('invokes a registered callback by key', async () => {
    const invoked: unknown[] = [];
    const { service } = build({
      callbacks: [
        { key: 'notify-erp', invoke: async (input: unknown) => void invoked.push(input) },
      ],
    });

    await service.escalate({
      rules: [{ key: 'cb', trigger: 'sla_breach', action: 'callback', callbackKey: 'notify-erp' }],
      context: context(),
    });

    expect(invoked).toHaveLength(1);
  });

  it('fails on an unregistered callback key rather than guessing', async () => {
    const { store, service } = build();

    await service.escalate({
      rules: [
        { key: 'cb', trigger: 'sla_breach', action: 'callback', callbackKey: 'not-registered' },
      ],
      context: context(),
    });

    const record = [...store.records.values()][0];
    expect(record?.status).toBe('failed');
    // A definition names a registered key, never a URL — otherwise a workflow author
    // becomes a server-side request forgery primitive.
    expect(record?.lastError).toContain('never a URL');
  });
});

describe('manual escalation', () => {
  it('requires a reason', async () => {
    const { service } = build();

    await expect(
      service.escalateManually({
        rules: [{ ...notifyRule, trigger: 'manual' }],
        context: context({ trigger: 'manual' }),
        reason: '   ',
        occurrence: 'attempt-1',
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('lets two deliberate escalations through, and collapses a double-submit', async () => {
    const { service, notified } = build();
    const rules = [{ ...notifyRule, trigger: 'manual' as const }];
    const base = context({ trigger: 'manual' });

    await service.escalateManually({ rules, context: base, reason: 'urgent', occurrence: 'one' });
    // Same occurrence: a double-submit, collapsed.
    await service.escalateManually({ rules, context: base, reason: 'urgent', occurrence: 'one' });
    // A different occurrence: a second deliberate act.
    await service.escalateManually({
      rules,
      context: base,
      reason: 'still stuck',
      occurrence: 'two',
    });

    expect(notified).toHaveLength(2);
  });
});

describe('the default notifier', () => {
  it('records rather than pretending to deliver', async () => {
    const lines: unknown[] = [];
    const notifier = new LoggingEscalationNotifier({ warn: (payload) => void lines.push(payload) });

    const result = await notifier.notify({
      organizationId: ACME,
      recipients: ['user_a'],
      templateKey: 'x',
      variables: {},
    });

    // `delivered: true` means "recorded", because a log line genuinely is a delivery to
    // whoever reads logs — and claiming otherwise would make the escalation record say
    // failed when nothing failed.
    expect(result).toMatchObject({ delivered: true, detail: 'logged' });
    expect(lines).toHaveLength(1);
  });

  it('logs a recipient count rather than the recipients', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const notifier = new LoggingEscalationNotifier({ warn: (payload) => void lines.push(payload) });

    await notifier.notify({
      organizationId: ACME,
      recipients: ['user_a', 'user_b'],
      templateKey: 'x',
      variables: {},
    });

    expect(lines[0]).toMatchObject({ recipientCount: 2 });
  });
});

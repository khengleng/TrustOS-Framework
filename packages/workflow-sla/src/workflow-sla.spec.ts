import { describe, expect, it } from 'vitest';
import type { WorkflowSlaRecord } from '@trustsystem/workflow-core';
import {
  buildSlaRecord,
  CalendarRegistry,
  describeSla,
  ElapsedTimeCalendar,
  evaluateSla,
  SimpleWorkingHoursCalendar,
  SlaService,
  type SlaStore,
} from './index';

/**
 * SLA tests.
 *
 * The property under test throughout is that **status is derived, not stored**. Every
 * assertion evaluates a record at a chosen instant and expects the answer to follow from
 * the timestamps — because the alternative design, a scheduler that writes `breached`, is
 * confidently wrong for as long as the scheduler is down.
 */

const ACME = 'org_acme';
const START = new Date('2026-08-01T09:00:00.000Z');

function record(overrides: Partial<WorkflowSlaRecord> = {}): WorkflowSlaRecord {
  const base = buildSlaRecord({
    rule: {
      kind: 'time_to_complete',
      minutes: 60,
      warningAtPercent: 80,
      severity: 'medium',
      calendar: 'elapsed',
    },
    organizationId: ACME,
    workflowInstanceId: 'wfi_1',
    workflowTaskId: 'wft_1',
    stepKey: 'review',
    startedAt: START,
  });

  return {
    ...base,
    id: 'sla_1',
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * 60_000);
}

class TestSlaStore implements SlaStore {
  readonly records = new Map<string, WorkflowSlaRecord>();
  private counter = 0;

  async findById(id: string, organizationId: string) {
    const found = this.records.get(id);
    return found && found.organizationId === organizationId ? { ...found } : null;
  }

  async create(input: Omit<WorkflowSlaRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    this.counter += 1;
    const created: WorkflowSlaRecord = {
      ...input,
      id: `sla_${this.counter}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.records.set(created.id, created);
    return { ...created };
  }

  async update(input: { id: string; organizationId: string; patch: Partial<WorkflowSlaRecord> }) {
    const found = this.records.get(input.id);
    if (!found) throw new Error('missing');
    const updated = { ...found, ...input.patch };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async listForInstance(instanceId: string, organizationId: string) {
    return [...this.records.values()].filter(
      (entry) => entry.workflowInstanceId === instanceId && entry.organizationId === organizationId,
    );
  }

  async listForTask(taskId: string, organizationId: string) {
    return [...this.records.values()].filter(
      (entry) => entry.workflowTaskId === taskId && entry.organizationId === organizationId,
    );
  }

  async listDueForWarning(input: { asOf: Date; limit: number }) {
    return [...this.records.values()]
      .filter((entry) => ['active', 'warning'].includes(entry.status))
      .filter((entry) => entry.warningAt <= input.asOf)
      .filter((entry) => entry.warnedAt === null)
      .slice(0, input.limit);
  }

  async listDueForBreach(input: { asOf: Date; limit: number }) {
    return [...this.records.values()]
      .filter((entry) => ['active', 'warning', 'breached'].includes(entry.status))
      .filter((entry) => entry.dueAt <= input.asOf)
      .filter((entry) => entry.breachedAt === null)
      .slice(0, input.limit);
  }

  async markWarned(id: string, when: Date) {
    const found = this.records.get(id);
    if (!found || found.warnedAt !== null) return null;
    const updated = { ...found, warnedAt: when, status: 'warning' as const };
    this.records.set(id, updated);
    return { ...updated };
  }

  async markBreached(id: string, when: Date) {
    const found = this.records.get(id);
    if (!found || found.breachedAt !== null) return null;
    const updated = { ...found, breachedAt: when, status: 'breached' as const };
    this.records.set(id, updated);
    return { ...updated };
  }
}

// ===========================================================================
// Calendars
// ===========================================================================

describe('the elapsed calendar', () => {
  it('measures wall-clock time', () => {
    const calendar = new ElapsedTimeCalendar();

    expect(calendar.deadline(START, 3600)).toEqual(new Date('2026-08-01T10:00:00.000Z'));
    expect(calendar.elapsed(START, at(30))).toBe(1800);
  });

  it('clamps a negative interval to zero', () => {
    // Clock skew, or a caller passing the instants the wrong way round. "Minus three
    // hours have passed" is not a useful number to propagate into an SLA status.
    expect(new ElapsedTimeCalendar().elapsed(at(30), START)).toBe(0);
  });
});

describe('the calendar registry', () => {
  it('always provides elapsed, whatever the caller passed', () => {
    // Every default in the definition schema is `elapsed`, so a registry without it
    // would break every workflow that did not name one explicitly.
    const registry = new CalendarRegistry([new SimpleWorkingHoursCalendar()]);
    expect(registry.has('elapsed')).toBe(true);
    expect(registry.has('working-hours')).toBe(true);
  });

  it('throws on an unknown id rather than falling back', () => {
    // A fallback here is an SLA that looks correct and is wrong by a factor of three.
    expect(() => new CalendarRegistry().get('working-hours-kh')).toThrow(/Refusing to fall back/);
  });
});

describe('the working-hours example calendar', () => {
  it('skips a weekend', () => {
    const calendar = new SimpleWorkingHoursCalendar('wh', 9, 17);
    // Friday 16:00 UTC. Two working hours from there lands on Monday.
    const friday = new Date('2026-07-31T16:00:00.000Z');
    const deadline = calendar.deadline(friday, 2 * 3600);

    expect(deadline.getUTCDay()).toBe(1);
  });

  it('counts only working minutes as elapsed', () => {
    const calendar = new SimpleWorkingHoursCalendar('wh', 9, 17);
    // Friday 16:00 to Monday 10:00 is 66 wall-clock hours and 2 working hours.
    const elapsed = calendar.elapsed(
      new Date('2026-07-31T16:00:00.000Z'),
      new Date('2026-08-03T10:00:00.000Z'),
    );

    expect(elapsed).toBe(2 * 3600);
  });

  it('says in its own description that it is not production-ready', () => {
    // No holidays, no DST. A production calendar has to handle both, and an example that
    // did not say so would be copied.
    expect(new SimpleWorkingHoursCalendar().description).toContain('not suitable');
  });
});

// ===========================================================================
// Evaluation
// ===========================================================================

describe('evaluating an SLA', () => {
  it('is active before the warning threshold', () => {
    const evaluation = evaluateSla({ record: record(), now: at(30) });

    expect(evaluation).toMatchObject({
      status: 'active',
      inWarning: false,
      breached: false,
      consumedPercent: 50,
    });
    expect(evaluation.remainingSeconds).toBe(30 * 60);
  });

  it('warns at the configured percentage', () => {
    // 80% of 60 minutes.
    expect(evaluateSla({ record: record(), now: at(48) })).toMatchObject({
      status: 'warning',
      inWarning: true,
      breached: false,
    });
  });

  it('breaches at the deadline', () => {
    expect(evaluateSla({ record: record(), now: at(60) })).toMatchObject({
      status: 'breached',
      breached: true,
      inWarning: false,
    });
  });

  it('reports how far past the deadline it is', () => {
    const evaluation = evaluateSla({ record: record(), now: at(90) });
    expect(evaluation.remainingSeconds).toBe(-30 * 60);
    expect(evaluation.consumedPercent).toBe(150);
  });

  it('derives the same answer from the same record and instant, every time', () => {
    // The whole point of deriving rather than storing: a reader always sees the truth,
    // and a scheduler being down for two hours does not make the dashboard lie.
    const stale = record({ status: 'active' });
    expect(evaluateSla({ record: stale, now: at(90) }).status).toBe('breached');
    expect(evaluateSla({ record: stale, now: at(90) }).status).toBe('breached');
  });

  it('stops the clock while paused', () => {
    const paused = record({ status: 'paused', pausedAt: at(20) });

    // Without this a pause would be cosmetic: the status would say paused while the
    // calculation kept running, and the SLA would breach while legitimately waiting on a
    // third party.
    const evaluation = evaluateSla({ record: paused, now: at(300) });
    expect(evaluation.status).toBe('paused');
    expect(evaluation.elapsedSeconds).toBe(20 * 60);
    expect(evaluation.breached).toBe(false);
  });

  it('subtracts banked paused time after resuming', () => {
    // Paused for 100 minutes, resumed. At minute 130 only 30 minutes have counted.
    const resumed = record({ status: 'active', pausedSeconds: 100 * 60 });

    const evaluation = evaluateSla({ record: resumed, now: at(130) });
    expect(evaluation.elapsedSeconds).toBe(30 * 60);
    expect(evaluation.breached).toBe(false);
    // The original `dueAt` is preserved as a record of what was promised; the effective
    // deadline moves by exactly the paused time.
    expect(evaluation.effectiveDueAt.getTime()).toBeGreaterThan(record().dueAt.getTime());
  });

  it('keeps a completed SLA completed, however much time passes', () => {
    const completed = record({ status: 'completed', completedAt: at(30) });

    // Re-deriving would make a met target retroactively missed.
    const evaluation = evaluateSla({ record: completed, now: at(1000) });
    expect(evaluation.status).toBe('completed');
    expect(evaluation.breached).toBe(false);
  });

  it('reports a completed-late SLA as having breached', () => {
    const late = record({ status: 'completed', completedAt: at(90) });

    // Whether it was *met* is a separate question from whether it is running, and the
    // fact is reported rather than hidden.
    const evaluation = evaluateSla({ record: late, now: at(1000) });
    expect(evaluation.status).toBe('completed');
    expect(evaluation.breached).toBe(true);
  });

  it('reports a pending SLA as consuming nothing', () => {
    expect(evaluateSla({ record: record({ status: 'pending' }), now: at(500) })).toMatchObject({
      status: 'pending',
      consumedPercent: 0,
    });
  });
});

describe('building an SLA record', () => {
  it('stores both absolute instants and second offsets', () => {
    const built = buildSlaRecord({
      rule: {
        kind: 'time_to_complete',
        minutes: 120,
        warningAtPercent: 75,
        severity: 'high',
        calendar: 'elapsed',
      },
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: null,
      stepKey: 'review',
      startedAt: START,
    });

    // The instants let an index answer "which SLAs are due?" without computing a calendar
    // per row; the offsets let the status be recomputed after a pause moved the deadline.
    expect(built.durationSeconds).toBe(120 * 60);
    expect(built.warningAtSeconds).toBe(90 * 60);
    expect(built.dueAt).toEqual(new Date('2026-08-01T11:00:00.000Z'));
    expect(built.warningAt).toEqual(new Date('2026-08-01T10:30:00.000Z'));
  });
});

// ===========================================================================
// The sweep
// ===========================================================================

describe('the sweep', () => {
  function build(now: () => Date) {
    const store = new TestSlaStore();
    return { store, service: new SlaService({ store, now }) };
  }

  it('claims a warning once, however many times it runs', async () => {
    let clock = START;
    const { store, service } = build(() => clock);

    await service.startForStep({
      rules: [
        {
          kind: 'time_to_complete',
          minutes: 60,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      stepKey: 'review',
    });

    clock = at(50);

    const first = await service.sweep();
    expect(first.warned).toHaveLength(1);

    // The second sweep must find nothing. A breached or warned SLA stays that way — time
    // does not un-pass — so without this the same threshold pages somebody every minute.
    const second = await service.sweep();
    expect(second.warned).toHaveLength(0);

    void store;
  });

  it('claims a breach once', async () => {
    let clock = START;
    const { service } = build(() => clock);

    await service.startForStep({
      rules: [
        {
          kind: 'time_to_complete',
          minutes: 60,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      stepKey: 'review',
    });

    clock = at(120);

    const first = await service.sweep();
    expect(first.breached).toHaveLength(1);
    // Both thresholds were crossed, and the breach wins — a warning about something that
    // has already failed is noise.
    expect(first.warned).toHaveLength(0);

    expect((await service.sweep()).breached).toHaveLength(0);
  });

  it('lets only one of two concurrent sweeps claim each threshold', async () => {
    let clock = START;
    const { service } = build(() => clock);

    await service.startForStep({
      rules: [
        {
          kind: 'time_to_complete',
          minutes: 60,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      stepKey: 'review',
    });

    clock = at(120);

    // Two schedulers. `markBreached` is conditional on `breachedAt` still being null, so
    // one wins and one gets null.
    const [a, b] = await Promise.all([service.sweep(), service.sweep()]);
    expect(a.breached.length + b.breached.length).toBe(1);
  });
});

describe('pausing and resuming', () => {
  function build(now: () => Date) {
    const store = new TestSlaStore();
    return { store, service: new SlaService({ store, now }) };
  }

  it('accumulates paused time across several cycles', async () => {
    let clock = START;
    const { service } = build(() => clock);

    const [sla] = await service.startForStep({
      rules: [
        {
          kind: 'time_to_complete',
          minutes: 60,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      stepKey: 'review',
    });

    clock = at(10);
    await service.pause({ slaId: sla!.id, organizationId: ACME, reason: 'awaiting documents' });
    clock = at(40);
    const resumed = await service.resume({ slaId: sla!.id, organizationId: ACME });
    expect(resumed.pausedSeconds).toBe(30 * 60);

    clock = at(50);
    await service.pause({ slaId: sla!.id, organizationId: ACME, reason: 'again' });
    clock = at(70);
    const second = await service.resume({ slaId: sla!.id, organizationId: ACME });

    // Additive, not overwriting. Overwriting is the bug that would let a workflow pause
    // repeatedly and never breach.
    expect(second.pausedSeconds).toBe(50 * 60);
  });

  it('is idempotent', async () => {
    const clock = START;
    const { service } = build(() => clock);

    const [sla] = await service.startForStep({
      rules: [
        {
          kind: 'time_to_complete',
          minutes: 60,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      stepKey: 'review',
    });

    await service.pause({ slaId: sla!.id, organizationId: ACME, reason: 'x' });
    const again = await service.pause({ slaId: sla!.id, organizationId: ACME, reason: 'x' });
    expect(again.status).toBe('paused');

    await service.resume({ slaId: sla!.id, organizationId: ACME });
    const resumedAgain = await service.resume({ slaId: sla!.id, organizationId: ACME });
    expect(resumedAgain.status).toBe('active');
  });

  it('refuses to pause a completed SLA', async () => {
    const clock = START;
    const { service } = build(() => clock);

    const [sla] = await service.startForStep({
      rules: [
        {
          kind: 'time_to_complete',
          minutes: 60,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      stepKey: 'review',
    });

    await service.complete({ slaId: sla!.id, organizationId: ACME });

    await expect(
      service.pause({ slaId: sla!.id, organizationId: ACME, reason: 'x' }),
    ).rejects.toThrow();
  });

  it('does not find an SLA from another organization', async () => {
    const clock = START;
    const { service } = build(() => clock);

    const [sla] = await service.startForStep({
      rules: [
        {
          kind: 'time_to_complete',
          minutes: 60,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      organizationId: ACME,
      workflowInstanceId: 'wfi_1',
      workflowTaskId: 'wft_1',
      stepKey: 'review',
    });

    await expect(
      service.pause({ slaId: sla!.id, organizationId: 'org_globex', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('describing an SLA', () => {
  it('reports a breach with how far over it is', () => {
    const rendered = describeSla(
      { kind: 'time_to_complete', severity: 'high', durationSeconds: 3600 },
      evaluateSla({ record: record(), now: at(180) }),
    );

    expect(rendered).toContain('BREACHED');
    expect(rendered).toContain('2h');
  });

  it('reports remaining time while active', () => {
    const rendered = describeSla(
      { kind: 'time_to_complete', severity: 'medium', durationSeconds: 3600 },
      evaluateSla({ record: record(), now: at(30) }),
    );

    expect(rendered).toContain('50% used');
  });
});

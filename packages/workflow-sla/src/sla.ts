import { ApiError } from '@trustos/errors';
import type { SlaKind, SlaSeverity, SlaStatus, WorkflowSlaRecord } from '@trustos/workflow-core';
import type { WorkflowSlaRuleSpec } from '@trustos/workflow-definition';
import { CalendarRegistry, type BusinessCalendar } from './calendar';

/**
 * SLA evaluation.
 *
 * The interesting design decision is that an SLA's status is **computed from its
 * timestamps**, not stored and updated. `evaluateSla` is a pure function of a record
 * and a clock: given the same record and the same instant it always returns the same
 * status.
 *
 * The alternative is a scheduler that periodically sets `status = 'breached'`. That
 * design has a failure mode nobody notices until an audit: if the scheduler is down
 * for two hours, every SLA that should have breached in that window shows as active,
 * and the dashboard is confidently wrong. Recomputing means a reader always sees the
 * truth and the scheduler's only job is to fire *side effects* — notifications,
 * escalations — which it can do late without lying about the state.
 *
 * `pausedSeconds` is what makes pausing work. Rather than moving the deadline, paused
 * time accumulates and is subtracted from elapsed — so a chain of pauses and resumes
 * cannot drift, and the original `dueAt` remains a record of what was promised.
 */

export interface SlaEvaluation {
  status: SlaStatus;
  /** Calendar seconds consumed, excluding paused time. */
  elapsedSeconds: number;
  /** Seconds until the deadline. Negative once breached. */
  remainingSeconds: number;
  /** 0–100+, for a progress bar. Exceeds 100 when breached. */
  consumedPercent: number;
  /** True when the warning threshold was crossed and the breach has not been. */
  inWarning: boolean;
  breached: boolean;
  /** Effective deadline, allowing for paused time. */
  effectiveDueAt: Date;
}

export interface EvaluateSlaInput {
  record: Pick<
    WorkflowSlaRecord,
    | 'status'
    | 'startedAt'
    | 'dueAt'
    | 'warningAt'
    | 'durationSeconds'
    | 'warningAtSeconds'
    | 'pausedAt'
    | 'pausedSeconds'
    | 'completedAt'
    | 'calendarId'
  >;
  now: Date;
  calendar?: BusinessCalendar;
}

export function evaluateSla(input: EvaluateSlaInput): SlaEvaluation {
  const { record, now } = input;
  const calendar = input.calendar ?? new CalendarRegistry().get(record.calendarId);

  // Terminal states are terminal. A completed SLA does not become breached later
  // because time kept passing, and re-deriving it would make a met target retroactively
  // missed.
  if (record.status === 'completed' || record.completedAt) {
    const consumed =
      calendar.elapsed(record.startedAt, record.completedAt ?? now) - record.pausedSeconds;
    return {
      status: 'completed',
      elapsedSeconds: Math.max(0, consumed),
      remainingSeconds: record.durationSeconds - Math.max(0, consumed),
      consumedPercent: percent(consumed, record.durationSeconds),
      inWarning: false,
      // Whether it was *met* is a separate question from whether it is running, and
      // this reports the fact rather than hiding it: an SLA completed after its
      // deadline was still breached.
      breached: Math.max(0, consumed) > record.durationSeconds,
      effectiveDueAt: record.dueAt,
    };
  }

  if (record.status === 'pending') {
    return {
      status: 'pending',
      elapsedSeconds: 0,
      remainingSeconds: record.durationSeconds,
      consumedPercent: 0,
      inWarning: false,
      breached: false,
      effectiveDueAt: record.dueAt,
    };
  }

  /*
   * Paused. The clock stopped at `pausedAt`, so elapsed time is measured to there and
   * not to now. Without this, a pause would be cosmetic: the status would say paused
   * while the underlying calculation kept running, and the SLA would breach while
   * legitimately waiting on a third party.
   */
  if (record.status === 'paused' && record.pausedAt) {
    const consumed = calendar.elapsed(record.startedAt, record.pausedAt) - record.pausedSeconds;
    return {
      status: 'paused',
      elapsedSeconds: Math.max(0, consumed),
      remainingSeconds: record.durationSeconds - Math.max(0, consumed),
      consumedPercent: percent(consumed, record.durationSeconds),
      inWarning: false,
      breached: false,
      effectiveDueAt: calendar.deadline(
        record.pausedAt,
        record.durationSeconds - Math.max(0, consumed),
      ),
    };
  }

  const rawElapsed = calendar.elapsed(record.startedAt, now);
  const elapsedSeconds = Math.max(0, rawElapsed - record.pausedSeconds);
  const remainingSeconds = record.durationSeconds - elapsedSeconds;

  // The deadline moves by exactly the time spent paused, which is why `pausedSeconds`
  // is accumulated rather than the deadline being rewritten on each pause.
  const effectiveDueAt =
    record.pausedSeconds > 0 ? calendar.deadline(record.dueAt, record.pausedSeconds) : record.dueAt;

  const breached = elapsedSeconds >= record.durationSeconds;
  const inWarning = !breached && elapsedSeconds >= record.warningAtSeconds;

  return {
    status: breached ? 'breached' : inWarning ? 'warning' : 'active',
    elapsedSeconds,
    remainingSeconds,
    consumedPercent: percent(elapsedSeconds, record.durationSeconds),
    inWarning,
    breached,
    effectiveDueAt,
  };
}

function percent(consumed: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((Math.max(0, consumed) / total) * 100);
}

// --- creation --------------------------------------------------------------

export interface CreateSlaInput {
  rule: WorkflowSlaRuleSpec;
  organizationId: string;
  workflowInstanceId: string | null;
  workflowTaskId: string | null;
  stepKey: string | null;
  startedAt: Date;
  calendars?: CalendarRegistry;
}

/**
 * Builds an SLA record from a definition rule.
 *
 * Both thresholds are stored as absolute instants *and* as second offsets. That looks
 * redundant and is not: the instants let a database index answer "which SLAs are due
 * before now?" without computing a calendar per row, and the offsets let
 * `evaluateSla` recompute correctly after a pause has moved the effective deadline.
 * One without the other means either a table scan or an SLA that pausing breaks.
 */
export function buildSlaRecord(
  input: CreateSlaInput,
): Omit<WorkflowSlaRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const registry = input.calendars ?? new CalendarRegistry();
  const calendar = registry.get(input.rule.calendar);

  const durationSeconds = input.rule.minutes * 60;
  const warningAtSeconds = Math.floor((durationSeconds * input.rule.warningAtPercent) / 100);

  return {
    organizationId: input.organizationId,
    workflowInstanceId: input.workflowInstanceId,
    workflowTaskId: input.workflowTaskId,
    stepKey: input.stepKey,
    kind: input.rule.kind,
    status: 'active',
    severity: input.rule.severity,
    calendarId: input.rule.calendar,
    durationSeconds,
    warningAtSeconds,
    startedAt: input.startedAt,
    dueAt: calendar.deadline(input.startedAt, durationSeconds),
    warningAt: calendar.deadline(input.startedAt, warningAtSeconds),
    warnedAt: null,
    breachedAt: null,
    pausedAt: null,
    pausedSeconds: 0,
    completedAt: null,
  };
}

// --- transitions -----------------------------------------------------------

/**
 * SLA persistence.
 *
 * `markWarned` and `markBreached` exist so that a *notification* fires once even
 * though the *status* is recomputed every time it is read. The status is derived; the
 * side effect is recorded. Conflating the two is what produces either a dashboard
 * that lies or a pager that fires every minute.
 */
export interface SlaStore {
  findById(id: string, organizationId: string): Promise<WorkflowSlaRecord | null>;
  create(
    input: Omit<WorkflowSlaRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowSlaRecord>;
  update(input: {
    id: string;
    organizationId: string;
    patch: Partial<WorkflowSlaRecord>;
  }): Promise<WorkflowSlaRecord>;
  listForInstance(instanceId: string, organizationId: string): Promise<WorkflowSlaRecord[]>;
  listForTask(taskId: string, organizationId: string): Promise<WorkflowSlaRecord[]>;

  /**
   * SLAs that crossed a threshold and have not had their side effect fired.
   *
   * The `warnedAt is null` / `breachedAt is null` filter is what makes the sweep
   * idempotent at the query level: an SLA whose notification already fired is not
   * returned again, so a scheduler running twice in the same minute does nothing the
   * second time.
   */
  listDueForWarning(input: {
    asOf: Date;
    limit: number;
    organizationId?: string;
  }): Promise<WorkflowSlaRecord[]>;
  listDueForBreach(input: {
    asOf: Date;
    limit: number;
    organizationId?: string;
  }): Promise<WorkflowSlaRecord[]>;

  /** Conditional on `warnedAt is null`. Returns null if another sweep won. */
  markWarned(id: string, at: Date): Promise<WorkflowSlaRecord | null>;
  /** Conditional on `breachedAt is null`. */
  markBreached(id: string, at: Date): Promise<WorkflowSlaRecord | null>;
}

export interface SlaServiceOptions {
  store: SlaStore;
  calendars?: CalendarRegistry;
  now?: () => Date;
}

export class SlaService {
  private readonly now: () => Date;
  private readonly calendars: CalendarRegistry;

  constructor(private readonly options: SlaServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.calendars = options.calendars ?? new CalendarRegistry();
  }

  /** Starts the SLAs a step declares. */
  async startForStep(input: {
    rules: WorkflowSlaRuleSpec[];
    organizationId: string;
    workflowInstanceId: string | null;
    workflowTaskId: string | null;
    stepKey: string | null;
  }): Promise<WorkflowSlaRecord[]> {
    const startedAt = this.now();

    return Promise.all(
      input.rules.map((rule) =>
        this.options.store.create(
          buildSlaRecord({
            rule,
            organizationId: input.organizationId,
            workflowInstanceId: input.workflowInstanceId,
            workflowTaskId: input.workflowTaskId,
            stepKey: input.stepKey,
            startedAt,
            calendars: this.calendars,
          }),
        ),
      ),
    );
  }

  /** Current status of every SLA on an instance, recomputed. */
  async statusForInstance(
    instanceId: string,
    organizationId: string,
  ): Promise<Array<WorkflowSlaRecord & { evaluation: SlaEvaluation }>> {
    const records = await this.options.store.listForInstance(instanceId, organizationId);
    const now = this.now();

    return records.map((record) => ({
      ...record,
      evaluation: evaluateSla({
        record,
        now,
        calendar: this.calendars.get(record.calendarId),
      }),
    }));
  }

  /**
   * Stops the clock.
   *
   * For a workflow legitimately waiting on somebody outside the organization: a
   * customer sending a document, a regulator responding. Without it, "waiting for
   * information" breaches an SLA that measures the team's responsiveness, which
   * teaches everyone to ignore the SLA.
   *
   * Requires a reason and is audited by the caller. Pausing an SLA is how a target is
   * met on paper, so it has to be visible.
   */
  async pause(input: {
    slaId: string;
    organizationId: string;
    reason: string;
  }): Promise<WorkflowSlaRecord> {
    const record = await this.require(input.slaId, input.organizationId);

    if (record.status === 'paused') return record; // Idempotent.
    if (record.status === 'completed') {
      throw ApiError.conflict('A completed SLA cannot be paused.', { reason: 'sla_completed' });
    }

    return this.options.store.update({
      id: record.id,
      organizationId: input.organizationId,
      patch: { status: 'paused', pausedAt: this.now() },
    });
  }

  /**
   * Restarts the clock, banking the paused time.
   *
   * `pausedSeconds` accumulates, so several pause/resume cycles are additive rather
   * than each one overwriting the last — which is the bug that would let a workflow
   * pause repeatedly and never breach.
   */
  async resume(input: { slaId: string; organizationId: string }): Promise<WorkflowSlaRecord> {
    const record = await this.require(input.slaId, input.organizationId);

    if (record.status !== 'paused' || !record.pausedAt) return record;

    const calendar = this.calendars.get(record.calendarId);
    const pausedFor = calendar.elapsed(record.pausedAt, this.now());

    return this.options.store.update({
      id: record.id,
      organizationId: input.organizationId,
      patch: {
        status: 'active',
        pausedAt: null,
        pausedSeconds: record.pausedSeconds + pausedFor,
      },
    });
  }

  /** Stops the clock permanently. Called when the step or instance finishes. */
  async complete(input: { slaId: string; organizationId: string }): Promise<WorkflowSlaRecord> {
    const record = await this.require(input.slaId, input.organizationId);
    if (record.completedAt) return record;

    return this.options.store.update({
      id: record.id,
      organizationId: input.organizationId,
      patch: { status: 'completed', completedAt: this.now() },
    });
  }

  /** Completes every SLA attached to a task. Called on task completion. */
  async completeForTask(taskId: string, organizationId: string): Promise<number> {
    const records = await this.options.store.listForTask(taskId, organizationId);
    let completed = 0;

    for (const record of records) {
      if (record.completedAt) continue;
      await this.complete({ slaId: record.id, organizationId });
      completed += 1;
    }

    return completed;
  }

  async completeForInstance(instanceId: string, organizationId: string): Promise<number> {
    const records = await this.options.store.listForInstance(instanceId, organizationId);
    let completed = 0;

    for (const record of records) {
      if (record.completedAt) continue;
      await this.complete({ slaId: record.id, organizationId });
      completed += 1;
    }

    return completed;
  }

  /**
   * The sweep. Finds thresholds that were crossed and claims each one exactly once.
   *
   * `markWarned` and `markBreached` are conditional on the corresponding timestamp
   * being null, so two schedulers running concurrently produce one claim each at most
   * and the loser gets null. Returning the claimed records rather than firing the
   * side effects here keeps this package free of any notification dependency —
   * `@trustos/workflow-escalation` consumes the output.
   */
  async sweep(input: { limit?: number; organizationId?: string } = {}): Promise<{
    warned: WorkflowSlaRecord[];
    breached: WorkflowSlaRecord[];
  }> {
    const asOf = this.now();
    const limit = input.limit ?? 200;
    const scope = input.organizationId ? { organizationId: input.organizationId } : {};

    const breachCandidates = await this.options.store.listDueForBreach({ asOf, limit, ...scope });
    const warnCandidates = await this.options.store.listDueForWarning({ asOf, limit, ...scope });

    const breached: WorkflowSlaRecord[] = [];
    const warned: WorkflowSlaRecord[] = [];

    // Breaches first. An SLA that crossed both thresholds since the last sweep should
    // produce the breach, not a warning about something that has already failed.
    for (const record of breachCandidates) {
      const claimed = await this.options.store.markBreached(record.id, asOf);
      if (claimed) breached.push(claimed);
    }

    const breachedIds = new Set(breached.map((record) => record.id));

    for (const record of warnCandidates) {
      if (breachedIds.has(record.id)) continue;
      const claimed = await this.options.store.markWarned(record.id, asOf);
      if (claimed) warned.push(claimed);
    }

    return { warned, breached };
  }

  private async require(id: string, organizationId: string): Promise<WorkflowSlaRecord> {
    const record = await this.options.store.findById(id, organizationId);
    if (!record) throw ApiError.notFound();
    return record;
  }
}

/** Renders an SLA for a dashboard cell. */
export function describeSla(
  record: Pick<WorkflowSlaRecord, 'kind' | 'severity' | 'durationSeconds'>,
  evaluation: SlaEvaluation,
): string {
  const label: Record<SlaKind, string> = {
    time_to_acknowledge: 'acknowledge',
    time_to_claim: 'claim',
    time_to_complete: 'complete',
    total_duration: 'total',
  };
  const severity: Record<SlaSeverity, string> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    critical: 'critical',
  };

  const hours = Math.round(record.durationSeconds / 3600);

  if (evaluation.breached) {
    const over = Math.abs(Math.round(evaluation.remainingSeconds / 3600));
    return `${label[record.kind]} (${hours}h, ${severity[record.severity]}): BREACHED by ${over}h`;
  }
  if (evaluation.status === 'paused') {
    return `${label[record.kind]} (${hours}h): paused at ${evaluation.consumedPercent}%`;
  }
  if (evaluation.status === 'completed') {
    return `${label[record.kind]} (${hours}h): met at ${evaluation.consumedPercent}%`;
  }
  const remaining = Math.round(evaluation.remainingSeconds / 3600);
  return `${label[record.kind]} (${hours}h): ${evaluation.consumedPercent}% used, ${remaining}h left`;
}

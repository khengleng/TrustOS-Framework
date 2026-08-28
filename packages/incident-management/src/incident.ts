import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { ServiceRegistry } from '@trustos/sre-core';

/**
 * Incidents.
 *
 * The value of an incident record is almost entirely in what it forces to be written down while
 * it is happening, because none of it is reconstructable afterwards. Two rules do that work:
 *
 * **The timeline is append-only.** Entries carry the time they were recorded and cannot be edited
 * or removed. An editable timeline is a timeline that gets tidied before the review, and the
 * details that get tidied away — the wrong hypothesis pursued for forty minutes, the alert nobody
 * saw — are the ones a postmortem exists to find.
 *
 * **A SEV1 or SEV2 cannot close without a postmortem, and a postmortem cannot be filed without
 * corrective actions that have owners.** An incident that closes with "monitor and see" repeats.
 *
 * What this package deliberately does *not* do is decide severity for you. Severity is a judgement
 * about impact, and a rule that derived it from symptoms would be wrong often enough that people
 * would start overriding it — at which point the recorded severity means nothing.
 */

export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_GUIDANCE: Record<
  Severity,
  { readonly meaning: string; readonly requiresPostmortem: boolean; readonly pages: boolean }
> = {
  SEV1: {
    meaning: 'Customers cannot transact, or money is at risk. Everything else waits.',
    requiresPostmortem: true,
    pages: true,
  },
  SEV2: {
    meaning:
      'A major function is unavailable or a workaround is required. Urgent, not existential.',
    requiresPostmortem: true,
    pages: true,
  },
  SEV3: {
    meaning: 'Degraded or partially impaired. Handled in hours, during working time.',
    requiresPostmortem: false,
    pages: false,
  },
  SEV4: {
    meaning: 'Minor or cosmetic, with no customer impact. Tracked so it is not forgotten.',
    requiresPostmortem: false,
    pages: false,
  },
};

export const INCIDENT_STATES = [
  'detected',
  'investigating',
  'identified',
  'mitigated',
  'resolved',
  'closed',
] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

/**
 * Permitted transitions.
 *
 * Backwards moves are allowed as far as `investigating`, because mitigations fail and re-opening
 * an incident is more honest than opening a second one. What is not allowed is jumping from
 * `detected` to `resolved`: something was done, and the record should say what.
 */
const TRANSITIONS: Record<IncidentState, readonly IncidentState[]> = {
  detected: ['investigating', 'mitigated', 'closed'],
  investigating: ['identified', 'mitigated', 'resolved'],
  identified: ['mitigated', 'investigating'],
  mitigated: ['resolved', 'investigating'],
  resolved: ['closed', 'investigating'],
  closed: [],
};

export const TIMELINE_KINDS = [
  'detection',
  'observation',
  'hypothesis',
  'action',
  'escalation',
  'communication',
  'mitigation',
  'resolution',
  'state_change',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const timelineEntrySchema = z
  .object({
    kind: z.enum(TIMELINE_KINDS),
    /** When it happened — which may be earlier than when somebody got round to writing it down. */
    occurredAt: z.string().datetime(),
    /** When it was written down. Set by the recorder, not by the author. */
    recordedAt: z.string().datetime(),
    actorId: z.string().min(1).max(64),
    note: z.string().min(5).max(2000),
  })
  .strict();

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const correctiveActionSchema = z
  .object({
    actionId: z.string().min(3).max(64),
    description: z.string().min(15).max(1000),
    /** Required. An action nobody owns is a wish. */
    ownerId: z.string().min(1).max(64),
    dueDate: z.string().datetime(),
    /**
     * Whether this action, done, would have prevented the incident or merely detected it sooner.
     * Both are legitimate; a postmortem consisting entirely of `detect_faster` has not found a
     * cause, and stating the kind makes that visible.
     */
    kind: z.enum(['prevent', 'detect_faster', 'mitigate_faster', 'reduce_impact', 'documentation']),
    status: z.enum(['open', 'in_progress', 'done', 'cancelled']).default('open'),
    /** Cancelling is allowed; cancelling silently is not. */
    cancellationReason: z.string().min(10).max(500).nullable().default(null),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.status === 'cancelled' && action.cancellationReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancellationReason'],
        message: 'A cancelled corrective action says why, so the next review can disagree.',
      });
    }
  });

export type CorrectiveAction = z.infer<typeof correctiveActionSchema>;

export const postmortemSchema = z
  .object({
    summary: z.string().min(50).max(5000),
    /** What actually happened, in sequence. */
    whatHappened: z.string().min(50).max(10_000),
    /**
     * Why it happened. Blameless by construction: the schema asks about the *conditions* that made
     * the failure possible, which is a question about the system.
     */
    contributingFactors: z.array(z.string().min(15).max(1000)).min(1),
    /** What went well. Omitted in practice unless asked for, and it is the part that gets repeated. */
    whatWentWell: z.array(z.string().min(10).max(500)).default([]),
    customerImpact: z.string().min(15).max(2000),
    /** Duration of impact, not of the incident record. */
    impactMinutes: z.number().int().nonnegative(),
    correctiveActions: z.array(correctiveActionSchema).min(1),
    authorId: z.string().min(1).max(64),
    reviewedBy: z.array(z.string().min(1).max(64)).default([]),
    filedAt: z.string().datetime(),
  })
  .strict();

export type Postmortem = z.infer<typeof postmortemSchema>;

export const incidentSchema = z
  .object({
    incidentId: z.string().min(3).max(64),
    title: z.string().min(10).max(200),
    severity: z.enum(SEVERITIES),
    state: z.enum(INCIDENT_STATES).default('detected'),
    /** The incident commander. One person, named, from the moment it is declared. */
    ownerId: z.string().min(1).max(64),
    affectedServiceIds: z.array(z.string().min(3).max(64)).min(1),
    affectedProducts: z.array(z.string().min(1).max(120)).default([]),
    /** Stated in terms of what customers cannot do, not of which component is red. */
    impact: z.string().min(15).max(2000),
    detectedAt: z.string().datetime(),
    /** How it was found. `customer_report` for a tier-1 service is itself a finding. */
    detectionSource: z.enum([
      'alert',
      'customer_report',
      'internal_report',
      'routine_check',
      'unknown',
    ]),
    mitigatedAt: z.string().datetime().nullable().default(null),
    resolvedAt: z.string().datetime().nullable().default(null),
    mitigation: z.string().min(10).max(2000).nullable().default(null),
    resolution: z.string().min(10).max(2000).nullable().default(null),
    timeline: z.array(timelineEntrySchema).default([]),
    postmortem: postmortemSchema.nullable().default(null),
    organizationId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict();

export type Incident = z.infer<typeof incidentSchema>;

export interface IncidentSink {
  save(incident: Incident): Promise<void>;
}

export class InMemoryIncidentSink implements IncidentSink {
  readonly incidents = new Map<string, Incident>();

  async save(incident: Incident): Promise<void> {
    this.incidents.set(incident.incidentId, incident);
  }
}

/**
 * The incident manager.
 *
 * Every mutation returns a new incident rather than editing one in place, which is what makes the
 * append-only timeline structural rather than a convention somebody remembers to follow.
 */
export class IncidentManager {
  constructor(
    private readonly deps: {
      sink: IncidentSink;
      registry?: Pick<ServiceRegistry, 'require' | 'dependents'>;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async declare(input: {
    incidentId: string;
    title: string;
    severity: Severity;
    ownerId: string;
    affectedServiceIds: string[];
    impact: string;
    detectionSource: Incident['detectionSource'];
    detectedAt?: string;
    affectedProducts?: string[];
    organizationId?: string | null;
  }): Promise<Incident> {
    const products = new Set(input.affectedProducts ?? []);

    if (this.deps.registry) {
      for (const serviceId of input.affectedServiceIds) {
        const service = this.deps.registry.require(serviceId);
        for (const product of service.supportsProducts) products.add(product);
      }
    }

    const detectedAt = input.detectedAt ?? this.now().toISOString();

    const incident = incidentSchema.parse({
      incidentId: input.incidentId,
      title: input.title,
      severity: input.severity,
      state: 'detected',
      ownerId: input.ownerId,
      affectedServiceIds: input.affectedServiceIds,
      affectedProducts: [...products],
      impact: input.impact,
      detectedAt,
      detectionSource: input.detectionSource,
      organizationId: input.organizationId ?? null,
      timeline: [
        {
          kind: 'detection',
          occurredAt: detectedAt,
          recordedAt: this.now().toISOString(),
          actorId: input.ownerId,
          note: `Declared ${input.severity} via ${input.detectionSource}: ${input.impact}`,
        },
      ],
    });

    await this.deps.sink.save(incident);
    return incident;
  }

  /** Append to the timeline. There is no corresponding edit or remove, deliberately. */
  async note(
    incident: Incident,
    entry: { kind: TimelineKind; actorId: string; note: string; occurredAt?: string },
  ): Promise<Incident> {
    if (incident.state === 'closed') {
      throw ApiError.conflict(
        `Incident ${incident.incidentId} is closed. Re-open it to add to the record rather than amending it silently.`,
      );
    }

    const recordedAt = this.now().toISOString();
    const next: Incident = {
      ...incident,
      timeline: [
        ...incident.timeline,
        timelineEntrySchema.parse({
          kind: entry.kind,
          occurredAt: entry.occurredAt ?? recordedAt,
          recordedAt,
          actorId: entry.actorId,
          note: entry.note,
        }),
      ],
    };

    await this.deps.sink.save(next);
    return next;
  }

  /**
   * Change severity.
   *
   * Always permitted — the first assessment is made with the least information anyone will have —
   * but never silently: the reason lands on the timeline.
   */
  async reassess(
    incident: Incident,
    input: { severity: Severity; actorId: string; reason: string },
  ): Promise<Incident> {
    if (input.severity === incident.severity) return incident;

    const noted = await this.note(incident, {
      kind: 'state_change',
      actorId: input.actorId,
      note: `Severity ${incident.severity} → ${input.severity}: ${input.reason}`,
    });

    const next = { ...noted, severity: input.severity };
    await this.deps.sink.save(next);
    return next;
  }

  async transition(
    incident: Incident,
    input: {
      to: IncidentState;
      actorId: string;
      note: string;
      mitigation?: string;
      resolution?: string;
      at?: string;
    },
  ): Promise<Incident> {
    if (!TRANSITIONS[incident.state].includes(input.to)) {
      throw ApiError.conflict(`An incident does not move from ${incident.state} to ${input.to}.`, {
        permitted: TRANSITIONS[incident.state],
      });
    }

    if (input.to === 'mitigated' && !input.mitigation) {
      throw ApiError.validation(
        [{ path: 'mitigation', message: 'Say what was done to mitigate it.' }],
        'A mitigation without a description cannot be reused next time.',
      );
    }

    if (input.to === 'resolved' && !input.resolution) {
      throw ApiError.validation(
        [{ path: 'resolution', message: 'Say what resolved it.' }],
        'A resolution without a description cannot be reused next time.',
      );
    }

    if (input.to === 'closed') {
      this.assertClosable(incident);
    }

    const at = input.at ?? this.now().toISOString();

    const noted = await this.note(incident, {
      kind:
        input.to === 'mitigated'
          ? 'mitigation'
          : input.to === 'resolved'
            ? 'resolution'
            : 'state_change',
      actorId: input.actorId,
      note: `${incident.state} → ${input.to}: ${input.note}`,
      occurredAt: at,
    });

    const next: Incident = {
      ...noted,
      state: input.to,
      mitigatedAt: input.to === 'mitigated' ? at : noted.mitigatedAt,
      resolvedAt: input.to === 'resolved' ? at : noted.resolvedAt,
      mitigation: input.mitigation ?? noted.mitigation,
      resolution: input.resolution ?? noted.resolution,
    };

    await this.deps.sink.save(next);
    return next;
  }

  /**
   * The gate.
   *
   * A SEV1 or SEV2 closes only with a postmortem carrying owned corrective actions. This is the
   * one place the package refuses something an operator wants to do, and it refuses it because
   * "monitor and see" is how the same incident happens twice.
   */
  private assertClosable(incident: Incident): void {
    if (!SEVERITY_GUIDANCE[incident.severity].requiresPostmortem) return;

    if (incident.postmortem === null) {
      throw ApiError.conflict(
        `A ${incident.severity} closes with a postmortem. Without one, the only record of what happened is the timeline, and nobody reads a timeline.`,
      );
    }

    const unowned = incident.postmortem.correctiveActions.filter(
      (action) => action.status === 'open' && action.ownerId.trim() === '',
    );

    if (unowned.length > 0) {
      throw ApiError.conflict('Every corrective action names an owner.');
    }
  }

  async filePostmortem(
    incident: Incident,
    postmortem: Postmortem,
    actorId: string,
  ): Promise<Incident> {
    if (incident.state !== 'resolved' && incident.state !== 'closed') {
      throw ApiError.conflict('A postmortem is filed once the incident is resolved.');
    }

    const noted = await this.note(incident, {
      kind: 'communication',
      actorId,
      note: `Postmortem filed with ${postmortem.correctiveActions.length} corrective action(s).`,
    });

    const next = { ...noted, postmortem };
    await this.deps.sink.save(next);
    return next;
  }
}

export interface IncidentMetrics {
  /** Detection to mitigation — how long customers were affected. */
  readonly timeToMitigateMinutes: number | null;
  /** Detection to resolution. */
  readonly timeToResolveMinutes: number | null;
  /**
   * Whether a customer found it before monitoring did. For a tier-1 service this is the single
   * most useful number in the review, and it is a fact rather than an opinion.
   */
  readonly customerDetected: boolean;
}

export function incidentMetrics(incident: Incident): IncidentMetrics {
  const detected = Date.parse(incident.detectedAt);
  const minutes = (iso: string | null): number | null =>
    iso === null ? null : Math.round((Date.parse(iso) - detected) / 60_000);

  return {
    timeToMitigateMinutes: minutes(incident.mitigatedAt),
    timeToResolveMinutes: minutes(incident.resolvedAt),
    customerDetected: incident.detectionSource === 'customer_report',
  };
}

/**
 * Corrective actions across incidents that are open and past due.
 *
 * The list nobody maintains and everybody needs: postmortem actions decay quietly, and the same
 * incident recurs while its prevention sits at 20% done.
 */
export function overdueActions(
  incidents: readonly Incident[],
  asOf: Date,
): Array<{ incidentId: string; action: CorrectiveAction; daysOverdue: number }> {
  const results: Array<{ incidentId: string; action: CorrectiveAction; daysOverdue: number }> = [];

  for (const incident of incidents) {
    for (const action of incident.postmortem?.correctiveActions ?? []) {
      if (action.status === 'done' || action.status === 'cancelled') continue;

      const due = Date.parse(action.dueDate);
      if (asOf.getTime() <= due) continue;

      results.push({
        incidentId: incident.incidentId,
        action,
        daysOverdue: Math.floor((asOf.getTime() - due) / 86_400_000),
      });
    }
  }

  return results.sort((left, right) => right.daysOverdue - left.daysOverdue);
}

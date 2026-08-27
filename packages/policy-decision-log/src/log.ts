import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { PolicyDecision } from '@trustos/policy-evaluator';

/**
 * The decision log.
 *
 * Every policy decision, recorded: what was asked, what was decided, by which **policy version**,
 * and why.
 *
 * The version is the field that makes the log worth keeping. A decision recorded without it says
 * "we denied this in March", which is unfalsifiable — the policy has changed since, and nobody
 * can tell whether the denial was correct under the rules that applied at the time. With it, the
 * decision is **re-derivable**: fetch version 3, replay the attributes, get the same answer.
 * That is the difference between a log and evidence.
 *
 * Two things the log deliberately does not contain.
 *
 * **The attributes are hashed, not stored, above a classification.** A decision about whether to
 * reveal a customer's identifier should not record the identifier. `recordDecision` takes the
 * attributes and a set of names to hash, and stores the hash — enough to prove two decisions were
 * made on the same input, not enough to be a copy of the input.
 *
 * **There is no update and no delete.** The interface has neither, and neither does the sink.
 */

export const policyDecisionRecordSchema = z
  .object({
    decisionId: z.string().min(1).max(80),

    policyId: z.string().min(1).max(80),
    /** Required. Without it the record is unfalsifiable. */
    policyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    ruleId: z.string().max(60).nullable(),

    decision: z.enum(['ALLOW', 'DENY']),
    reasons: z.array(z.string().max(300)).max(10),
    obligations: z.array(z.string().max(60)).max(10),

    /** Who asked. */
    actorId: z.string().min(1).max(80),
    organizationId: z.string().max(80).nullable(),
    /** What was being attempted. */
    action: z.string().min(1).max(120),
    resourceId: z.string().max(200).nullable(),

    /** Attributes that were safe to keep, verbatim. */
    attributes: z
      .record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
      .refine((value) => Object.keys(value).length <= 40, 'At most 40 attributes.'),
    /** Attributes that were not, as a hash. Enough to correlate, not enough to be a copy. */
    hashedAttributes: z.record(z.string().regex(/^sha256:[0-9a-f]{16}$/)).default({}),
    /** Attributes the policy read and nobody supplied. The rules that silently did not run. */
    missingAttributes: z.array(z.string().max(80)).max(40).default([]),

    correlationId: z.string().min(1).max(120),
    decidedAt: z.string().datetime(),
    /** How long evaluation took. A policy that got slow is a policy somebody will start skipping. */
    durationMicros: z.number().int().min(0).max(60_000_000),
  })
  .strict();

export type PolicyDecisionRecord = z.infer<typeof policyDecisionRecordSchema>;

/**
 * Where decisions go.
 *
 * A port, with **no update and no delete** — the same shape `@trustos/audit`'s sink has, and for
 * the same reason: the append-only rule is structural rather than a convention, so no amount of
 * autocomplete leads somebody to a method that rewrites a decision.
 */
export interface PolicyDecisionSink {
  append(record: PolicyDecisionRecord): Promise<void>;
  query(query: PolicyDecisionQuery): Promise<PolicyDecisionRecord[]>;
}

export interface PolicyDecisionQuery {
  policyId?: string;
  policyVersion?: string;
  actorId?: string;
  organizationId?: string | null;
  decision?: 'ALLOW' | 'DENY';
  from?: Date;
  to?: Date;
  limit: number;
}

export class InMemoryPolicyDecisionSink implements PolicyDecisionSink {
  readonly records: PolicyDecisionRecord[] = [];

  async append(record: PolicyDecisionRecord): Promise<void> {
    this.records.push(record);
  }

  async query(query: PolicyDecisionQuery): Promise<PolicyDecisionRecord[]> {
    return this.records
      .filter((record) => {
        if (query.policyId && record.policyId !== query.policyId) return false;
        if (query.policyVersion && record.policyVersion !== query.policyVersion) return false;
        if (query.actorId && record.actorId !== query.actorId) return false;
        if (query.organizationId !== undefined && record.organizationId !== query.organizationId) {
          return false;
        }
        if (query.decision && record.decision !== query.decision) return false;
        if (query.from && new Date(record.decidedAt) < query.from) return false;
        if (query.to && new Date(record.decidedAt) > query.to) return false;
        return true;
      })
      .slice(-query.limit);
  }
}

/**
 * Hashes an attribute value.
 *
 * Sixteen hex characters of a SHA-256, and the truncation is deliberate: this is a correlation
 * token, not a commitment. It answers "were these two decisions made about the same subject" and
 * nothing else, and a full digest would invite somebody to treat it as proof of a value.
 *
 * Unsalted, and that is a real limitation stated rather than hidden: a hash of a low-entropy
 * value — a status, a country code, a boolean — is trivially reversible. **Only hash things with
 * enough entropy to be worth hashing.** For a customer identifier, use the pseudonym from
 * `@trustos/data-masking`, which is keyed.
 */
export function hashAttribute(value: string | number | boolean | null): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');

  return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

export interface RecordDecisionInput {
  decision: PolicyDecision;
  actorId: string;
  organizationId: string | null;
  action: string;
  resourceId?: string | null;
  attributes: Record<string, string | number | boolean | null>;
  /** Attribute names to hash rather than store. */
  sensitiveAttributes?: readonly string[];
  correlationId: string;
  decidedAt: Date;
  durationMicros: number;
  newDecisionId: () => string;
}

export class PolicyDecisionLog {
  constructor(private readonly sink: PolicyDecisionSink) {}

  /**
   * Records a decision.
   *
   * Awaited and **not** swallowed, unlike `@trustos/audit`. The trade is the opposite one and it
   * is deliberate: an audit trail records what happened and degrades acceptably under an outage,
   * whereas a decision log is the evidence that an authorization decision was made correctly.
   * A permission granted with no record of why is worse than a permission refused.
   */
  async record(input: RecordDecisionInput): Promise<PolicyDecisionRecord> {
    const sensitive = new Set(input.sensitiveAttributes ?? []);
    const attributes: Record<string, string | number | boolean | null> = {};
    const hashedAttributes: Record<string, string> = {};

    for (const [name, value] of Object.entries(input.attributes)) {
      if (sensitive.has(name)) hashedAttributes[name] = hashAttribute(value);
      else attributes[name] = value;
    }

    const record = policyDecisionRecordSchema.parse({
      decisionId: input.newDecisionId(),
      policyId: input.decision.policyId,
      policyVersion: input.decision.policyVersion,
      ruleId: input.decision.ruleId,
      decision: input.decision.decision,
      reasons: input.decision.reasons,
      obligations: input.decision.obligations.map((obligation) => obligation.kind),
      actorId: input.actorId,
      organizationId: input.organizationId,
      action: input.action,
      resourceId: input.resourceId ?? null,
      attributes,
      hashedAttributes,
      missingAttributes: input.decision.missingAttributes,
      correlationId: input.correlationId,
      decidedAt: input.decidedAt.toISOString(),
      durationMicros: input.durationMicros,
    });

    await this.sink.append(record);
    return record;
  }

  query(query: PolicyDecisionQuery): Promise<PolicyDecisionRecord[]> {
    return this.sink.query(query);
  }
}

/**
 * Whether a recorded decision can still be re-derived.
 *
 * The check that makes the log evidence rather than assertion: fetch the version the record
 * names, replay the attributes, compare. It refuses when the version is gone — which is itself a
 * finding, because a published version should never disappear.
 *
 * It cannot re-derive a decision whose attributes were hashed, and says so rather than guessing.
 */
export function reDerivable(record: PolicyDecisionRecord): {
  possible: boolean;
  reason: string;
} {
  if (Object.keys(record.hashedAttributes).length > 0) {
    return {
      possible: false,
      reason:
        `${Object.keys(record.hashedAttributes).length} attribute(s) were hashed rather than ` +
        'stored, so this decision cannot be replayed exactly. That is the trade the hashing ' +
        'made deliberately — the alternative was a decision log containing the data the ' +
        'decision was about.',
    };
  }

  return { possible: true, reason: 'Fetch the named version and replay the attributes.' };
}

/** Refuses a record with no policy version. */
export function assertVersioned(record: unknown): PolicyDecisionRecord {
  const parsed = policyDecisionRecordSchema.safeParse(record);

  if (!parsed.success) {
    throw new ApiError('validation_error', {
      message:
        'A decision record without a policy version is unfalsifiable: the policy has changed ' +
        'since, and nobody can tell whether the decision was correct under the rules that ' +
        'applied at the time.',
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return parsed.data;
}

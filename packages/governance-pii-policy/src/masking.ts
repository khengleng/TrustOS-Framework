import { z } from 'zod';
import { ApiError } from '@trustos/errors';

/**
 * Masking, and controlled reveal.
 *
 * Two rules shape everything here.
 *
 * **Masking happens server-side.** A value that reaches the browser masked was masked before it
 * left; a value masked in CSS is in the payload, in the network tab, and in every screenshot
 * anybody takes. The masking functions below are pure and are called by the runtime on the way
 * out — there is no client-side mask in this layer, and adding one would be adding the illusion
 * of the control rather than the control.
 *
 * **A reveal is an event, not a state.** It has a requester, a reason, a subject, an expiry and
 * an audit record. It is not a permission somebody holds and then has; it is something that
 * happened at a time, for a stated purpose, and stopped. That shape is what makes "who looked at
 * this customer's phone number, and why" answerable — and it is the question that gets asked
 * after a customer complains that somebody knew something they should not have.
 *
 * The masks keep a **suffix** rather than a prefix, for everything except an email. A support
 * agent reading a number back to a customer needs the last four digits; nobody needs the first
 * four, and the first four of a card number identify the issuer.
 */

export const MASK_STRATEGIES = [
  'full',
  'partial_suffix',
  'partial_prefix',
  'email',
  'hash',
  'redact',
] as const;

export type MaskStrategy = (typeof MASK_STRATEGIES)[number];

export const maskRuleSchema = z
  .object({
    /** The field this applies to, by normalized name. */
    field: z.string().min(1).max(80),
    strategy: z.enum(MASK_STRATEGIES),
    /** Characters kept for a partial mask. Bounded, because "keep 12" is not a mask. */
    keep: z.number().int().min(1).max(6).default(3),
    /**
     * Whether this field may ever be revealed.
     *
     * `false` for anything whose plaintext has no operational use. A government identifier is
     * usually verified rather than read, and a field nobody needs to read is a field that should
     * not have a reveal path at all.
     */
    revealable: z.boolean().default(true),
    /** Whether a reveal needs a second person. */
    revealRequiresApproval: z.boolean().default(false),
    description: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.strategy === 'hash' && rule.revealable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['revealable'],
        message:
          'A hashed field cannot be revealed — the plaintext is not stored. Marking it revealable ' +
          'promises something no code path can deliver.',
      });
    }
  });

export type MaskRule = z.infer<typeof maskRuleSchema>;

/** The masks. Pure, and applied server-side on the way out. */
export function mask(value: string | null | undefined, rule: MaskRule): string {
  if (value === null || value === undefined || value === '') return '';

  switch (rule.strategy) {
    case 'full':
      return '•'.repeat(Math.min(value.length, 12));

    case 'partial_suffix': {
      // The last few characters, because a support agent reads a number *back* to somebody.
      const kept = value.slice(-rule.keep);
      return `${'•'.repeat(Math.max(value.length - rule.keep, 3))}${kept}`;
    }

    case 'partial_prefix': {
      const kept = value.slice(0, rule.keep);
      return `${kept}${'•'.repeat(Math.max(value.length - rule.keep, 3))}`;
    }

    case 'email': {
      const at = value.indexOf('@');
      if (at <= 0) return '•'.repeat(Math.min(value.length, 12));
      const local = value.slice(0, at);
      const domain = value.slice(at);
      return `${local.slice(0, 1)}${'•'.repeat(Math.max(local.length - 1, 3))}${domain}`;
    }

    case 'hash':
      /*
       * A stable rendering, not a cryptographic commitment.
       *
       * Enough to tell two rows apart and correlate them across a screen; not enough to recover
       * the value, and not offered as proof of anything. Anywhere a real hash is needed, use
       * `correlationHash` from the logging package, which is salted.
       */
      return `#${[...value]
        .reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 7)
        .toString(16)
        .padStart(8, '0')}`;

    case 'redact':
      return '[redacted]';
  }
}

/**
 * The default rules.
 *
 * A starting point, and deliberately conservative: everything identifying is masked, and the two
 * fields whose plaintext has no operational use are not revealable at all.
 */
export const DEFAULT_MASK_RULES: readonly MaskRule[] = Object.freeze(
  [
    {
      field: 'phone',
      strategy: 'partial_suffix',
      keep: 3,
      description: 'Read back to a customer, so the suffix is what matters.',
    },
    { field: 'mobile', strategy: 'partial_suffix', keep: 3 },
    { field: 'email', strategy: 'email' },
    { field: 'accountNumber', strategy: 'partial_suffix', keep: 4 },
    { field: 'cardNumber', strategy: 'partial_suffix', keep: 4, revealRequiresApproval: true },
    { field: 'iban', strategy: 'partial_suffix', keep: 4, revealRequiresApproval: true },
    {
      field: 'governmentId',
      strategy: 'full',
      revealable: false,
      description: 'Verified rather than read. A field nobody needs to read needs no reveal path.',
    },
    {
      field: 'dateOfBirth',
      strategy: 'full',
      revealable: false,
      description: 'Used to match, not to display.',
    },
    { field: 'fullName', strategy: 'partial_prefix', keep: 1 },
    { field: 'address', strategy: 'redact', revealRequiresApproval: true },
  ].map((rule) => maskRuleSchema.parse(rule)),
);

/** Rules indexed by normalized field name. */
export class MaskPolicy {
  private readonly rules = new Map<string, MaskRule>();

  constructor(rules: readonly MaskRule[] = DEFAULT_MASK_RULES) {
    for (const rule of rules) this.rules.set(normalize(rule.field), rule);
  }

  ruleFor(field: string): MaskRule | undefined {
    return this.rules.get(normalize(field));
  }

  /**
   * Masks a row.
   *
   * Every field with a rule is masked; every field without one is passed through. That direction
   * is a deliberate choice and worth naming: an allow-list would be safer and would mean a new
   * column is invisible until somebody adds a rule, which is how a console silently loses a field
   * and somebody works around it by exporting instead.
   *
   * The safety net that makes it acceptable is `isForbiddenField` in
   * `@trustos/governance-tool-core`, which refuses credential-shaped columns at registration —
   * so what passes through unmasked is business data, not a secret.
   */
  maskRow(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(row)) {
      const rule = this.ruleFor(field);
      masked[field] = rule && typeof value === 'string' ? mask(value, rule) : value;
    }

    return masked;
  }

  /** Which fields in a row would be masked. What the UI uses to render a reveal affordance. */
  maskedFields(row: Readonly<Record<string, unknown>>): string[] {
    return Object.keys(row).filter((field) => this.ruleFor(field) !== undefined);
  }
}

function normalize(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- reveal -----------------------------------------------------------------

export const revealRequestSchema = z
  .object({
    requestId: z.string().min(1).max(80),
    actorId: z.string().min(1).max(80),
    organizationId: z.string().min(1).max(80),
    /** What is being revealed, and about whom. */
    resourceId: z.string().min(1).max(120),
    subjectRef: z.string().min(1).max(120),
    fields: z.array(z.string().min(1).max(80)).min(1).max(10),
    /**
     * Why.
     *
     * At least twenty characters, and that floor is not arbitrary: "support" and "checking" are
     * what a free-text reason field collects, and neither answers the question the field exists
     * for. Twenty characters is roughly one clause.
     */
    reason: z.string().min(20).max(500),
    /** The case or ticket this belongs to. Optional, and the first thing an investigation looks for. */
    caseRef: z.string().max(120).optional(),
    requestedAt: z.string().datetime(),
    /** When the reveal stops working. Bounded by the policy below. */
    expiresAt: z.string().datetime(),
    status: z.enum(['pending_approval', 'granted', 'denied', 'expired']),
    approvedBy: z.string().max(80).nullable(),
  })
  .strict();

export type RevealRequest = z.infer<typeof revealRequestSchema>;

/**
 * The longest a reveal may last.
 *
 * Fifteen minutes. Long enough for a support call, short enough that a granted reveal is not a
 * standing grant — which is what an eight-hour window would be, and what "for the session" always
 * becomes.
 */
export const MAX_REVEAL_WINDOW_MS = 15 * 60 * 1000;

export interface RevealDecision {
  granted: boolean;
  /** Fields actually revealed. A request for a non-revealable field is narrowed, not refused whole. */
  fields: string[];
  /** Fields refused, with the reason each was refused. */
  refused: Array<{ field: string; reason: string }>;
  requiresApproval: boolean;
  expiresAt: Date;
}

export interface EvaluateRevealInput {
  policy: MaskPolicy;
  fields: readonly string[];
  /** Whether the actor holds `governance.pii.reveal`. Resolved server-side. */
  hasRevealPermission: boolean;
  /** Whether an approval has already been recorded for this request. */
  approved: boolean;
  now: Date;
  windowMs?: number;
}

/**
 * Decides what a reveal request actually reveals.
 *
 * Narrows rather than refuses: a request for three fields where one is not revealable returns the
 * two and says why the third was refused. Refusing the whole request would train people to ask
 * for one field at a time, which produces more reveals and less context in each audit record.
 */
export function evaluateReveal(input: EvaluateRevealInput): RevealDecision {
  const windowMs = Math.min(input.windowMs ?? MAX_REVEAL_WINDOW_MS, MAX_REVEAL_WINDOW_MS);
  const expiresAt = new Date(input.now.getTime() + windowMs);

  if (!input.hasRevealPermission) {
    return {
      granted: false,
      fields: [],
      refused: input.fields.map((field) => ({
        field,
        reason: 'The actor does not hold governance.pii.reveal.',
      })),
      requiresApproval: false,
      expiresAt,
    };
  }

  const fields: string[] = [];
  const refused: Array<{ field: string; reason: string }> = [];
  let requiresApproval = false;

  for (const field of input.fields) {
    const rule = input.policy.ruleFor(field);

    if (!rule) {
      // Not masked, so there is nothing to reveal. Reported rather than silently granted, so a
      // caller does not build a flow around revealing a field that was never hidden.
      refused.push({ field, reason: 'This field is not masked, so there is nothing to reveal.' });
      continue;
    }

    if (!rule.revealable) {
      refused.push({
        field,
        reason: 'This field is never revealed. Its plaintext has no operational use.',
      });
      continue;
    }

    if (rule.revealRequiresApproval && !input.approved) {
      requiresApproval = true;
      refused.push({ field, reason: 'This field needs a second person to approve the reveal.' });
      continue;
    }

    fields.push(field);
  }

  return { granted: fields.length > 0, fields, refused, requiresApproval, expiresAt };
}

/** Whether a granted reveal is still live. Checked on every read, not once at grant. */
export function revealIsLive(request: RevealRequest, now: Date): boolean {
  return request.status === 'granted' && new Date(request.expiresAt) > now;
}

/** Refuses a reveal that has lapsed. */
export function assertRevealLive(request: RevealRequest, now: Date): void {
  if (revealIsLive(request, now)) return;

  throw new ApiError('forbidden', {
    message:
      request.status === 'granted'
        ? 'This reveal has expired. Request another one, with a reason.'
        : `This reveal is ${request.status}.`,
    context: { requestId: request.requestId, status: request.status },
  });
}

/** The audit record a reveal produces. Every field of it is required. */
export function revealAuditDetail(
  request: RevealRequest,
  decision: RevealDecision,
): Record<string, string | number | boolean | null> {
  return {
    requestId: request.requestId,
    actorId: request.actorId,
    subjectRef: request.subjectRef,
    resourceId: request.resourceId,
    /* The field *names*, never the values. An audit record of a reveal must not itself be a reveal. */
    fieldsRevealed: decision.fields.join(','),
    fieldsRefused: decision.refused.map((entry) => entry.field).join(','),
    reason: request.reason,
    caseRef: request.caseRef ?? null,
    expiresAt: decision.expiresAt.toISOString(),
    approvedBy: request.approvedBy,
  };
}

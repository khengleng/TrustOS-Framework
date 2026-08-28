import { z } from 'zod';
import { productError } from './errors';

/**
 * The global business data profile.
 *
 * Centrally governed reference data — currencies, countries, transaction types, customer types,
 * merchant categories, fee and limit types, risk levels, approval levels, settlement calendars.
 * Products reference a *code* in here rather than carrying a literal.
 *
 * The failure this prevents is not a crash. It is four applications that each decided
 * independently what "GOLD" means, three of which now disagree with the fourth about which
 * merchants get 0.5%. Nothing errors; the revenue is simply wrong, and it is wrong in a
 * spreadsheet six months later.
 *
 * Two properties make it a control rather than a lookup table:
 *
 *   * **An unknown code is a refusal, not a default.** `require` throws. A registry that
 *     returned `undefined` would push the decision to the caller, and half the callers would
 *     treat it as "no restriction".
 *   * **A retired code stays.** Entries are deprecated with an end date, never deleted, because
 *     a product published last year still references them and re-pricing last year's invoice has
 *     to reach the same number.
 *
 * The framework seeds the domains whose values are *structural* — risk levels, approval levels,
 * lifecycle statuses, fee and limit shapes. It deliberately seeds no currency, country or
 * merchant category: those are a deployment's own, and a framework that shipped a list would
 * ship a list somebody has to override on the first day.
 */

export const REFERENCE_DOMAINS = [
  'currency',
  'country',
  'transactionType',
  'customerType',
  'merchantCategory',
  'feeType',
  'limitType',
  'riskLevel',
  'productStatus',
  'approvalLevel',
  'settlementCalendar',
  'holidayCalendar',
  'channel',
  'providerInterface',
] as const;

export type ReferenceDomain = (typeof REFERENCE_DOMAINS)[number];

/**
 * A reference code.
 *
 * Upper snake case, bounded. Narrow on purpose: these end up in URLs, in report column headers
 * and in a partner's integration code, and a code containing a space or a slash is a code that
 * breaks one of the three.
 */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;

export const referenceEntrySchema = z
  .object({
    domain: z.enum(REFERENCE_DOMAINS),
    code: z.string().regex(CODE_PATTERN, 'Upper snake case, starting with a letter.'),
    label: z.string().min(1).max(120),
    description: z.string().max(400).optional(),
    /**
     * Domain-specific facts. Bounded scalars only — no nested objects, because a reference entry
     * that can hold a structure becomes a second configuration system, and the second one has no
     * schema.
     */
    attributes: z
      .record(z.union([z.string().max(200), z.number(), z.boolean()]))
      .refine((value) => Object.keys(value).length <= 20, 'At most 20 attributes.')
      .optional(),
    status: z.enum(['active', 'deprecated']).default('active'),
    /** When the code became usable, and when it stopped. Both inclusive of the whole day. */
    effectiveFrom: z.string().datetime().optional(),
    effectiveTo: z.string().datetime().optional(),
    /** What to use instead. Required when deprecated — a deprecation with no successor is a dead end. */
    supersededBy: z.string().regex(CODE_PATTERN).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.status === 'deprecated' && !entry.supersededBy && !entry.effectiveTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message:
          'A deprecated reference code needs either a successor or an end date. Without one, ' +
          'every product referencing it is told to stop and not told what to do instead.',
      });
    }
  });

export type ReferenceEntry = z.infer<typeof referenceEntrySchema>;

/**
 * The registry.
 *
 * In memory and immutable once built. There is no remote fetch and no lazy load: reference data
 * decides fees and limits, and a fee that depends on a network call is a fee that is different
 * during an incident.
 */
export class ReferenceDataRegistry {
  private readonly entries = new Map<string, ReferenceEntry>();

  constructor(entries: ReferenceEntry[] = []) {
    for (const entry of entries) this.register(entry);
  }

  /**
   * Adds an entry.
   *
   * Refuses a duplicate rather than overwriting. An overwrite is how two seed files silently
   * disagree and the load order decides which one wins — and load order is the last thing anybody
   * checks.
   */
  register(input: unknown): ReferenceEntry {
    const entry = referenceEntrySchema.parse(input);
    const key = keyOf(entry.domain, entry.code);

    if (this.entries.has(key)) {
      throw productError(
        'product_definition_invalid',
        `Reference code ${entry.domain}/${entry.code} is already registered. Change the ` +
          'existing entry rather than registering a second one; two entries mean load order ' +
          'decides which definition applies.',
        { expected: 'a unique code', actual: entry.code },
      );
    }

    this.entries.set(key, entry);
    return entry;
  }

  get(domain: ReferenceDomain, code: string): ReferenceEntry | undefined {
    return this.entries.get(keyOf(domain, code));
  }

  /** The code, or a refusal naming the domain. Used everywhere a definition is validated. */
  require(domain: ReferenceDomain, code: string): ReferenceEntry {
    const entry = this.get(domain, code);
    if (!entry) {
      throw productError(
        'product_reference_unknown',
        `Unknown ${domain} code "${code}". Reference data is centrally governed: register the ` +
          'code before a product uses it, rather than letting the product define its own.',
        { expected: domain, actual: code },
      );
    }
    return entry;
  }

  /**
   * The code, refusing one that is not usable at a given instant.
   *
   * Separate from `require` because the two questions differ: composing a product asks "does this
   * code exist", and executing one asks "was this code live when the transaction started". A
   * product published while a code was active keeps working; a *new* product may not adopt a code
   * that has already ended.
   */
  requireEffective(domain: ReferenceDomain, code: string, at: Date): ReferenceEntry {
    const entry = this.require(domain, code);

    if (entry.effectiveFrom && at < new Date(entry.effectiveFrom)) {
      throw productError(
        'product_reference_unknown',
        `The ${domain} code "${code}" is not effective until ${entry.effectiveFrom}.`,
        { expected: entry.effectiveFrom, actual: at.toISOString() },
      );
    }

    if (entry.effectiveTo && at > new Date(entry.effectiveTo)) {
      throw productError(
        'product_reference_unknown',
        `The ${domain} code "${code}" stopped being effective on ${entry.effectiveTo}` +
          (entry.supersededBy ? `. Use "${entry.supersededBy}".` : '.'),
        { expected: entry.supersededBy ?? 'an active code', actual: code },
      );
    }

    return entry;
  }

  list(domain: ReferenceDomain): ReferenceEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.domain === domain)
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  domains(): ReferenceDomain[] {
    return REFERENCE_DOMAINS.filter((domain) => this.list(domain).length > 0);
  }

  size(): number {
    return this.entries.size;
  }
}

function keyOf(domain: ReferenceDomain, code: string): string {
  return `${domain}:${code}`;
}

function entry(
  domain: ReferenceDomain,
  code: string,
  label: string,
  description: string,
): ReferenceEntry {
  return referenceEntrySchema.parse({ domain, code, label, description });
}

/**
 * The structural seeds.
 *
 * These are the domains whose values are part of how the layer *works* rather than part of what a
 * deployment sells. A risk level of `HIGH` means the same thing in every deployment because the
 * runtime routes on it; a merchant category does not, and is therefore absent.
 */
export const STRUCTURAL_REFERENCE_DATA: ReferenceEntry[] = [
  entry('riskLevel', 'LOW', 'Low', 'Proceeds without additional review.'),
  entry('riskLevel', 'MEDIUM', 'Medium', 'Proceeds; recorded for periodic sampling.'),
  entry('riskLevel', 'HIGH', 'High', 'Requires enhanced review before completion.'),
  entry('riskLevel', 'PROHIBITED', 'Prohibited', 'Refused outright, with an audit record.'),

  entry('approvalLevel', 'PRODUCT_OWNER', 'Product owner', 'Owns the product and its commercials.'),
  entry('approvalLevel', 'RISK', 'Risk', 'Reviews limits, exposure and the risk policy.'),
  entry('approvalLevel', 'COMPLIANCE', 'Compliance', 'Reviews screening, KYC and retention.'),
  entry('approvalLevel', 'SECURITY', 'Security', 'Reviews connectors, secrets and API exposure.'),
  entry(
    'approvalLevel',
    'OPERATIONS',
    'Operations',
    'Reviews settlement, reconciliation and SLAs.',
  ),
  entry('approvalLevel', 'FINANCE', 'Finance', 'Reviews fees, revenue share and ledger mapping.'),

  entry('feeType', 'FLAT', 'Flat', 'A fixed amount per transaction.'),
  entry('feeType', 'PERCENTAGE', 'Percentage', 'A proportion of the transaction amount.'),
  entry('feeType', 'TIERED', 'Tiered', 'A rate that varies by band.'),
  entry('feeType', 'REVENUE_SHARE', 'Revenue share', 'A split of the fee with a counterparty.'),
  entry('feeType', 'WAIVER', 'Waiver', 'Removes a fee that would otherwise apply.'),

  entry('limitType', 'PER_TRANSACTION', 'Per transaction', 'The largest single amount.'),
  entry('limitType', 'DAILY', 'Daily', 'Cumulative within a calendar day in the tenant time zone.'),
  entry('limitType', 'MONTHLY', 'Monthly', 'Cumulative within a calendar month.'),
  entry('limitType', 'VELOCITY', 'Velocity', 'Count within a rolling window.'),
  entry('limitType', 'BALANCE', 'Balance', 'The largest balance a wallet may hold.'),

  entry('transactionType', 'CREDIT', 'Credit', 'Money into the customer position.'),
  entry('transactionType', 'DEBIT', 'Debit', 'Money out of the customer position.'),
  entry('transactionType', 'TRANSFER', 'Transfer', 'Between two positions on the platform.'),
  entry('transactionType', 'REFUND', 'Refund', 'Returns value from an earlier transaction.'),
  entry('transactionType', 'ADJUSTMENT', 'Adjustment', 'A correction posted as a new movement.'),

  entry('customerType', 'INDIVIDUAL', 'Individual', 'A natural person.'),
  entry('customerType', 'MERCHANT', 'Merchant', 'A business accepting payment.'),
  entry('customerType', 'AGENT', 'Agent', 'Acts on behalf of the platform.'),
  entry('customerType', 'PARTNER', 'Partner', 'An institution integrating over the API.'),

  entry('channel', 'MOBILE', 'Mobile', 'A first-party mobile application.'),
  entry('channel', 'WEB', 'Web', 'A first-party web application.'),
  entry('channel', 'API', 'API', 'A partner calling the exposed product API.'),
  entry('channel', 'BATCH', 'Batch', 'A scheduled or bulk submission.'),
  entry('channel', 'BACK_OFFICE', 'Back office', 'An operator acting on a customer’s behalf.'),

  entry('settlementCalendar', 'CONTINUOUS', 'Continuous', 'Every day, including weekends.'),
  entry(
    'settlementCalendar',
    'BUSINESS_DAYS',
    'Business days',
    'Weekdays, less the holiday calendar.',
  ),
];

/** A registry seeded with the structural domains. A deployment adds its own currencies and countries. */
export function structuralReferenceData(): ReferenceDataRegistry {
  return new ReferenceDataRegistry(STRUCTURAL_REFERENCE_DATA);
}

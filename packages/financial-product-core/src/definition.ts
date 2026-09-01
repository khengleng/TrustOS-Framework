import { z } from 'zod';
import { conditionSchema } from '@trustsystem/workflow-definition';
import { productContentHash } from './ids';
import { PRODUCT_LIFECYCLE_STATUSES } from './lifecycle';
import { productRuleSchema } from './rules';

/**
 * The product definition document.
 *
 * One typed model, and everything else in this layer is a function of it: the composer builds
 * it, the validator refuses it, governance approves it, versioning freezes it, the runtime
 * executes it and the API exposes it. That is the reason it lives in `core` rather than beside
 * any one of them — a definition owned by the composer would be a definition the runtime has to
 * re-derive, and the two derivations disagree the first time a field is added.
 *
 * Four conventions run through the whole document, and each one is here because the alternative
 * fails quietly:
 *
 * **Money is a string of minor units plus a currency code.** Never a JSON number. A number goes
 * through an IEEE double on the way in and on the way out, and a fee cap of `1000.10` becomes
 * `1000.0999999999999` — which agrees with every test and disagrees with the counterparty. See
 * the header of `@trustsystem/financial-core`'s `decimal.ts`.
 *
 * **Rates are integers of hundredths of a basis point.** `0.5%` is `"5000"`. The same reason,
 * plus one more: a percentage written as `0.005` is read as half a percent by half the people
 * who see it and as 0.5 basis points by the other half.
 *
 * **A block never names a provider.** It names a *provider interface*, and a connector binds
 * that interface to something outside. `PaymentProvider.execute()`, never `ABA.execute()` — the
 * whole point of the layer is that swapping the rail underneath does not reopen the product.
 *
 * **Everything the product decides is declared, not implied.** Limits, fees, settlement,
 * reconciliation, risk, compliance and API exposure are all fields. A product whose settlement
 * schedule lives in the channel's code is a product that settles differently in payKH and dbank,
 * and nobody finds out until the two are reconciled against each other.
 */

/** A block key inside one product graph. Kebab-case, bounded, and unique within the document. */
const blockKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,59}$/, 'Lowercase kebab-case, starting with a letter.');

/** Minor units as a string. See the header. */
const minorUnitsSchema = z
  .string()
  .regex(/^[0-9]{1,24}$/, 'A non-negative integer number of minor units, written as a string.');

export const definitionMoneySchema = z
  .object({ minorUnits: minorUnitsSchema, currency: z.string().min(3).max(8) })
  .strict();

export type DefinitionMoney = z.infer<typeof definitionMoneySchema>;

export const definitionRateSchema = z
  .object({
    hundredthsOfBasisPoint: z
      .string()
      .regex(/^[0-9]{1,10}$/, 'Hundredths of a basis point, as a string. 0.5% is "5000".'),
  })
  .strict();

/**
 * Block configuration values.
 *
 * Scalars and flat arrays of scalars. No nested object, and that bound is deliberate: a block
 * configuration that can hold a structure becomes a second product definition living inside the
 * first one, with no schema and no validator, and the interesting decisions migrate into it.
 */
const configurationValueSchema = z.union([
  z.string().max(400),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(200), z.number().finite(), z.boolean()])).max(50),
]);

export const retryConfigurationSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoff: z.enum(['exponential', 'linear', 'fixed']),
    initialDelayMs: z.number().int().min(10).max(60_000),
    maxDelayMs: z.number().int().min(10).max(300_000),
  })
  .strict()
  .superRefine((retry, ctx) => {
    if (retry.maxDelayMs < retry.initialDelayMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxDelayMs'],
        message: 'The maximum delay cannot be below the initial one.',
      });
    }
  });

export type RetryConfiguration = z.infer<typeof retryConfigurationSchema>;

/**
 * What a block does when it fails.
 *
 * `fail` stops the execution; `compensate` runs the declared compensating blocks in reverse
 * order; `route` follows the `on_failure` transition. There is no `ignore`, and there never
 * should be: a financial step that is allowed to fail silently is a step whose absence nobody
 * notices until reconciliation, and by then it is in a month of transactions.
 */
export const BLOCK_FAILURE_MODES = ['fail', 'compensate', 'route'] as const;

export const productBlockSchema = z
  .object({
    key: blockKeySchema,
    /** The catalog block this node instantiates. */
    blockId: z.string().min(1).max(80),
    /** The exact catalog version. A range would let a block change under a published product. */
    blockVersion: z.string().regex(/^\d+\.\d+\.\d+$/, 'An exact semantic version.'),
    name: z.string().min(1).max(120),
    description: z.string().max(400).optional(),
    configuration: z.record(configurationValueSchema).default({}),
    /**
     * The connector bound to this block's provider interface, when it has one.
     *
     * Optional in the schema and *required by the validator* for any block whose catalog entry
     * declares a provider dependency. The split is so the error names the block and the
     * interface rather than saying a field is missing.
     */
    connectorId: z.string().min(1).max(80).optional(),
    retry: retryConfigurationSchema.optional(),
    timeoutMs: z.number().int().min(10).max(300_000).optional(),
    slaMs: z.number().int().min(10).max(86_400_000).optional(),
    onFailure: z.enum(BLOCK_FAILURE_MODES).default('fail'),
    /** Blocks to run in reverse order when this one fails with `compensate`. */
    compensateWith: z.array(blockKeySchema).max(10).default([]),
    /** Whether this step needs a human decision before the execution continues. */
    requiresApproval: z.boolean().default(false),
  })
  .strict();

export type ProductBlock = z.infer<typeof productBlockSchema>;

export const TRANSITION_KINDS = ['always', 'on_success', 'on_failure', 'conditional'] as const;

/** The two synthetic nodes. Neither is a block; both are graph endpoints. */
export const START_NODE = 'start' as const;
export const END_NODES = ['completed', 'failed'] as const;

const nodeRefSchema = z.union([
  z.literal(START_NODE),
  z.literal('completed'),
  z.literal('failed'),
  blockKeySchema,
]);

export const productTransitionSchema = z
  .object({
    from: nodeRefSchema,
    to: nodeRefSchema,
    kind: z.enum(TRANSITION_KINDS),
    /** Required for `conditional`, refused for everything else. */
    when: conditionSchema.optional(),
    description: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((transition, ctx) => {
    if (transition.kind === 'conditional' && !transition.when) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['when'],
        message: 'A conditional transition needs a condition. Without one it is `always`.',
      });
    }
    if (transition.kind !== 'conditional' && transition.when) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['when'],
        message:
          `A "${transition.kind}" transition ignores its condition. A condition that is never ` +
          'evaluated reads as a control and is not one.',
      });
    }
    if (transition.from === transition.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'A transition to itself is an infinite loop the runtime would take.',
      });
    }
  });

export type ProductTransition = z.infer<typeof productTransitionSchema>;

export const productLimitSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    /** A `limitType` reference code. Validated against the registry. */
    limitType: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    /** What the limit counts against. */
    scope: z.enum(['customer', 'wallet', 'merchant', 'product', 'organization']),
    amount: definitionMoneySchema.optional(),
    /** For velocity limits: how many, within `windowSeconds`. */
    count: z.number().int().min(1).max(1_000_000).optional(),
    windowSeconds: z.number().int().min(1).max(31_536_000).optional(),
    description: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((limit, ctx) => {
    if (!limit.amount && limit.count === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'A limit needs an amount or a count. One with neither refuses nothing.',
      });
    }
    if (limit.count !== undefined && limit.windowSeconds === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['windowSeconds'],
        message: 'A count limit needs a window. "Five" without "per what" is not a limit.',
      });
    }
  });

export type ProductLimit = z.infer<typeof productLimitSchema>;

const feeTierSchema = z
  .object({
    /** Inclusive lower bound of the band, in minor units. */
    fromMinorUnits: minorUnitsSchema,
    rate: definitionRateSchema.optional(),
    flat: definitionMoneySchema.optional(),
  })
  .strict();

export const productFeeSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    /** A `feeType` reference code. */
    feeType: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    basis: z.enum(['flat', 'percentage', 'tiered']),
    flat: definitionMoneySchema.optional(),
    rate: definitionRateSchema.optional(),
    tiers: z.array(feeTierSchema).max(20).optional(),
    cap: definitionMoneySchema.optional(),
    floor: definitionMoneySchema.optional(),
    /**
     * Who pays. Explicit because "the fee is 0.5%" does not say whether the merchant receives
     * 99.5 or pays 100.5, and the two produce different ledgers.
     */
    bearer: z.enum(['payer', 'payee', 'platform']),
    /** How to round when the arithmetic does not land on a minor unit. */
    rounding: z.enum(['half_even', 'half_up', 'down', 'up']).default('half_even'),
    description: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((fee, ctx) => {
    if (fee.basis === 'flat' && !fee.flat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flat'],
        message: 'A flat fee needs an amount.',
      });
    }
    if (fee.basis === 'percentage' && !fee.rate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rate'],
        message: 'A percentage fee needs a rate.',
      });
    }
    if (fee.basis === 'tiered' && (!fee.tiers || fee.tiers.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'A tiered fee needs tiers.',
      });
    }
    if (fee.tiers) {
      for (let index = 1; index < fee.tiers.length; index += 1) {
        const previous = BigInt(fee.tiers[index - 1]!.fromMinorUnits);
        const current = BigInt(fee.tiers[index]!.fromMinorUnits);
        if (current <= previous) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tiers', index, 'fromMinorUnits'],
            message:
              'Tiers must ascend. Out of order, the first matching band is not the intended ' +
              'one and the fee is wrong in a way that looks deliberate.',
          });
        }
      }
    }
  });

export type ProductFee = z.infer<typeof productFeeSchema>;

export const providerRequirementSchema = z
  .object({
    /** The interface name, e.g. `PaymentProvider`. Never a vendor. */
    providerInterface: z.string().regex(/^[A-Z][A-Za-z0-9]{2,39}$/),
    required: z.boolean().default(true),
    /** The connector chosen for this product. */
    connectorId: z.string().min(1).max(80).optional(),
    /**
     * Fallbacks, in order. Empty is a legitimate answer and it means "no fallback": a product
     * that quietly reroutes to a second provider is a product whose settlement lands somewhere
     * the operator did not expect.
     */
    fallbackConnectorIds: z.array(z.string().min(1).max(80)).max(5).default([]),
  })
  .strict();

export type ProviderRequirement = z.infer<typeof providerRequirementSchema>;

export const settlementPolicySchema = z
  .object({
    schedule: z.enum(['realtime', 'daily', 'weekly', 'monthly', 'manual']),
    /** A `settlementCalendar` reference code. */
    calendar: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    /** Local time of the cut-off, `HH:MM`. The time zone is the tenant's, never the server's. */
    cutoff: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    /** Days money waits in transit before it is released. */
    holdDays: z.number().int().min(0).max(90).default(0),
    /** Minimum batch value below which settlement waits for the next window. */
    minimumBatch: definitionMoneySchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.schedule !== 'realtime' && policy.schedule !== 'manual' && !policy.cutoff) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cutoff'],
        message:
          'A scheduled settlement needs a cut-off. Without one, "daily" means whenever the job ' +
          'happened to run, and the merchant statement moves by an hour every deployment.',
      });
    }
  });

export type SettlementPolicy = z.infer<typeof settlementPolicySchema>;

export const reconciliationPolicySchema = z
  .object({
    frequency: z.enum(['realtime', 'hourly', 'daily', 'weekly', 'manual']),
    /** Absolute tolerance, in minor units, below which a difference is not an exception. */
    toleranceMinorUnits: minorUnitsSchema.default('0'),
    /** How long an unresolved exception may sit before it escalates. */
    exceptionSlaHours: z.number().int().min(1).max(720).default(24),
    /** Whether an unreconciled window blocks the next settlement. */
    blocksSettlement: z.boolean().default(true),
  })
  .strict();

export const riskPolicySchema = z
  .object({
    /** Above this, the transaction needs an enhanced review before it completes. */
    enhancedReviewAbove: definitionMoneySchema.optional(),
    /** `riskLevel` reference codes that are refused outright. */
    prohibitedRiskLevels: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/))
      .max(10)
      .default([]),
    /** Which checks must have run. Names of block categories, not of vendors. */
    requiredChecks: z.array(z.string().min(1).max(60)).max(20).default([]),
    /** Score at or above which the transaction routes to manual review. */
    manualReviewScore: z.number().int().min(0).max(100).optional(),
  })
  .strict();

export const compliancePolicySchema = z
  .object({
    /** How sensitive the product's data is. Drives retention and who may read an execution. */
    dataClassification: z.enum(['public', 'internal', 'confidential', 'restricted']),
    /** The minimum KYC level a customer must hold. A reference code, never a number. */
    minimumKycLevel: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,39}$/)
      .optional(),
    retentionDays: z.number().int().min(1).max(36_500),
    /** Screening categories the product requires. Provider-neutral names. */
    screening: z
      .array(z.enum(['aml', 'sanctions', 'pep', 'fraud', 'adverse_media']))
      .max(5)
      .default([]),
  })
  .strict();

export const apiOperationSchema = z
  .object({
    operationId: z.string().regex(/^[a-z][a-zA-Z0-9]{2,59}$/),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /**
     * Appended to the product base path.
     *
     * Segments and `:params` only. No query string, no wildcard, no `..` — a path that could
     * carry a query would let an operation be declared twice with different parameters and route
     * order decide which one answered.
     */
    path: z
      .string()
      .regex(/^\/[A-Za-z0-9\-/:{}]{0,120}$/, 'Path segments and :params only.')
      .refine((value) => !value.includes('..'), 'A path may not contain "..".'),
    /** The permission a caller must hold. Validated against the catalog. */
    permission: z.string().min(3).max(80),
    /** Which block key this operation starts execution at. */
    entryBlock: blockKeySchema.optional(),
    /**
     * Whether the operation creates something.
     *
     * Every one that does requires an idempotency key, and the schema enforces it rather than
     * leaving it to a reviewer: a retried POST that creates a second transaction is the most
     * expensive bug this layer can ship.
     */
    createsTransaction: z.boolean().default(false),
    requiresIdempotencyKey: z.boolean().default(false),
    rateLimitPerMinute: z.number().int().min(1).max(100_000).optional(),
    description: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.createsTransaction && !operation.requiresIdempotencyKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresIdempotencyKey'],
        message:
          'An operation that creates a transaction must require an idempotency key. Without ' +
          'one, a client timeout followed by a retry produces two transactions and one of them ' +
          'is invisible to the caller.',
      });
    }
    if (operation.createsTransaction && operation.method === 'GET') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['method'],
        message: 'A GET that creates a transaction will be retried by every proxy on the path.',
      });
    }
  });

export type ApiOperation = z.infer<typeof apiOperationSchema>;

export const apiExposurePolicySchema = z
  .object({
    exposed: z.boolean().default(false),
    /** `/v1/products/<slug>`. Built from the slug rather than free text so two products cannot collide. */
    slug: z.string().regex(/^[a-z][a-z0-9-]{2,59}$/),
    operations: z.array(apiOperationSchema).max(40).default([]),
    authentication: z.array(z.enum(['bearer', 'api_key', 'service_account'])).min(1),
    /** Always true. Present as a field so a reviewer sees it, and refused if false. */
    tenantScoped: z.literal(true),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.exposed && policy.operations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operations'],
        message: 'An exposed product with no operations exposes nothing.',
      });
    }
    const seen = new Set<string>();
    for (const [index, operation] of policy.operations.entries()) {
      const signature = `${operation.method} ${operation.path}`;
      if (seen.has(signature)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operations', index, 'path'],
          message: `Two operations claim ${signature}. Route order would decide which one runs.`,
        });
      }
      seen.add(signature);
    }
  });

export type ApiExposurePolicy = z.infer<typeof apiExposurePolicySchema>;

/**
 * The people accountable for the product.
 *
 * Four owners, and all four are required. Section 19 of the reference architecture asks for
 * them; the reason they are mandatory rather than optional is that an optional owner field is an
 * empty owner field, and "who signed off on this fee" is a question that only ever gets asked
 * after something has gone wrong.
 *
 * These are actor identifiers, not names or email addresses. The directory resolves them, and
 * keeping personal data out of the definition means the definition can be shown to anybody who
 * needs to review the product.
 */
export const productOwnershipSchema = z
  .object({
    businessOwner: z.string().min(1).max(80),
    technicalOwner: z.string().min(1).max(80),
    riskOwner: z.string().min(1).max(80),
    complianceOwner: z.string().min(1).max(80),
  })
  .strict();

export type ProductOwnership = z.infer<typeof productOwnershipSchema>;

/** The catalog categories a product belongs to. Section 22 of the specification. */
export const PRODUCT_TYPES = [
  'wallet',
  'payment',
  'lending',
  'savings',
  'merchant',
  'loyalty',
  'collection',
  'settlement',
  'remittance',
] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export const productDefinitionSchema = z
  .object({
    productId: z.string().min(1).max(80),
    productName: z.string().min(1).max(120),
    productType: z.enum(PRODUCT_TYPES),
    description: z.string().min(1).max(600),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'An exact semantic version, e.g. 2.1.0.'),

    ownership: productOwnershipSchema,

    /** `country` reference codes. Empty means none, never all. */
    supportedCountries: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/)).max(200),
    /** `currency` reference codes. Empty means none, for the same reason. */
    supportedCurrencies: z.array(z.string().min(3).max(8)).max(50),

    lifecycleStatus: z.enum(PRODUCT_LIFECYCLE_STATUSES),
    effectiveDate: z.string().datetime(),
    /** When somebody must look at this again. Required — a product with no review date is never reviewed. */
    reviewDate: z.string().datetime(),

    blocks: z.array(productBlockSchema).min(1).max(120),
    transitions: z.array(productTransitionSchema).min(1).max(400),
    rules: z.array(productRuleSchema).max(200).default([]),
    providers: z.array(providerRequirementSchema).max(20).default([]),
    limits: z.array(productLimitSchema).max(50).default([]),
    fees: z.array(productFeeSchema).max(50).default([]),

    settlementPolicy: settlementPolicySchema.optional(),
    reconciliationPolicy: reconciliationPolicySchema.optional(),
    riskPolicy: riskPolicySchema,
    compliancePolicy: compliancePolicySchema,
    apiExposurePolicy: apiExposurePolicySchema,

    /** How closely this product's executions are audited. Drives retention and reviewer access. */
    auditClassification: z.enum(['standard', 'sensitive', 'restricted']),

    /** Free-form labels for the catalog. Bounded, and never load-bearing. */
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
      .max(20)
      .default([]),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const keys = new Set<string>();
    for (const [index, block] of definition.blocks.entries()) {
      if (keys.has(block.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blocks', index, 'key'],
          message: `Two blocks share the key "${block.key}". Transitions would be ambiguous.`,
        });
      }
      keys.add(block.key);
    }

    const ruleIds = new Set<string>();
    for (const [index, rule] of definition.rules.entries()) {
      if (ruleIds.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'id'],
          message: `Two rules share the id "${rule.id}".`,
        });
      }
      ruleIds.add(rule.id);
    }

    if (new Date(definition.reviewDate) <= new Date(definition.effectiveDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewDate'],
        message: 'The review date must be after the effective date.',
      });
    }
  });

export type ProductDefinition = z.infer<typeof productDefinitionSchema>;

/**
 * The hash of a definition's *reviewed content*.
 *
 * `lifecycleStatus` is excluded, and that exclusion is the whole subtlety of this function.
 *
 * The hash answers one question: **is this the product the reviewers approved?** A lifecycle
 * status is not part of what they approved — it is where the product has got to since. Staging,
 * activating, pausing during an incident and reactivating afterwards all change the status and
 * none of them changes a fee, a limit, a rule or a block.
 *
 * Hashing it anyway produces a specific and nasty failure: an execution binds at `active`, an
 * operator pauses the product, the execution comes back from review, and the binding check
 * reports that the definition was tampered with. It was not. Every in-flight transaction would
 * be refused during exactly the incident the pause was handling — which is when the system is
 * least able to absorb a second problem.
 *
 * Everything else is in. A change to any field a reviewer read changes the hash.
 */
export function definitionContentHash(definition: ProductDefinition): string {
  const { lifecycleStatus: _status, ...reviewed } = definition;
  return productContentHash(reviewed);
}

/** Parses and refuses. The only way a definition should come into existence from untrusted input. */
export function parseProductDefinition(input: unknown): ProductDefinition {
  return productDefinitionSchema.parse(input);
}

/** The block with this key, or undefined. */
export function findBlock(definition: ProductDefinition, key: string): ProductBlock | undefined {
  return definition.blocks.find((block) => block.key === key);
}

/** Every transition leaving a node, in declaration order. */
export function transitionsFrom(definition: ProductDefinition, from: string): ProductTransition[] {
  return definition.transitions.filter((transition) => transition.from === from);
}

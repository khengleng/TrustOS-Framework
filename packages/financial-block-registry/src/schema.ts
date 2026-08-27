import { z } from 'zod';

/**
 * The financial block model.
 *
 * A block is the smallest unit of financial behaviour a product may contain: create a wallet,
 * calculate a percentage fee, consume a daily limit, post a journal. Products are composed from
 * them and from nothing else — there is no block that runs a script, calls a URL or evaluates an
 * expression, and there never should be. The moment one exists, "products are composed from
 * approved capabilities" becomes "products are composed from approved capabilities and also
 * arbitrary code", and every review that followed was reviewing the wrong thing.
 *
 * Each entry carries three kinds of information, and it is worth being clear which is which:
 *
 *   * **Contract** — what goes in, what comes out, what configuration it needs. This is what the
 *     composer validates a product against.
 *   * **Consequence** — whether it moves money, whether it is idempotent, what it compensates
 *     with, which events it emits, which permissions it needs. This is what governance reads to
 *     decide who must approve a product containing it.
 *   * **Position** — which blocks may follow it, and which categories must have run before it.
 *     This is the part that catches the composition that is individually valid and collectively
 *     wrong: executing a payment with no preceding limit consumption is eight correct blocks in
 *     an order that authorizes the same money twice.
 *
 * The schemas here describe shapes; they do not execute. A block's `inputs` are a list of typed
 * field descriptors, not a zod schema and not JSON Schema — because a block definition is data
 * that travels through a database and a review UI, and a schema that can be *constructed* from
 * untrusted data is a schema that can be constructed to accept anything.
 */

export const BLOCK_CATEGORIES = [
  'identity',
  'wallet',
  'payment',
  'transfer',
  'ledger',
  'fee',
  'limit',
  'settlement',
  'reconciliation',
  'lending',
  'risk',
  'loyalty',
  'notification',
] as const;

export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

/**
 * Field types a block contract may use.
 *
 * `money` is its own type rather than a string with a comment, and that is the single most
 * load-bearing entry in the list: it means the composer can *check* that a monetary field is
 * carried as minor units plus a currency, rather than trusting that whoever wrote the block
 * remembered. A `number` typed field is refused for anything a fee or a limit reads.
 */
export const BLOCK_FIELD_TYPES = [
  'string',
  'integer',
  'boolean',
  'money',
  'rate',
  'reference',
  'timestamp',
  'enum',
  'id',
] as const;

export type BlockFieldType = (typeof BLOCK_FIELD_TYPES)[number];

export const blockFieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,49}$/, 'Lower camel case.'),
    type: z.enum(BLOCK_FIELD_TYPES),
    required: z.boolean().default(true),
    description: z.string().min(1).max(300),
    /** For `enum`: the closed set. For `reference`: the reference-data domain. */
    values: z.array(z.string().max(60)).max(40).optional(),
    /** For `reference`: which centrally governed domain the code comes from. */
    referenceDomain: z.string().max(40).optional(),
    /**
     * Whether the field carries personal data.
     *
     * Marked so the runtime can keep it out of events, audit records and metric dimensions
     * without every block author having to remember. A field marked `pii` never reaches a log.
     */
    pii: z.boolean().default(false),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === 'enum' && (!field.values || field.values.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'An enum needs values.',
      });
    }
    if (field.type === 'reference' && !field.referenceDomain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referenceDomain'],
        message:
          'A reference field must name its domain. Without one the code is validated against ' +
          'nothing, which is how four products each define what GOLD means.',
      });
    }
  });

export type BlockField = z.infer<typeof blockFieldSchema>;

/**
 * What a block does to money.
 *
 * `none` reads; `reserves` places or releases a hold; `moves` posts to the ledger. The
 * distinction drives three separate controls: which blocks need idempotency (anything but
 * `none`), which need a preceding limit consumption (`moves` and `reserves`), and which need a
 * compensating block declared (`moves`).
 */
export const MONETARY_EFFECTS = ['none', 'reserves', 'moves'] as const;

export type MonetaryEffect = (typeof MONETARY_EFFECTS)[number];

export const BLOCK_SECURITY_CLASSIFICATIONS = ['standard', 'sensitive', 'restricted'] as const;

export const BLOCK_LIFECYCLE_STATUSES = ['draft', 'approved', 'deprecated', 'withdrawn'] as const;

export type BlockLifecycleStatus = (typeof BLOCK_LIFECYCLE_STATUSES)[number];

/**
 * A pattern naming blocks that may follow.
 *
 * Either an exact block id (`ledger.create_journal`) or a category wildcard (`ledger.*`). An
 * empty list means **any approved block** — which is the right default for a lookup or a
 * notification, and the wrong one for anything that moves money, so the money-moving entries in
 * the catalog all name their successors explicitly.
 */
const nextPatternSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.([a-z][a-z0-9_]*|\*)$/, 'A block id or a category wildcard.');

export const blockDefinitionSchema = z
  .object({
    blockId: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'category.operation, lower snake case.'),
    name: z.string().min(1).max(120),
    category: z.enum(BLOCK_CATEGORIES),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(400),

    inputs: z.array(blockFieldSchema).max(30).default([]),
    outputs: z.array(blockFieldSchema).max(30).default([]),
    /** Configuration a product must supply when it uses this block. */
    configuration: z.array(blockFieldSchema).max(20).default([]),

    /** Permissions the *actor* must hold. Never the product, never the agent. */
    requiredPermissions: z.array(z.string().min(3).max(80)).max(10).default([]),

    /**
     * The provider interface this block needs bound, if any.
     *
     * An interface name — `PaymentProvider` — never a vendor. A block naming ABA would make
     * every product containing it an ABA product, which is the coupling this layer exists to
     * remove.
     */
    providerInterface: z
      .string()
      .regex(/^[A-Z][A-Za-z0-9]{2,39}$/)
      .optional(),

    allowedNext: z.array(nextPatternSchema).max(30).default([]),
    /** Categories that must appear earlier on every path reaching this block. */
    requiresPrecedingCategories: z.array(z.enum(BLOCK_CATEGORIES)).max(6).default([]),

    monetaryEffect: z.enum(MONETARY_EFFECTS),
    /**
     * Whether running it twice with the same key is the same as running it once.
     *
     * Not a promise the block makes about itself — a promise the *handler* must keep, and the
     * runtime enforces by refusing to retry a non-idempotent block. A block that moves money and
     * claims idempotency without a key is the schema's one hard refusal below.
     */
    idempotent: z.boolean(),
    /** The block that undoes this one, for a `compensate` failure mode. */
    compensatedBy: z.string().max(80).optional(),

    auditEvents: z.array(z.string().min(3).max(80)).max(10).default([]),
    emitsEvents: z.array(z.string().min(3).max(80)).max(10).default([]),

    securityClassification: z.enum(BLOCK_SECURITY_CLASSIFICATIONS),
    lifecycleStatus: z.enum(BLOCK_LIFECYCLE_STATUSES),
    /** Required when deprecated. A deprecation with no successor is a dead end. */
    supersededBy: z.string().max(80).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (!block.blockId.startsWith(`${block.category}.`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockId'],
        message: `A ${block.category} block's id must start with "${block.category}.".`,
      });
    }

    if (block.monetaryEffect !== 'none' && !block.idempotent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idempotent'],
        message:
          'A block that moves or reserves money must be idempotent. Without it, a client ' +
          'timeout followed by a retry moves the money twice and the second movement is ' +
          'invisible to the caller.',
      });
    }

    if (block.monetaryEffect === 'moves' && !block.compensatedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compensatedBy'],
        message:
          'A block that moves money must declare what undoes it. A step with no compensation ' +
          'leaves a half-finished transaction that only a person can unwind, at 3am.',
      });
    }

    if (block.monetaryEffect !== 'none' && block.requiresPrecedingCategories.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresPrecedingCategories'],
        message:
          'A block that moves or reserves money must require something before it — at minimum a ' +
          'limit. A composition that debits with no preceding limit consumption authorizes the ' +
          'same money twice and fails at settlement, after the customer was told it worked.',
      });
    }

    if (block.lifecycleStatus === 'deprecated' && !block.supersededBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message: 'A deprecated block must name its successor.',
      });
    }

    for (const field of [...block.inputs, ...block.outputs]) {
      if (field.pii && block.securityClassification === 'standard') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['securityClassification'],
          message: `Field "${field.name}" carries personal data, so this block is at least sensitive.`,
        });
      }
    }
  });

export type BlockDefinition = z.infer<typeof blockDefinitionSchema>;

/** Whether a successor pattern admits a block id. */
export function patternAdmits(pattern: string, blockId: string): boolean {
  if (pattern.endsWith('.*')) {
    return blockId.startsWith(`${pattern.slice(0, -1)}`);
  }
  return pattern === blockId;
}

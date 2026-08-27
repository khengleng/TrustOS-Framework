import { z } from 'zod';
import {
  productError,
  type ProductDefinition,
  type ProductType,
} from '@trustos/financial-product-core';
import { APPROVED_BLOCKS, type BlockRegistry } from '@trustos/financial-block-registry';
import { ProductComposer } from './composer';
import { validateProduct, type ValidationResult } from './validate';
import { findTemplate, PRODUCT_TEMPLATES } from './templates';

/**
 * AI-assisted composition.
 *
 * A product owner describes a product in words; a model proposes a composition; **the proposal is
 * data, and it is validated before it becomes anything.** That sentence is the whole design, and
 * every decision below follows from it.
 *
 * The framework ships **no model call**. There is no prompt executed here, no gateway client, no
 * provider. `buildCompositionBrief` produces the structured brief a deployment sends through
 * `@trustos/ai-gateway` — which is where policy, guardrails, cost accounting and audit are
 * applied — and `draftFromProposal` takes whatever comes back. Calling a model from this package
 * would be a call that went around the gateway, and a request that goes around the gateway is a
 * request nobody can account for afterwards.
 *
 * Three properties make the proposal safe to accept:
 *
 * **It is parsed, not trusted.** `productProposalSchema` is strict. A proposal naming a block
 * outside the approved catalog is refused at the block, by the composer, before a definition
 * exists. A model that hallucinates `wallet.transfer_everything` produces a parse failure, not a
 * product.
 *
 * **It always lands in `draft`.** `ProductComposer.build()` emits `draft` regardless of what the
 * proposal asked for, so an AI-composed product enters the same lifecycle as a hand-composed one
 * and passes through the same validation, sandbox, review and approval.
 *
 * **It cannot supply owners or approvals.** The proposal schema has no field for ownership, no
 * field for approval levels and no field for lifecycle status. A model that could nominate the
 * risk owner could nominate one who does not exist, and the approval requirement would be
 * satisfied by nobody.
 */

/** What a product owner said, structured. The input to a brief, not to a composer. */
export const compositionRequestSchema = z
  .object({
    intent: z.string().min(10).max(2000),
    productType: z.string().max(40).optional(),
    /** Currencies the deployment supports. The model chooses among them; it does not invent one. */
    availableCurrencies: z.array(z.string().min(3).max(8)).min(1).max(50),
    availableCountries: z.array(z.string().max(40)).max(200).default([]),
    /** Connectors the tenant already has approved. The model may only select from these. */
    availableConnectorIds: z.array(z.string().max(80)).max(50).default([]),
  })
  .strict();

export type CompositionRequest = z.infer<typeof compositionRequestSchema>;

/**
 * The brief a deployment sends through the AI gateway.
 *
 * Everything the model is allowed to choose from, enumerated. A brief that said "compose a
 * merchant wallet" and left the model to recall the block catalog would get a composition built
 * from blocks that sound right, and the closest approved block to a hallucinated one is often not
 * the one the author meant.
 */
export interface CompositionBrief {
  intent: string;
  /** Every approved block, as `id@version — description`. The model's entire vocabulary. */
  availableBlocks: Array<{ blockId: string; version: string; category: string; description: string }>;
  availableTemplates: Array<{ id: string; name: string; description: string }>;
  availableCurrencies: string[];
  availableCountries: string[];
  availableConnectorIds: string[];
  /** The constraints, stated. Repeated in the brief because a model reads what it is given. */
  constraints: string[];
}

export function buildCompositionBrief(
  request: CompositionRequest,
  registry: BlockRegistry = APPROVED_BLOCKS,
): CompositionBrief {
  const parsed = compositionRequestSchema.parse(request);

  return {
    intent: parsed.intent,
    availableBlocks: registry
      .all()
      .filter((block) => block.lifecycleStatus === 'approved')
      .map((block) => ({
        blockId: block.blockId,
        version: block.version,
        category: block.category,
        description: block.description,
      })),
    availableTemplates: PRODUCT_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
    })),
    availableCurrencies: parsed.availableCurrencies,
    availableCountries: parsed.availableCountries,
    availableConnectorIds: parsed.availableConnectorIds,
    constraints: [
      'Use only the block ids and versions listed. Do not invent a block.',
      'Never name a provider, a bank, a scheme or a country-specific payment rail.',
      'Every block that moves money must be preceded, on every path, by a limit block.',
      'Amounts are integer minor units written as strings. Rates are hundredths of a basis point.',
      'The proposal is a draft. It will be validated, simulated, reviewed and approved by people.',
    ],
  };
}

/**
 * The shape a model must answer in.
 *
 * Strict, closed, and with no field for anything a model should not decide. Note what is missing:
 * ownership, lifecycle status, approval levels, audit classification and retention. Those are
 * governance decisions, and a model that could propose them would produce a product whose risk
 * owner was a plausible-looking string.
 */
export const productProposalSchema = z
  .object({
    productId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
    productName: z.string().min(1).max(120),
    productType: z.string().max(40),
    description: z.string().min(1).max(600),
    /** A template to start from, when the model recognised one. */
    basedOnTemplate: z.string().max(80).optional(),
    supportedCurrencies: z.array(z.string().min(3).max(8)).min(1).max(50),
    supportedCountries: z.array(z.string().max(40)).max(200).default([]),
    blocks: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),
            blockId: z.string().max(80),
            blockVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
            configuration: z.record(z.union([z.string().max(400), z.number(), z.boolean()])).default({}),
            connectorId: z.string().max(80).optional(),
          })
          .strict(),
      )
      .max(120)
      .default([]),
    transitions: z
      .array(
        z
          .object({
            from: z.string().max(60),
            to: z.string().max(60),
            kind: z.enum(['always', 'on_success', 'on_failure', 'conditional']),
            when: z.unknown().optional(),
          })
          .strict(),
      )
      .max(400)
      .default([]),
    fees: z.array(z.unknown()).max(50).default([]),
    limits: z.array(z.unknown()).max(50).default([]),
    rules: z.array(z.unknown()).max(200).default([]),
    /** The model's own account of what it did. Shown to the reviewer, never acted on. */
    rationale: z.string().max(4000).default(''),
  })
  .strict();

export type ProductProposal = z.infer<typeof productProposalSchema>;

export interface DraftFromProposalInput {
  proposal: unknown;
  request: CompositionRequest;
  ownership: ProductDefinition['ownership'];
  compliancePolicy: ProductDefinition['compliancePolicy'];
  auditClassification: ProductDefinition['auditClassification'];
  effectiveDate: string;
  reviewDate: string;
  registry?: BlockRegistry;
}

export interface ProposalOutcome {
  definition: ProductDefinition;
  validation: ValidationResult;
  /** What the model said it did. Shown to the reviewer beside the diff. */
  rationale: string;
  /** What the framework overrode, and why. The reviewer's first read. */
  overrides: string[];
}

/**
 * Turns a proposal into a draft.
 *
 * Throws on anything the proposal got wrong that would produce an invalid product; returns a
 * draft plus its validation result for everything else. The split matters for the interface: a
 * proposal naming a block that does not exist is not something a reviewer can fix by reading, and
 * a proposal whose graph has an unreachable block is exactly what the validator's findings list
 * is for.
 */
export function draftFromProposal(input: DraftFromProposalInput): ProposalOutcome {
  const request = compositionRequestSchema.parse(input.request);
  const proposal = productProposalSchema.parse(input.proposal);
  const registry = input.registry ?? APPROVED_BLOCKS;
  const overrides: string[] = [];

  const currencies = proposal.supportedCurrencies.filter((currency) =>
    request.availableCurrencies.includes(currency),
  );

  if (currencies.length !== proposal.supportedCurrencies.length) {
    const dropped = proposal.supportedCurrencies.filter(
      (currency) => !request.availableCurrencies.includes(currency),
    );
    overrides.push(
      `Dropped currencies the deployment does not support: ${dropped.join(', ')}. A model may ` +
        'choose among what exists; it may not add one.',
    );
  }

  if (currencies.length === 0) {
    throw productError(
      'product_definition_invalid',
      'The proposal names no currency the deployment supports.',
      { expected: request.availableCurrencies.join(', '), actual: proposal.supportedCurrencies.join(', ') },
    );
  }

  const countries = proposal.supportedCountries.filter((country) =>
    request.availableCountries.includes(country),
  );

  if (countries.length !== proposal.supportedCountries.length) {
    overrides.push(
      'Dropped countries outside the deployment’s list. Expanding jurisdiction is a governed ' +
        'change with its own approval, not something a composition proposes.',
    );
  }

  const productType = normaliseProductType(proposal.productType, overrides);

  if (proposal.basedOnTemplate && !findTemplate(proposal.basedOnTemplate)) {
    overrides.push(
      `Ignored the referenced template "${proposal.basedOnTemplate}", which does not exist.`,
    );
  }

  const composer = new ProductComposer({
    productId: proposal.productId,
    productName: proposal.productName,
    productType,
    description: proposal.description,
    version: '0.1.0',
    ownership: input.ownership,
    supportedCountries: countries,
    supportedCurrencies: currencies,
    effectiveDate: input.effectiveDate,
    reviewDate: input.reviewDate,
    compliancePolicy: input.compliancePolicy,
    auditClassification: input.auditClassification,
    apiSlug: proposal.productId,
    registry,
  });

  for (const block of proposal.blocks) {
    /*
     * Resolution happens here, one block at a time, and it throws.
     *
     * A model that hallucinated `wallet.transfer_everything` produces a refusal naming that block
     * rather than a definition that fails validation later with a message about a graph.
     */
    composer.addBlock({
      key: block.key,
      blockId: block.blockId,
      blockVersion: block.blockVersion,
      configuration: block.configuration,
      ...(block.connectorId && request.availableConnectorIds.includes(block.connectorId)
        ? { connectorId: block.connectorId }
        : {}),
    });

    if (block.connectorId && !request.availableConnectorIds.includes(block.connectorId)) {
      overrides.push(
        `Dropped connector "${block.connectorId}" on block "${block.key}": it is not approved ` +
          'for this tenant. Provider substitution is a governed change.',
      );
    }
  }

  for (const transition of proposal.transitions) {
    if (transition.kind === 'conditional') {
      composer.branch(transition.from, transition.to, transition.when as never);
    } else if (transition.kind === 'on_failure') {
      composer.onFailure(transition.from, transition.to);
    } else {
      composer.connect(transition.from, transition.to, transition.kind);
    }
  }

  for (const fee of proposal.fees) composer.addFee(fee as never);
  for (const limit of proposal.limits) composer.addLimit(limit as never);
  for (const rule of proposal.rules) composer.addRule(rule as never);

  const definition = composer.build();

  overrides.push(
    'Lifecycle status forced to `draft`. A proposal enters the same lifecycle as a hand-composed ' +
      'product: validate, sandbox, review, approve, publish.',
  );

  return {
    definition,
    validation: validateProduct(definition, { blocks: registry }),
    rationale: proposal.rationale,
    overrides,
  };
}

const PRODUCT_TYPES: readonly ProductType[] = [
  'wallet',
  'payment',
  'lending',
  'savings',
  'merchant',
  'loyalty',
  'collection',
  'settlement',
  'remittance',
];

/**
 * Maps a proposed product type onto the catalog's, defaulting rather than throwing.
 *
 * A model that answers "digital-wallet" instead of "wallet" has understood the request and got
 * the vocabulary wrong, and refusing the whole proposal over a category label would waste the
 * work. The default is recorded in `overrides`, which is what the reviewer reads.
 */
function normaliseProductType(value: string, overrides: string[]): ProductType {
  const candidate = value.toLowerCase().replace(/[^a-z]/g, '');
  const match = PRODUCT_TYPES.find((type) => candidate.includes(type));

  if (match) return match;

  overrides.push(`Product type "${value}" is not a catalog category; defaulted to "payment".`);
  return 'payment';
}

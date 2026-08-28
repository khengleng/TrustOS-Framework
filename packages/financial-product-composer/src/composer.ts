import {
  productDefinitionSchema,
  productError,
  type ApiExposurePolicy,
  type ProductBlock,
  type ProductDefinition,
  type ProductFee,
  type ProductLimit,
  type ProductRule,
  type ProductTransition,
  type ProductType,
  type ProviderRequirement,
} from '@trustos/financial-product-core';
import { APPROVED_BLOCKS, type BlockRegistry } from '@trustos/financial-block-registry';
import { validateProduct, type ValidateProductOptions, type ValidationResult } from './validate';

/**
 * The product composer.
 *
 * The API behind the visual designer, and the API a script uses. One implementation for both,
 * because a designer that built definitions through a second path would be a designer whose
 * output the CLI could not validate — and the two would diverge on the first field either of
 * them added.
 *
 * Three properties are worth stating before the code:
 *
 * **It builds data, never behaviour.** `addBlock` records that a product uses an approved block
 * with a configuration. There is no `addScript`, no `addExpression`, no `addHandler`, and adding
 * one would make every review that followed a review of the wrong thing. The composer's entire
 * vocabulary is the block catalog plus the restricted rule language.
 *
 * **It refuses early, at the call that is wrong.** `addBlock` with an unapproved block id throws
 * at that call rather than producing a definition that fails validation twenty calls later — the
 * stack trace names the mistake, and in a designer the error attaches to the block the user just
 * dragged.
 *
 * **The output is a draft, always.** `build()` produces a definition in `draft`, whatever the
 * caller asked for. Composition is not approval, and a composer that could emit an `active`
 * product would be a way around the entire lifecycle.
 */

export interface ComposerOptions {
  productId: string;
  productName: string;
  productType: ProductType;
  description: string;
  version: string;
  ownership: ProductDefinition['ownership'];
  supportedCountries?: string[];
  supportedCurrencies: string[];
  effectiveDate: string;
  reviewDate: string;
  compliancePolicy: ProductDefinition['compliancePolicy'];
  auditClassification: ProductDefinition['auditClassification'];
  apiSlug?: string;
  registry?: BlockRegistry;
}

export interface AddBlockInput {
  key: string;
  blockId: string;
  blockVersion: string;
  name?: string;
  description?: string;
  configuration?: ProductBlock['configuration'];
  connectorId?: string;
  retry?: ProductBlock['retry'];
  timeoutMs?: number;
  slaMs?: number;
  onFailure?: ProductBlock['onFailure'];
  compensateWith?: string[];
  requiresApproval?: boolean;
}

export class ProductComposer {
  private readonly registry: BlockRegistry;
  private readonly blocks: ProductBlock[] = [];
  private readonly transitions: ProductTransition[] = [];
  private readonly rules: ProductRule[] = [];
  private readonly fees: ProductFee[] = [];
  private readonly limits: ProductLimit[] = [];
  private readonly providers: ProviderRequirement[] = [];

  private settlementPolicy: ProductDefinition['settlementPolicy'];
  private reconciliationPolicy: ProductDefinition['reconciliationPolicy'];
  private riskPolicy: ProductDefinition['riskPolicy'] = {
    prohibitedRiskLevels: [],
    requiredChecks: [],
  };
  private apiExposure: Partial<ApiExposurePolicy> = {};

  constructor(private readonly options: ComposerOptions) {
    this.registry = options.registry ?? APPROVED_BLOCKS;
  }

  /**
   * Adds a block.
   *
   * Resolves it against the catalog immediately — an unapproved block is refused here rather than
   * at `build()`, so the error names the block somebody just chose. The name defaults to the
   * catalog's, because a designer that made a user retype "Create wallet" is a designer that
   * accumulates twelve spellings of it.
   */
  addBlock(input: AddBlockInput): this {
    const catalog = this.registry.requireComposable(input.blockId, input.blockVersion);

    if (this.blocks.some((block) => block.key === input.key)) {
      throw productError(
        'product_definition_invalid',
        `A block with the key "${input.key}" is already in this product. Transitions would be ambiguous.`,
        { blockKey: input.key },
      );
    }

    this.blocks.push({
      key: input.key,
      blockId: input.blockId,
      blockVersion: input.blockVersion,
      name: input.name ?? catalog.name,
      ...(input.description ? { description: input.description } : {}),
      configuration: input.configuration ?? {},
      ...(input.connectorId ? { connectorId: input.connectorId } : {}),
      ...(input.retry ? { retry: input.retry } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.slaMs !== undefined ? { slaMs: input.slaMs } : {}),
      onFailure: input.onFailure ?? 'fail',
      compensateWith: input.compensateWith ?? [],
      requiresApproval: input.requiresApproval ?? false,
    });

    if (
      catalog.providerInterface &&
      !this.providers.some((provider) => provider.providerInterface === catalog.providerInterface)
    ) {
      this.providers.push({
        providerInterface: catalog.providerInterface,
        required: true,
        ...(input.connectorId ? { connectorId: input.connectorId } : {}),
        fallbackConnectorIds: [],
      });
    }

    return this;
  }

  /** Connects two nodes unconditionally, or on success. */
  connect(
    from: string,
    to: string,
    kind: 'always' | 'on_success' = 'on_success',
    description?: string,
  ): this {
    this.transitions.push({
      from,
      to,
      kind,
      ...(description ? { description } : {}),
    } as ProductTransition);
    return this;
  }

  /** Connects two nodes on a condition. The branch a decision takes. */
  branch(from: string, to: string, when: ProductRule['when'], description?: string): this {
    this.transitions.push({
      from,
      to,
      kind: 'conditional',
      when,
      ...(description ? { description } : {}),
    } as ProductTransition);
    return this;
  }

  /** The path taken when a block fails. */
  onFailure(from: string, to: string, description?: string): this {
    this.transitions.push({
      from,
      to,
      kind: 'on_failure',
      ...(description ? { description } : {}),
    } as ProductTransition);
    return this;
  }

  addRule(rule: ProductRule): this {
    this.rules.push(rule);
    return this;
  }

  addFee(fee: ProductFee): this {
    this.fees.push(fee);
    return this;
  }

  addLimit(limit: ProductLimit): this {
    this.limits.push(limit);
    return this;
  }

  /**
   * Binds a connector to a provider interface.
   *
   * Takes the interface, never a vendor name. There is no overload that takes one, and the
   * absence is the point: a composer that accepted `bindProvider('ABA', …)` would be a composer
   * through which vendor names enter product definitions.
   */
  bindProvider(
    providerInterface: string,
    connectorId: string,
    fallbackConnectorIds: string[] = [],
  ): this {
    const existing = this.providers.find(
      (provider) => provider.providerInterface === providerInterface,
    );

    if (existing) {
      this.providers[this.providers.indexOf(existing)] = {
        ...existing,
        connectorId,
        fallbackConnectorIds,
      };
      return this;
    }

    this.providers.push({
      providerInterface,
      required: true,
      connectorId,
      fallbackConnectorIds,
    });
    return this;
  }

  withSettlement(policy: NonNullable<ProductDefinition['settlementPolicy']>): this {
    this.settlementPolicy = policy;
    return this;
  }

  withReconciliation(policy: NonNullable<ProductDefinition['reconciliationPolicy']>): this {
    this.reconciliationPolicy = policy;
    return this;
  }

  withRiskPolicy(policy: ProductDefinition['riskPolicy']): this {
    this.riskPolicy = policy;
    return this;
  }

  expose(policy: Omit<ApiExposurePolicy, 'slug' | 'tenantScoped'> & { slug?: string }): this {
    this.apiExposure = { ...policy, slug: policy.slug ?? this.options.apiSlug, tenantScoped: true };
    return this;
  }

  /**
   * Builds the definition.
   *
   * Always `draft`. Composition is not approval, and a composer that could emit an `active`
   * product would be a way around the entire lifecycle — reachable from a script, in one line,
   * by anybody who could already compose.
   */
  build(): ProductDefinition {
    return productDefinitionSchema.parse({
      productId: this.options.productId,
      productName: this.options.productName,
      productType: this.options.productType,
      description: this.options.description,
      version: this.options.version,
      ownership: this.options.ownership,
      supportedCountries: this.options.supportedCountries ?? [],
      supportedCurrencies: this.options.supportedCurrencies,
      lifecycleStatus: 'draft',
      effectiveDate: this.options.effectiveDate,
      reviewDate: this.options.reviewDate,
      blocks: this.blocks,
      transitions: this.transitions,
      rules: this.rules,
      providers: this.providers,
      limits: this.limits,
      fees: this.fees,
      ...(this.settlementPolicy ? { settlementPolicy: this.settlementPolicy } : {}),
      ...(this.reconciliationPolicy ? { reconciliationPolicy: this.reconciliationPolicy } : {}),
      riskPolicy: this.riskPolicy,
      compliancePolicy: this.options.compliancePolicy,
      apiExposurePolicy: {
        exposed: false,
        slug: this.options.apiSlug ?? this.options.productId,
        operations: [],
        authentication: ['bearer'],
        tenantScoped: true,
        ...this.apiExposure,
      },
      auditClassification: this.options.auditClassification,
      tags: [],
    });
  }

  /** Builds and validates in one step. What the designer calls on every change. */
  buildAndValidate(options?: ValidateProductOptions): {
    definition: ProductDefinition;
    validation: ValidationResult;
  } {
    const definition = this.build();
    return { definition, validation: validateProduct(definition, options) };
  }
}

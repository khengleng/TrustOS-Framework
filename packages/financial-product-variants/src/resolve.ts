import {
  productDefinitionSchema,
  productError,
  type ProductDefinition,
  type ProductRule,
} from '@trustos/financial-product-core';
import { OVERRIDABLE_PATHS, type ProductVariant } from './variant';

/**
 * Resolving a variant against its base.
 *
 * The output is an *effective definition* plus a **provenance map** — which field came from
 * where. The provenance is not a debugging aid: it is what a reviewer reads when asked "is this
 * merchant on the standard rate", and what an incident investigation reads when a variant behaves
 * differently from the product it was supposed to be a small change to. A resolution that
 * produced only the merged document would leave both questions to be answered by diffing two
 * files, which is what everybody does today and why nobody does it.
 *
 * Three refusals, and each one is a control that would otherwise be reachable through a variant:
 *
 *   1. **Widening countries or currencies.** The base was approved for a set of jurisdictions.
 *      A variant adding one puts live transactions into a jurisdiction nobody reviewed, and it
 *      arrives on a form that says "variant configuration".
 *   2. **Removing or disabling a rule that denies or demands review.** This is the bypass the
 *      layer exists to prevent. A variant may make a control *stricter* — a lower threshold, an
 *      additional review — and may not make it looser.
 *   3. **Removing a fee or a limit.** Adding and changing are configuration; removing is the
 *      difference between a product that charges and one that does not, and between a product
 *      with a ceiling and one without.
 *
 * Merging is by identity, not by position. Fees merge by `code`, limits by `code`, rules by `id`,
 * providers by `providerInterface`. Positional merging would make the result depend on array
 * order, and array order changes when somebody prettifies a JSON file.
 */

export interface VariantProvenance {
  /** Every overridable path, and where its value came from. */
  source: Record<string, 'base' | 'variant' | 'merged'>;
  /** Individual items the variant replaced, by path and identity. */
  replaced: Array<{ path: string; identity: string }>;
  /** Individual items the variant added. */
  added: Array<{ path: string; identity: string }>;
}

export interface ResolvedVariant {
  definition: ProductDefinition;
  provenance: VariantProvenance;
  /** Approval levels this variant demands in addition to the base's. */
  additionalApprovalLevels: string[];
}

export function resolveVariant(
  base: ProductDefinition,
  variant: ProductVariant,
): ResolvedVariant {
  if (variant.baseProductId !== base.productId || variant.baseVersion !== base.version) {
    throw productError(
      'product_version_binding_broken',
      `Variant "${variant.variantId}" is bound to ${variant.baseProductId}@${variant.baseVersion} ` +
        `and was resolved against ${base.productId}@${base.version}. Resolving it anyway would ` +
        'apply overrides written for a different workflow.',
      {
        productId: base.productId,
        expected: `${variant.baseProductId}@${variant.baseVersion}`,
        actual: `${base.productId}@${base.version}`,
      },
    );
  }

  const provenance: VariantProvenance = { source: {}, replaced: [], added: [] };
  for (const path of OVERRIDABLE_PATHS) provenance.source[path] = 'base';

  const overrides = variant.overrides;

  const supportedCountries = narrowList(
    'supportedCountries',
    base.supportedCountries,
    overrides.supportedCountries,
    variant.variantId,
    provenance,
  );

  const supportedCurrencies = narrowList(
    'supportedCurrencies',
    base.supportedCurrencies,
    overrides.supportedCurrencies,
    variant.variantId,
    provenance,
  );

  const fees = mergeById('fees', base.fees, overrides.fees, (fee) => fee.code, variant.variantId, provenance);
  const limits = mergeById('limits', base.limits, overrides.limits, (limit) => limit.code, variant.variantId, provenance);
  const providers = mergeById(
    'providers',
    base.providers,
    overrides.providers,
    (provider) => provider.providerInterface,
    variant.variantId,
    provenance,
  );

  const rules = mergeRules(base.rules, overrides.rules, variant.variantId, provenance);

  for (const [path, value] of [
    ['settlementPolicy', overrides.settlementPolicy],
    ['compliancePolicy', overrides.compliancePolicy],
    ['riskPolicy', overrides.riskPolicy],
  ] as const) {
    if (value !== undefined) provenance.source[path] = 'variant';
  }

  if (overrides.additionalApprovalLevels?.length) {
    provenance.source.additionalApprovalLevels = 'variant';
  }

  /*
   * Parsed rather than spread.
   *
   * The merged object goes back through the schema, so an override that produces an invalid
   * document — fee tiers that no longer ascend, a settlement schedule that lost its cut-off — is
   * refused here rather than at execution time. A merge that skipped validation would let a
   * variant assemble a definition the composer would never have accepted.
   */
  const definition = productDefinitionSchema.parse({
    ...base,
    supportedCountries,
    supportedCurrencies,
    fees,
    limits,
    providers,
    rules,
    ...(overrides.settlementPolicy ? { settlementPolicy: overrides.settlementPolicy } : {}),
    ...(overrides.compliancePolicy ? { compliancePolicy: overrides.compliancePolicy } : {}),
    ...(overrides.riskPolicy ? { riskPolicy: overrides.riskPolicy } : {}),
  });

  return {
    definition,
    provenance,
    additionalApprovalLevels: [...(overrides.additionalApprovalLevels ?? [])].sort(),
  };
}

/**
 * A list a variant may only shrink.
 *
 * The refusal names the added entries specifically. "Countries must be a subset" sends somebody
 * to diff two arrays; "adds TH, VN" tells them what to remove or which approval to seek.
 */
function narrowList(
  path: string,
  baseValues: readonly string[],
  overrideValues: readonly string[] | undefined,
  variantId: string,
  provenance: VariantProvenance,
): string[] {
  if (!overrideValues) return [...baseValues];

  const allowed = new Set(baseValues);
  const added = overrideValues.filter((value) => !allowed.has(value));

  if (added.length > 0) {
    throw productError(
      'product_variant_override_refused',
      `Variant "${variantId}" adds ${added.join(', ')} to ${path}, which the base product was ` +
        'not approved for. Widening is a new base version with its own approval, not a variant ' +
        'override — otherwise a jurisdiction nobody reviewed goes live on a configuration form.',
      { expected: baseValues.join(', ') || '(none)', actual: added.join(', ') },
    );
  }

  provenance.source[path] = 'variant';
  return [...overrideValues];
}

/** Merges by identity, refusing a removal. */
function mergeById<T>(
  path: string,
  baseItems: readonly T[],
  overrideItems: readonly T[] | undefined,
  identityOf: (item: T) => string,
  variantId: string,
  provenance: VariantProvenance,
): T[] {
  if (!overrideItems) return [...baseItems];

  const overrideByIdentity = new Map(overrideItems.map((item) => [identityOf(item), item]));
  const baseIdentities = new Set(baseItems.map(identityOf));

  const merged = baseItems.map((item) => {
    const identity = identityOf(item);
    const replacement = overrideByIdentity.get(identity);
    if (!replacement) return item;

    provenance.replaced.push({ path, identity });
    return replacement;
  });

  for (const item of overrideItems) {
    const identity = identityOf(item);
    if (baseIdentities.has(identity)) continue;
    provenance.added.push({ path, identity });
    merged.push(item);
  }

  provenance.source[path] = merged.length === baseItems.length ? 'merged' : 'variant';

  /*
   * Removal is not expressible, and that is by construction rather than by check: the merge
   * starts from the base list and only ever replaces or appends. A variant cannot drop a fee or
   * a limit because there is no operation that would.
   */
  return merged;
}

/**
 * Merges rules, refusing one that weakens a control.
 *
 * A variant may replace a rule and may add one. It may not disable a base rule whose outcomes
 * include `deny` or `require_review`, and it may not replace one with a version that has dropped
 * those outcomes. Both would arrive looking like a pricing change and would remove a refusal.
 */
function mergeRules(
  baseRules: readonly ProductRule[],
  overrideRules: readonly ProductRule[] | undefined,
  variantId: string,
  provenance: VariantProvenance,
): ProductRule[] {
  if (!overrideRules) return [...baseRules];

  const overrideById = new Map(overrideRules.map((rule) => [rule.id, rule]));
  const baseIds = new Set(baseRules.map((rule) => rule.id));

  const merged = baseRules.map((rule) => {
    const replacement = overrideById.get(rule.id);
    if (!replacement) return rule;

    const controlling = rule.then.filter(
      (outcome) => outcome.kind === 'deny' || outcome.kind === 'require_review',
    );

    if (controlling.length > 0) {
      if (!replacement.enabled) {
        throw productError(
          'product_variant_override_refused',
          `Variant "${variantId}" disables rule "${rule.id}", which refuses or demands review. ` +
            'A variant may make a control stricter and may not make it looser.',
          { rule: rule.id, expected: 'enabled', actual: 'disabled' },
        );
      }

      const stillControls = replacement.then.some(
        (outcome) => outcome.kind === 'deny' || outcome.kind === 'require_review',
      );

      if (!stillControls) {
        throw productError(
          'product_variant_override_refused',
          `Variant "${variantId}" replaces rule "${rule.id}" with one that no longer refuses or ` +
            'demands review. That is a control removed through a configuration change.',
          { rule: rule.id, expected: 'deny or require_review', actual: replacement.then.map((outcome) => outcome.kind).join(', ') },
        );
      }
    }

    provenance.replaced.push({ path: 'rules', identity: rule.id });
    return replacement;
  });

  for (const rule of overrideRules) {
    if (baseIds.has(rule.id)) continue;
    provenance.added.push({ path: 'rules', identity: rule.id });
    merged.push(rule);
  }

  provenance.source.rules = 'variant';
  return merged;
}

/** Every field a variant actually changed. What governance turns into required approvals. */
export function changedPaths(provenance: VariantProvenance): string[] {
  return Object.entries(provenance.source)
    .filter(([, source]) => source !== 'base')
    .map(([path]) => path)
    .sort();
}

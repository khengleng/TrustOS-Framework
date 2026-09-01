import type { ProductDefinition, ProductType } from '@trustsystem/financial-product-core';
import { governanceEntry } from '@trustsystem/financial-product-governance';
import type { ProductRecord } from './store';
import { effectiveStatus } from './store';

/**
 * The searchable product catalog.
 *
 * Section 22's twelve columns, derived rather than stored. That distinction is the whole design:
 * a catalog with its own copy of a product's owner, status and countries is a catalog that
 * disagrees with the product within a month, and the disagreement is discovered by whoever
 * trusted the catalog.
 *
 * Deriving it means the catalog is always right and always a little expensive. For a catalog of
 * a few hundred products read by a person on a page, that is the correct trade. A deployment with
 * tens of thousands materialises this into a table and rebuilds it on publication — and gets the
 * staleness back, deliberately and with a job that owns it.
 */

export interface CatalogEntry {
  productId: string;
  productName: string;
  productType: ProductType;
  description: string;
  /** The version new executions bind to. Null when nothing is live. */
  activeVersion: string | null;
  /** Every published version, oldest first. */
  versions: string[];
  lifecycleStatus: string;
  businessOwner: string;
  technicalOwner: string;
  riskOwner: string;
  complianceOwner: string;
  countries: string[];
  currencies: string[];
  /** The exposed API paths, when the product is exposed. */
  apis: string[];
  /** Provider interfaces the product needs bound. Never vendor names. */
  providers: string[];
  /** Blocks it depends on, deduplicated. What a catalog reader means by "dependencies". */
  dependencies: string[];
  /** The slowest declared SLA across the product's blocks, in milliseconds. */
  slaMs: number | null;
  riskClassification: string;
  complianceClassification: string;
  reviewDate: string;
  tags: string[];
}

export function catalogEntry(record: ProductRecord): CatalogEntry | null {
  const definition = definitionFor(record);
  if (!definition) return null;

  const governance = governanceEntry(definition, null);

  return {
    productId: definition.productId,
    productName: definition.productName,
    productType: definition.productType,
    description: definition.description,
    activeVersion: record.activeVersion,
    versions: record.versions.map((version) => version.version),
    lifecycleStatus: effectiveStatus(record),
    businessOwner: governance.businessOwner,
    technicalOwner: governance.technicalOwner,
    riskOwner: governance.riskOwner,
    complianceOwner: governance.complianceOwner,
    countries: [...definition.supportedCountries],
    currencies: [...definition.supportedCurrencies],
    apis: definition.apiExposurePolicy.exposed
      ? definition.apiExposurePolicy.operations.map(
          (operation) =>
            `${operation.method} /v1/products/${definition.apiExposurePolicy.slug}${operation.path}`,
        )
      : [],
    providers: definition.providers.map((provider) => provider.providerInterface).sort(),
    dependencies: [...new Set(definition.blocks.map((block) => block.blockId))].sort(),
    slaMs: slowestSla(definition),
    riskClassification: riskClassificationOf(definition),
    complianceClassification: definition.compliancePolicy.dataClassification,
    reviewDate: definition.reviewDate,
    tags: [...definition.tags],
  };
}

/**
 * Which definition the catalog describes.
 *
 * The active version if there is one, otherwise the newest published, otherwise the draft. In
 * that order, because a catalog reader is asking "what does this product do *today*" and the
 * answer is what is live — a catalog that showed the draft for an active product would show a
 * fee nobody is being charged.
 */
function definitionFor(record: ProductRecord): ProductDefinition | null {
  if (record.activeVersion) {
    const active = record.versions.find((version) => version.version === record.activeVersion);
    if (active) return active.definition;
  }

  const newest = record.versions[record.versions.length - 1];
  return newest?.definition ?? record.draft;
}

function slowestSla(definition: ProductDefinition): number | null {
  const declared = definition.blocks
    .map((block) => block.slaMs)
    .filter((value): value is number => value !== undefined);

  return declared.length > 0 ? Math.max(...declared) : null;
}

/**
 * The product's risk classification, derived from its policy.
 *
 * `restricted` when it prohibits a risk level or reviews above a threshold, `standard` otherwise.
 * Derived rather than declared because a self-declared risk classification is the field everybody
 * sets to the value that needs the least approval.
 */
function riskClassificationOf(definition: ProductDefinition): string {
  if (definition.productType === 'lending') return 'high';
  if (definition.riskPolicy.prohibitedRiskLevels.length > 0) return 'elevated';
  if (definition.riskPolicy.enhancedReviewAbove) return 'elevated';
  return 'standard';
}

export interface CatalogQuery {
  /** Free text across name, description and tags. */
  text?: string;
  productType?: ProductType;
  status?: string;
  country?: string;
  currency?: string;
  /** Only products with an exposed API. */
  exposed?: boolean;
  /** Products whose review date has passed, relative to this instant. */
  reviewOverdueAt?: Date;
}

/**
 * Searches the catalog.
 *
 * Every filter narrows; there is no `OR` between fields. A search UI that combined filters with
 * `OR` returns more results when you add a filter, which nobody expects and everybody reports as
 * a bug.
 */
export function searchCatalog(
  records: readonly ProductRecord[],
  query: CatalogQuery = {},
): CatalogEntry[] {
  const text = query.text?.toLowerCase();

  return records
    .map(catalogEntry)
    .filter((entry): entry is CatalogEntry => entry !== null)
    .filter((entry) => {
      if (query.productType && entry.productType !== query.productType) return false;
      if (query.status && entry.lifecycleStatus !== query.status) return false;
      if (query.country && !entry.countries.includes(query.country)) return false;
      if (query.currency && !entry.currencies.includes(query.currency)) return false;
      if (query.exposed !== undefined && entry.apis.length > 0 !== query.exposed) return false;

      if (query.reviewOverdueAt && new Date(entry.reviewDate) >= query.reviewOverdueAt)
        return false;

      if (text) {
        const haystack =
          `${entry.productName} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }

      return true;
    })
    .sort((left, right) => left.productName.localeCompare(right.productName));
}

/** Counts by category, for the catalog landing page. */
export function catalogSummary(records: readonly ProductRecord[]): {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  exposed: number;
  reviewOverdue: number;
} {
  const entries = records
    .map(catalogEntry)
    .filter((entry): entry is CatalogEntry => entry !== null);

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};

  for (const entry of entries) {
    byType[entry.productType] = (byType[entry.productType] ?? 0) + 1;
    byStatus[entry.lifecycleStatus] = (byStatus[entry.lifecycleStatus] ?? 0) + 1;
  }

  return {
    total: entries.length,
    byType,
    byStatus,
    exposed: entries.filter((entry) => entry.apis.length > 0).length,
    reviewOverdue: 0,
  };
}

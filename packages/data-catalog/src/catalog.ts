import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import {
  DATA_CLASSIFICATION_LEVELS,
  combineClassifications,
  type DataClassificationLevel,
} from '@trustsystem/data-classification';

/**
 * The data catalog.
 *
 * What governed data exists, what it means, who owns it and how sensitive it is. Nine entity
 * kinds, because the question "where is customer data" is answered wrongly if the catalog only
 * knows about tables — it is also in an event payload, an API response, a report and an AI
 * knowledge source, and those are the copies nobody remembers.
 *
 * Two decisions shape the schema.
 *
 * **A business name is required.** A catalog of `cust_acct_st_cd` with no business name is a
 * catalog only the person who wrote the column can read, and they are the one person who did not
 * need it. It is the field most likely to be skipped and the one that decides whether anybody
 * uses the catalog at all.
 *
 * **Classification is per entry and inherited upward.** A column is classified; a table takes the
 * highest of its columns; a report takes the highest of its sources. `inheritedClassification`
 * computes it rather than trusting a declaration, because a table declared `internal` whose
 * columns include a national identifier is the commonest classification error there is.
 */

export const CATALOG_ENTITY_KINDS = [
  'database',
  'table',
  'column',
  'api_field',
  'event_schema',
  'report',
  'document_type',
  'ai_knowledge_source',
  'financial_object',
] as const;

export type CatalogEntityKind = (typeof CATALOG_ENTITY_KINDS)[number];

export const catalogEntrySchema = z
  .object({
    entryId: z.string().regex(/^[a-z][a-z0-9_.:-]{2,119}$/),
    kind: z.enum(CATALOG_ENTITY_KINDS),

    /** What the system calls it. */
    technicalName: z.string().min(1).max(200),
    /**
     * What a person calls it.
     *
     * Required. A catalog of technical names is a catalog only its authors can read, and they
     * are the people who did not need one.
     */
    businessName: z.string().min(3).max(200),
    description: z.string().min(10).max(600),

    /** The parent entry, for a column in a table or a field in an event. */
    parentId: z.string().max(120).nullable(),

    owner: z.string().min(1).max(80),
    steward: z.string().min(1).max(80),
    businessDomain: z.string().min(1).max(80),

    /** Declared classification. `inheritedClassification` may compute a stricter one. */
    classification: z.enum(DATA_CLASSIFICATION_LEVELS),
    /** Whether this entry carries personal data. Drives masking and retention independently. */
    personalData: z.boolean().default(false),

    environment: z.enum(['dev', 'uat', 'prod']),
    /** Where it physically lives. Checked against the residency policy. */
    residencyRegion: z.string().min(2).max(40),

    /** What it is for. The lawful basis a retention rule and an access review both read. */
    purpose: z.string().min(10).max(400),
    legalBasis: z.string().max(200).nullable(),

    /** Entries that read this one. Maintained by lineage rather than by hand where possible. */
    downstreamConsumers: z.array(z.string().max(120)).max(200).default([]),

    lastReviewDate: z.string().datetime().nullable(),
    nextReviewDate: z.string().datetime(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.personalData && entry.classification === 'PUBLIC') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['classification'],
        message:
          'An entry carrying personal data cannot be PUBLIC. If it genuinely is public, it is ' +
          'not personal data — and if it is personal data, publishing it is the finding.',
      });
    }

    if (entry.kind === 'column' && entry.parentId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parentId'],
        message: 'A column belongs to a table. An orphaned column cannot inherit a classification.',
      });
    }
  });

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * The catalog.
 *
 * Tenant-agnostic on purpose: a data catalog describes the *schema* of a platform rather than one
 * organization's rows. Per-tenant sensitivity differences are a residency and access question,
 * handled in `data-access-policy`, not a second catalog.
 */
export class DataCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  constructor(entries: readonly CatalogEntry[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register(input: unknown): CatalogEntry {
    const entry = catalogEntrySchema.parse(input);

    if (this.entries.has(entry.entryId)) {
      throw new ApiError('conflict', {
        message: `The catalog entry "${entry.entryId}" is already registered.`,
        context: { entryId: entry.entryId },
      });
    }

    if (entry.parentId && !this.entries.has(entry.parentId)) {
      throw new ApiError('validation_error', {
        message:
          `The parent "${entry.parentId}" is not in the catalog. Register the table before its ` +
          'columns — a column whose parent is missing cannot inherit a classification, and ' +
          'inheritance is what catches the wrongly-classified table.',
        context: { entryId: entry.entryId, parentId: entry.parentId },
      });
    }

    this.entries.set(entry.entryId, entry);
    return entry;
  }

  find(entryId: string): CatalogEntry | undefined {
    return this.entries.get(entryId);
  }

  require(entryId: string): CatalogEntry {
    const entry = this.find(entryId);

    if (!entry) {
      throw new ApiError('not_found', {
        message: `No catalog entry "${entryId}". Governed data is catalogued before it is used.`,
        context: { entryId },
      });
    }

    return entry;
  }

  children(entryId: string): CatalogEntry[] {
    return [...this.entries.values()]
      .filter((entry) => entry.parentId === entryId)
      .sort((left, right) => left.entryId.localeCompare(right.entryId));
  }

  /**
   * The classification an entry actually carries.
   *
   * The highest of its own and every descendant's. A table declared `INTERNAL` whose columns
   * include a national identifier is `HIGHLY_RESTRICTED`, whatever the table row says — and that
   * is the commonest classification error there is, because tables are classified when they are
   * created and columns are added later.
   */
  inheritedClassification(entryId: string): DataClassificationLevel {
    const entry = this.require(entryId);
    const descendants = this.children(entryId);

    return combineClassifications(
      entry.classification,
      ...descendants.map((child) => this.inheritedClassification(child.entryId)),
    );
  }

  /** Entries whose declared classification is below what they actually contain. */
  misclassified(): Array<{
    entryId: string;
    declared: DataClassificationLevel;
    actual: DataClassificationLevel;
  }> {
    return [...this.entries.values()]
      .map((entry) => ({
        entryId: entry.entryId,
        declared: entry.classification,
        actual: this.inheritedClassification(entry.entryId),
      }))
      .filter((entry) => entry.declared !== entry.actual);
  }

  /**
   * Searches the catalog.
   *
   * **Sensitive schema metadata is not returned to somebody who may not see it.** An unauthorized
   * search returns the entry's existence and its business name, and not its technical name, its
   * description or its lineage — because a description saying "the customer's national identifier
   * and its issuing authority" is itself a disclosure about what the platform holds.
   */
  search(query: {
    text?: string;
    kind?: CatalogEntityKind;
    classification?: DataClassificationLevel;
    domain?: string;
    personalData?: boolean;
    environment?: 'dev' | 'uat' | 'prod';
    /** Whether the caller may see full metadata. Resolved server-side. */
    authorized: boolean;
  }): Array<Partial<CatalogEntry> & { entryId: string; businessName: string }> {
    const text = query.text?.toLowerCase();

    return [...this.entries.values()]
      .filter((entry) => {
        if (query.kind && entry.kind !== query.kind) return false;
        if (query.classification && entry.classification !== query.classification) return false;
        if (query.domain && entry.businessDomain !== query.domain) return false;
        if (query.personalData !== undefined && entry.personalData !== query.personalData)
          return false;
        if (query.environment && entry.environment !== query.environment) return false;

        if (text) {
          const haystack = `${entry.businessName} ${entry.businessDomain}`.toLowerCase();
          if (!haystack.includes(text)) return false;
        }

        return true;
      })
      .map((entry) =>
        query.authorized
          ? entry
          : {
              entryId: entry.entryId,
              businessName: entry.businessName,
              kind: entry.kind,
              classification: entry.classification,
              owner: entry.owner,
            },
      )
      .sort((left, right) => left.entryId.localeCompare(right.entryId));
  }

  /** Entries whose review has passed. */
  overdueReviews(asOf: Date): CatalogEntry[] {
    return [...this.entries.values()].filter((entry) => new Date(entry.nextReviewDate) < asOf);
  }

  all(): CatalogEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }
}

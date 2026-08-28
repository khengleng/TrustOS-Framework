import { describe, expect, it } from 'vitest';
import { DataCatalog, catalogEntrySchema } from './index';

function entry(overrides: Record<string, unknown> = {}) {
  return catalogEntrySchema.parse({
    entryId: 'db.core.customer',
    kind: 'table',
    technicalName: 'customer',
    businessName: 'Customer',
    description: 'One row per customer of the platform.',
    parentId: null,
    owner: 'usr_data',
    steward: 'usr_steward',
    businessDomain: 'customer',
    classification: 'CONFIDENTIAL',
    personalData: true,
    environment: 'prod',
    residencyRegion: 'ap-southeast-1',
    purpose: 'Operating the customer’s account and answering their questions.',
    legalBasis: 'contract',
    nextReviewDate: '2026-12-31T00:00:00.000Z',
    lastReviewDate: null,
    ...overrides,
  });
}

describe('catalog entries', () => {
  it('requires a business name', () => {
    // A catalog of technical names is a catalog only its authors can read, and they are the
    // people who did not need one.
    expect(() => entry({ businessName: 'x' })).toThrow();
  });

  it('refuses personal data classified PUBLIC', () => {
    expect(() => entry({ classification: 'PUBLIC' })).toThrow(/cannot be PUBLIC/);
  });

  it('refuses an orphaned column', () => {
    expect(() => entry({ kind: 'column', parentId: null })).toThrow(/belongs to a table/);
  });

  it('covers the nine entity kinds the specification names', () => {
    for (const kind of [
      'database',
      'table',
      'column',
      'api_field',
      'event_schema',
      'report',
      'document_type',
      'ai_knowledge_source',
      'financial_object',
    ] as const) {
      expect(() =>
        entry({
          entryId: `x.${kind}`,
          kind,
          parentId: kind === 'column' ? 'db.core.customer' : null,
        }),
      ).not.toThrow();
    }
  });
});

describe('the catalog', () => {
  it('refuses a column whose parent is not registered', () => {
    const catalog = new DataCatalog();

    expect(() =>
      catalog.register(
        entry({ entryId: 'db.core.customer.name', kind: 'column', parentId: 'db.core.customer' }),
      ),
    ).toThrow(/Register the table before its columns/);
  });

  it('refuses a duplicate', () => {
    const catalog = new DataCatalog([entry()]);
    expect(() => catalog.register(entry())).toThrow(/already registered/);
  });

  it('refuses a lookup for something ungoverned', () => {
    expect(() => new DataCatalog().require('db.core.nothing')).toThrow(
      /catalogued before it is used/,
    );
  });
});

describe('inherited classification', () => {
  it('takes the highest of a table and its columns', () => {
    // Tables are classified when they are created and columns are added later. This is the
    // commonest classification error there is.
    const catalog = new DataCatalog([
      entry({ classification: 'INTERNAL', personalData: false }),
      entry({
        entryId: 'db.core.customer.national_id',
        kind: 'column',
        parentId: 'db.core.customer',
        businessName: 'National identifier',
        technicalName: 'national_id',
        classification: 'HIGHLY_RESTRICTED',
      }),
    ]);

    expect(catalog.inheritedClassification('db.core.customer')).toBe('HIGHLY_RESTRICTED');
  });

  it('reports every entry whose declaration is below its content', () => {
    const catalog = new DataCatalog([
      entry({ classification: 'INTERNAL', personalData: false }),
      entry({
        entryId: 'db.core.customer.national_id',
        kind: 'column',
        parentId: 'db.core.customer',
        businessName: 'National identifier',
        technicalName: 'national_id',
        classification: 'HIGHLY_RESTRICTED',
      }),
    ]);

    const misclassified = catalog.misclassified();
    expect(misclassified).toHaveLength(1);
    expect(misclassified[0]).toEqual({
      entryId: 'db.core.customer',
      declared: 'INTERNAL',
      actual: 'HIGHLY_RESTRICTED',
    });
  });

  it('reports nothing when the declaration matches', () => {
    expect(new DataCatalog([entry()]).misclassified()).toEqual([]);
  });
});

describe('search', () => {
  const catalog = new DataCatalog([entry()]);

  it('returns full metadata to an authorized caller', () => {
    const [result] = catalog.search({ authorized: true, text: 'customer' });
    expect(result?.description).toContain('One row per customer');
    expect(result?.technicalName).toBe('customer');
  });

  it('withholds sensitive schema metadata from an unauthorized one', () => {
    // A description saying "the customer's national identifier and its issuing authority" is
    // itself a disclosure about what the platform holds.
    const [result] = catalog.search({ authorized: false, text: 'customer' });

    expect(result?.businessName).toBe('Customer');
    expect(result?.description).toBeUndefined();
    expect(result?.technicalName).toBeUndefined();
    expect(result?.purpose).toBeUndefined();
  });

  it('narrows with every filter', () => {
    expect(catalog.search({ authorized: true, kind: 'table' })).toHaveLength(1);
    expect(catalog.search({ authorized: true, kind: 'report' })).toHaveLength(0);
    expect(catalog.search({ authorized: true, personalData: true })).toHaveLength(1);
    expect(catalog.search({ authorized: true, personalData: false })).toHaveLength(0);
    expect(catalog.search({ authorized: true, kind: 'table', environment: 'dev' })).toHaveLength(0);
  });

  it('reports overdue reviews', () => {
    expect(catalog.overdueReviews(new Date('2027-01-01'))).toHaveLength(1);
    expect(catalog.overdueReviews(new Date('2026-01-01'))).toHaveLength(0);
  });
});

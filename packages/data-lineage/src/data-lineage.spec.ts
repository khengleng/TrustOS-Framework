import { describe, expect, it } from 'vitest';
import { DataCatalog, catalogEntrySchema } from '@trustos/data-catalog';
import { LineageGraph, importScanned, lineageEdgeSchema } from './index';

const NOW = '2026-06-01T00:00:00.000Z';

function entry(entryId: string, classification: string, overrides: Record<string, unknown> = {}) {
  return catalogEntrySchema.parse({
    entryId,
    kind: 'table',
    technicalName: entryId,
    businessName: entryId,
    description: `The ${entryId} entry, for the lineage suite.`,
    parentId: null,
    owner: 'usr_data',
    steward: 'usr_steward',
    businessDomain: 'finance',
    classification,
    personalData: false,
    environment: 'prod',
    residencyRegion: 'ap-southeast-1',
    purpose: 'Exercising the lineage graph.',
    legalBasis: null,
    nextReviewDate: '2026-12-31T00:00:00.000Z',
    lastReviewDate: null,
    ...overrides,
  });
}

function edge(from: string, to: string, overrides: Record<string, unknown> = {}) {
  return lineageEdgeSchema.parse({
    fromEntryId: from,
    toEntryId: to,
    relation: 'copied_from',
    recordedAt: NOW,
    ...overrides,
  });
}

describe('edges', () => {
  it('refuses an edge to itself', () => {
    expect(() => edge('a.b', 'a.b')).toThrow(/cycle of length one/);
  });

  it('refuses a copy that declassifies', () => {
    // A copy of restricted data is restricted data.
    expect(() =>
      edge('a.b', 'c.d', { declassifiesTo: 'PUBLIC', declassificationReason: 'x'.repeat(30) }),
    ).toThrow(/cannot declassify/);
  });

  it('permits an aggregate that declassifies, with a reason', () => {
    expect(() =>
      edge('a.b', 'c.d', {
        relation: 'aggregated_from',
        declassifiesTo: 'INTERNAL',
        declassificationReason: 'A daily count of transactions is not a transaction.',
      }),
    ).not.toThrow();
  });

  it('refuses a declassification with no reason', () => {
    // Without one it is a re-labelling, and the label is what every downstream control reads.
    expect(() =>
      edge('a.b', 'c.d', { relation: 'aggregated_from', declassifiesTo: 'PUBLIC' }),
    ).toThrow(/needs a reason/);
  });
});

describe('walking the graph', () => {
  const graph = new LineageGraph([
    edge('db.ledger', 'warehouse.postings'),
    edge('warehouse.postings', 'report.monthly'),
    edge('report.monthly', 'dashboard.finance'),
  ]);

  it('answers "if we delete this, what breaks"', () => {
    expect(graph.downstreamOf('db.ledger')).toEqual([
      'warehouse.postings',
      'report.monthly',
      'dashboard.finance',
    ]);
  });

  it('answers "where did this come from"', () => {
    expect(graph.upstreamOf('dashboard.finance')).toEqual([
      'report.monthly',
      'warehouse.postings',
      'db.ledger',
    ]);
  });

  it('terminates on a cycle', () => {
    // Lineage graphs do contain cycles: a report feeds a table that feeds the report next
    // quarter.
    const cyclic = new LineageGraph([edge('a.b', 'c.d'), edge('c.d', 'a.b')]);
    expect(cyclic.downstreamOf('a.b')).toEqual(['c.d']);
  });

  it('bounds the walk', () => {
    expect(graph.downstreamOf('db.ledger', 1)).toEqual(['warehouse.postings']);
  });
});

describe('propagated classification', () => {
  const catalog = new DataCatalog([
    entry('db.ledger', 'HIGHLY_RESTRICTED'),
    entry('warehouse.postings', 'INTERNAL'),
    entry('report.monthly', 'INTERNAL'),
  ]);

  it('carries the source classification downstream', () => {
    // A report declared INTERNAL whose sources include the ledger is not internal, and nobody
    // would notice by reading the report's own row.
    const graph = new LineageGraph([
      edge('db.ledger', 'warehouse.postings'),
      edge('warehouse.postings', 'report.monthly'),
    ]);

    expect(graph.propagatedClassification('report.monthly', catalog)).toBe('HIGHLY_RESTRICTED');
  });

  it('stops at a declared declassifying edge', () => {
    const graph = new LineageGraph([
      edge('db.ledger', 'warehouse.postings', {
        relation: 'aggregated_from',
        declassifiesTo: 'INTERNAL',
        declassificationReason: 'A monthly total is not a set of postings.',
      }),
      edge('warehouse.postings', 'report.monthly'),
    ]);

    expect(graph.propagatedClassification('report.monthly', catalog)).toBe('INTERNAL');
  });

  it('reports every entry whose declaration is below what flows into it', () => {
    const graph = new LineageGraph([edge('db.ledger', 'report.monthly')]);
    const drift = graph.classificationDrift(catalog);

    expect(drift.find((entry) => entry.entryId === 'report.monthly')).toEqual({
      entryId: 'report.monthly',
      declared: 'INTERNAL',
      propagated: 'HIGHLY_RESTRICTED',
    });
  });
});

describe('importing from a scanner', () => {
  it('marks scanned edges as scanned', () => {
    const graph = new LineageGraph();

    return importScanned(graph, {
      name: 'test-scanner',
      scan: async () => [edge('a.b', 'c.d')],
    }).then((result) => {
      expect(result.imported).toBe(1);
      // So an investigation can weigh "somebody said so" differently from "a tool inferred it".
      expect(graph.edgesFrom('a.b')[0]?.source).toBe('scanned');
    });
  });

  it('reports a rejected edge rather than dropping it', async () => {
    // A scanner that silently loses edges produces a graph that is confidently incomplete, and
    // the gaps are invisible.
    const graph = new LineageGraph();

    const result = await importScanned(graph, {
      name: 'broken-scanner',
      scan: async () => [
        { fromEntryId: 'a.b', toEntryId: 'a.b', relation: 'copied_from', recordedAt: NOW } as never,
      ],
    });

    expect(result.imported).toBe(0);
    expect(result.rejected).toHaveLength(1);
  });
});

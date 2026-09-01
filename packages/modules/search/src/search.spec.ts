import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustsystem/errors';
import { createTestModuleContext, type RecordingAuditPort } from '@trustsystem/module-sdk';
import { runInTenantContext } from '@trustsystem/tenancy';
import { createStaticSearchAdapter, type SearchAdapter, type SearchHit } from './adapter';
import { searchConfigSchema } from './config';
import { sourceOrderRanker, weightedRanker } from './ranking';
import { createSearch, searchModule } from './search.module';
import type { SearchService } from './search.service';

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const MERCHANT_READ = 'merchant.merchant.read';
const PAYOUT_READ = 'payments.payout.read';

interface Harness {
  service: SearchService;
  audit: RecordingAuditPort;
}

const merchants = createStaticSearchAdapter({
  id: 'merchants',
  label: 'Merchants',
  permission: MERCHANT_READ,
  fields: ['name', 'reference'],
  titleField: 'name',
  rows: [
    { id: 'm1', organizationId: ACME, name: 'Acme Coffee', reference: 'ACME-1' },
    { id: 'm2', organizationId: ACME, name: 'Coffee Republic', reference: 'CR-9' },
    { id: 'm3', organizationId: RIVAL, name: 'Rival Coffee', reference: 'RIV-1' },
  ],
});

const payouts = createStaticSearchAdapter({
  id: 'payouts',
  label: 'Payouts',
  permission: PAYOUT_READ,
  fields: ['reference', 'note'],
  titleField: 'reference',
  rows: [
    { id: 'p1', organizationId: ACME, reference: 'COFFEE-PAYOUT', note: 'For Acme Coffee' },
    { id: 'p2', organizationId: RIVAL, reference: 'RIVAL-PAYOUT', note: 'Secret' },
  ],
});

function buildHarness(config: Record<string, unknown> = {}, extra: SearchAdapter[] = []): Harness {
  const { context, audit } = createTestModuleContext(searchModule, { config });
  const instance = createSearch(context);

  instance.service.register(merchants);
  instance.service.register(payouts);
  for (const adapter of extra) instance.service.register(adapter);

  return { service: instance.service, audit };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('search permission filtering', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('searches only sources the caller may read', async () => {
    const result = await asAcme(() =>
      harness.service.search({ term: 'coffee' }, ACME, [MERCHANT_READ]),
    );

    // The payouts row matching "coffee" must not appear: the caller cannot read
    // that source, so it was never queried.
    expect(result.items.map((hit) => hit.source)).toEqual(['merchants', 'merchants']);
  });

  it('searches every source for a caller holding both permissions', async () => {
    const result = await asAcme(() =>
      harness.service.search({ term: 'coffee' }, ACME, [MERCHANT_READ, PAYOUT_READ]),
    );

    expect(new Set(result.items.map((hit) => hit.source))).toEqual(
      new Set(['merchants', 'payouts']),
    );
  });

  it('returns nothing when the caller holds no source permission', async () => {
    const result = await asAcme(() => harness.service.search({ term: 'coffee' }, ACME, []));
    expect(result.items).toHaveLength(0);
    expect(result.meta.totalItems).toBe(0);
  });

  it('lists only sources the caller may search', () => {
    expect(harness.service.sources([MERCHANT_READ]).map((source) => source.id)).toEqual([
      'merchants',
    ]);
    expect(harness.service.sources(['*'])).toHaveLength(2);
  });

  it('treats a source the caller cannot read as one that does not exist', async () => {
    try {
      await asAcme(() =>
        harness.service.search({ term: 'coffee', sources: ['payouts'] }, ACME, [MERCHANT_READ]),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      // Otherwise asking for a source is a way to discover which ones exist.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('rejects an unknown source rather than ignoring it', async () => {
    await expect(
      asAcme(() => harness.service.search({ term: 'coffee', sources: ['ghost'] }, ACME, ['*'])),
    ).rejects.toThrow(/No searchable source/);
  });

  it('refuses to register two adapters with the same id', () => {
    expect(() => harness.service.register(merchants)).toThrowError(/already registered/);
  });
});

describe('search tenant isolation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('returns only rows belonging to the calling organization', async () => {
    const acme = await asAcme(() => harness.service.search({ term: 'coffee' }, ACME, ['*']));
    expect(acme.items.every((hit) => hit.organizationId === ACME)).toBe(true);

    const rival = await asRival(() => harness.service.search({ term: 'coffee' }, RIVAL, ['*']));
    expect(rival.items.map((hit) => hit.id)).toEqual(['m3']);
  });

  it('drops and audits a hit an adapter returned from another organization', async () => {
    const leaky: SearchAdapter = {
      id: 'leaky',
      label: 'Leaky',
      permission: MERCHANT_READ,
      search: async (): Promise<SearchHit[]> => [
        {
          id: 'x1',
          organizationId: RIVAL,
          source: 'leaky',
          title: 'Rival secret',
          snippet: null,
          matched: {},
        },
      ],
    };

    const withLeak = buildHarness({}, [leaky]);
    const result = await asAcme(() => withLeak.service.search({ term: 'secret' }, ACME, ['*']));

    expect(result.items).toHaveLength(0);
    // An adapter returning another organization's rows is a defect that has to
    // surface somewhere, and the audit trail is read.
    expect(withLeak.audit.byAction('search.result.dropped')[0]?.after).toMatchObject({
      dropped: 1,
    });
  });

  it('fails closed when there is no tenant context at all', async () => {
    // The tenant is resolved before any adapter runs, so a search with no
    // context cannot reach the data.
    await expect(harness.service.search({ term: 'coffee' }, '', ['*'])).rejects.toThrow();
  });

  it('attributes the query audit record to the calling organization', async () => {
    await asAcme(() => harness.service.search({ term: 'coffee' }, ACME, ['*']));
    expect(harness.audit.byAction('search.query.executed')[0]?.organizationId).toBe(ACME);
  });
});

describe('audit of search terms', () => {
  it('records the term, because that is what an investigation asks about', async () => {
    const harness = buildHarness();
    await asAcme(() => harness.service.search({ term: 'coffee' }, ACME, ['*']));

    expect(harness.audit.byAction('search.query.executed')[0]?.after).toMatchObject({
      term: 'coffee',
      results: 3,
    });
  });

  it('never records the results themselves', async () => {
    const harness = buildHarness();
    await asAcme(() => harness.service.search({ term: 'coffee' }, ACME, ['*']));

    // A trail of what someone found is a second copy of the data with different
    // access controls.
    expect(harness.audit.serialized()).not.toContain('Coffee Republic');
  });

  it('can be turned off per organization', async () => {
    const harness = buildHarness({ auditSearchTerms: false });
    await asAcme(() => harness.service.search({ term: 'sensitive name' }, ACME, ['*']));

    const record = harness.audit.byAction('search.query.executed')[0];
    expect(record?.after).not.toHaveProperty('term');
    expect(record?.after).toMatchObject({ results: 0 });
  });
});

describe('ranking and pagination', () => {
  it('ranks an exact title match above a partial one', async () => {
    const harness = buildHarness();
    const result = await asAcme(() => harness.service.search({ term: 'Acme Coffee' }, ACME, ['*']));

    expect(result.items[0]?.id).toBe('m1');
  });

  it('is stable, so pagination does not repeat or skip a row', () => {
    const hits: SearchHit[] = [
      { id: 'b', organizationId: ACME, source: 'x', title: 'same', snippet: null, matched: {} },
      { id: 'a', organizationId: ACME, source: 'x', title: 'same', snippet: null, matched: {} },
    ];

    // An unstable ranking returns the same row on two pages and skips another.
    expect(weightedRanker.rank(hits, 'same').map((hit) => hit.id)).toEqual(['a', 'b']);
    expect(weightedRanker.rank([...hits].reverse(), 'same').map((hit) => hit.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps source order when weighted ranking is off', async () => {
    const harness = buildHarness({ weightedRanking: false });
    const result = await asAcme(() => harness.service.search({ term: 'coffee' }, ACME, ['*']));

    expect(result.items[0]?.source).toBe('merchants');
    expect(sourceOrderRanker.id).toBe('source-order');
  });

  it('paginates after ranking, not before', async () => {
    const harness = buildHarness();
    const first = await asAcme(() =>
      harness.service.search({ term: 'coffee', page: 1, pageSize: 1 }, ACME, ['*']),
    );
    const second = await asAcme(() =>
      harness.service.search({ term: 'coffee', page: 2, pageSize: 1 }, ACME, ['*']),
    );

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    expect(first.meta.totalItems).toBe(3);
  });

  it('caps the page size and the per-source fan-out', async () => {
    const harness = buildHarness({ maxPageSize: 1, maxResultsPerSource: 1 });
    const result = await asAcme(() =>
      harness.service.search({ term: 'coffee', pageSize: 50 }, ACME, ['*']),
    );

    expect(result.meta.pageSize).toBe(1);
    // One row per source rather than everything each source could return.
    expect(result.meta.totalItems).toBe(2);
  });
});

describe('resilience', () => {
  it('keeps searching when one adapter fails', async () => {
    const broken: SearchAdapter = {
      id: 'broken',
      label: 'Broken',
      permission: MERCHANT_READ,
      search: async () => {
        throw new Error('index unavailable');
      },
    };

    const harness = buildHarness({}, [broken]);
    const result = await asAcme(() => harness.service.search({ term: 'coffee' }, ACME, ['*']));

    // One adapter throwing must not take down a search across five sources.
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('rejects a term that is too short to be a search', async () => {
    const harness = buildHarness();
    // A one-character term matches most of a database and costs as much as a
    // full scan per source.
    await expect(
      asAcme(() => harness.service.search({ term: 'a' }, ACME, ['*'])),
    ).rejects.toThrow();
  });
});

describe('configuration validation', () => {
  it('installs with no configuration at all', () => {
    expect(searchConfigSchema.parse({})).toEqual({
      maxResultsPerSource: 25,
      maxPageSize: 50,
      weightedRanking: true,
      auditSearchTerms: true,
    });
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    expect(searchConfigSchema.safeParse({ maxResults: 10 }).success).toBe(false);
  });
});

describe('lifecycle', () => {
  it('needs no database, because it owns no tables', async () => {
    const { context } = createTestModuleContext(searchModule, { prisma: null });
    await expect(createSearch(context).initialize()).resolves.toBeUndefined();
  });

  it('reports no registered sources as degraded rather than healthy', async () => {
    const { context } = createTestModuleContext(searchModule, { prisma: null });
    const instance = createSearch(context);

    // A search box that returns nothing looks identical to one wired wrongly.
    expect((await instance.healthIndicator().check()).status).toBe('degraded');

    instance.service.register(merchants);
    expect((await instance.healthIndicator().check()).status).toBe('ok');
  });
});

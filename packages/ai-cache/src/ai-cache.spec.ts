import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message } from '@trustos/ai-sdk';
import {
  AiCache,
  InMemoryCacheStore,
  buildCacheKey,
  cachePolicySchema,
  promptFingerprint,
} from './cache';

let clock = new Date('2026-10-01T10:00:00Z');

function cache(policy: Record<string, unknown> = { enabled: true }) {
  const store = new InMemoryCacheStore();
  return {
    store,
    cache: new AiCache({ store, policy: cachePolicySchema.parse(policy), now: () => clock }),
  };
}

const key = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org_1' as string | null,
  kind: 'completion' as const,
  modelId: 'test.small',
  cacheKey: 'question-1',
  ...overrides,
});

beforeEach(() => {
  clock = new Date('2026-10-01T10:00:00Z');
});

describe('the cache key', () => {
  it('always includes the organization', () => {
    // The cross-tenant leak this prevents has no error, no log line and no external symptom.
    expect(buildCacheKey(key({ organizationId: 'org_1' }))).not.toBe(
      buildCacheKey(key({ organizationId: 'org_2' })),
    );
  });

  it('keeps the organization readable in the key, so a tenant can be invalidated', () => {
    expect(buildCacheKey(key())).toMatch(/^ai:org_1:completion:/);
  });

  it('distinguishes platform scope from a tenant named with an empty string', () => {
    // A database will happily store an organization id of "".
    expect(buildCacheKey(key({ organizationId: null }))).toMatch(/^ai:platform:/);
    expect(buildCacheKey(key({ organizationId: null }))).not.toBe(
      buildCacheKey(key({ organizationId: '' })),
    );
  });

  it('changes with the model, because two models answer differently', () => {
    expect(buildCacheKey(key({ modelId: 'a' }))).not.toBe(buildCacheKey(key({ modelId: 'b' })));
  });

  it('changes with the prompt version, so republishing invalidates', () => {
    expect(buildCacheKey(key({ promptVersion: '1' }))).not.toBe(
      buildCacheKey(key({ promptVersion: '2' })),
    );
  });

  it('is stable across discriminator ordering', () => {
    expect(buildCacheKey(key({ discriminators: { a: 1, b: 2 } }))).toBe(
      buildCacheKey(key({ discriminators: { b: 2, a: 1 } })),
    );
  });

  it('changes with temperature, which changes the answer', () => {
    expect(buildCacheKey(key({ discriminators: { temperature: 0 } }))).not.toBe(
      buildCacheKey(key({ discriminators: { temperature: 1 } })),
    );
  });

  it('fingerprints a conversation by its content', () => {
    const a = promptFingerprint([message.user('hello')]);
    const b = promptFingerprint([message.user('hello')]);
    const c = promptFingerprint([message.user('goodbye')]);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('reading and writing', () => {
  it('returns a stored value', async () => {
    const { cache: target } = cache();

    await target.set({ ...key(), value: { content: 'cached answer' } });

    expect(await target.get(key())).toEqual({ content: 'cached answer' });
  });

  it('does not return another tenant’s value', async () => {
    const { cache: target } = cache();
    await target.set({ ...key({ organizationId: 'org_1' }), value: 'tenant one' });

    expect(await target.get(key({ organizationId: 'org_2' }))).toBeNull();
  });

  it('discards an entry whose organization does not match the key', async () => {
    /*
     * Belt and braces: the key contains the organization, so this can only happen if something is
     * very wrong. It is checked because the consequence of failing silently is one tenant reading
     * another's answer.
     */
    const error = vi.fn();
    const store = new InMemoryCacheStore();
    const target = new AiCache({
      store,
      policy: cachePolicySchema.parse({ enabled: true }),
      now: () => clock,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error,
        fatal: vi.fn(),
        child: vi.fn(),
      } as never,
    });

    await store.set({
      key: buildCacheKey(key()),
      organizationId: 'org_2',
      kind: 'completion',
      value: 'wrong tenant',
      savedCostCents: 0,
      savedTokens: 0,
      createdAt: clock,
      expiresAt: new Date(clock.getTime() + 60_000),
      hits: 0,
    });

    expect(await target.get(key())).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('is off by default', async () => {
    // A default-on cache means somebody eventually caches something personal.
    const { cache: target } = cache({});

    await target.set({ ...key(), value: 'x' });

    expect(await target.get(key())).toBeNull();
    expect(target.enabled).toBe(false);
  });

  it('skips a request that opted out', async () => {
    const { cache: target } = cache();
    await target.set({ ...key(), value: 'x' });

    expect(await target.get({ ...key(), allowedByPolicy: false })).toBeNull();
  });

  it('does not cache content with detected PII', async () => {
    // A cached answer containing personal data is that data at rest somewhere nobody classified.
    const { cache: target } = cache();

    expect(await target.set({ ...key(), value: 'x', containsPii: true })).toBe(false);
    expect(await target.get(key())).toBeNull();
  });

  it('refuses an oversized value', async () => {
    const { cache: target } = cache({ enabled: true, maxValueBytes: 100 });

    expect(await target.set({ ...key(), value: 'x'.repeat(500) })).toBe(false);
  });
});

describe('expiry', () => {
  it('does not return an expired entry', async () => {
    const { cache: target } = cache({ enabled: true, ttlSeconds: 60 });
    await target.set({ ...key(), value: 'stale' });

    clock = new Date(clock.getTime() + 61_000);

    expect(await target.get(key())).toBeNull();
  });

  it('deletes an expired entry on read rather than waiting for a sweep', async () => {
    // A stale entry read once and removed beats one that lingers until a background job that may
    // not be running.
    const { store, cache: target } = cache({ enabled: true, ttlSeconds: 60 });
    await target.set({ ...key(), value: 'stale' });

    clock = new Date(clock.getTime() + 61_000);
    await target.get(key());

    expect(await store.size()).toBe(0);
  });

  it('has a short default TTL, because a stale answer is a confident wrong answer', () => {
    expect(cachePolicySchema.parse({}).ttlSeconds).toBe(900);
  });

  it('purges expired entries in bulk', async () => {
    const { cache: target } = cache({ enabled: true, ttlSeconds: 60 });
    await target.set({ ...key({ cacheKey: 'a' }), value: 1 });
    await target.set({ ...key({ cacheKey: 'b' }), value: 2 });

    clock = new Date(clock.getTime() + 61_000);

    expect(await target.purgeExpired()).toBe(2);
  });
});

describe('invalidation', () => {
  it('removes every entry for a tenant', async () => {
    // What a data-deletion request needs: cached answers gone too.
    const { cache: target } = cache();
    await target.set({ ...key({ cacheKey: 'a' }), value: 1 });
    await target.set({ ...key({ cacheKey: 'b' }), value: 2 });
    await target.set({ ...key({ organizationId: 'org_2' }), value: 3 });

    expect(await target.invalidateOrganization('org_1')).toBe(2);
    expect(await target.get(key({ organizationId: 'org_2' }))).toBe(3);
  });

  it('removes one kind for one tenant', async () => {
    const { cache: target } = cache();
    await target.set({ ...key({ kind: 'completion' }), value: 1 });
    await target.set({ ...key({ kind: 'embedding' }), value: 2 });

    expect(await target.invalidateKind('org_1', 'completion')).toBe(1);
    expect(await target.get(key({ kind: 'embedding' }))).toBe(2);
  });
});

describe('metrics', () => {
  it('reports hits, misses and the saving', async () => {
    const { cache: target } = cache();
    await target.set({ ...key(), value: 'x', savedCostCents: 12, savedTokens: 500 });

    await target.get(key());
    await target.get(key({ cacheKey: 'other' }));

    const metrics = target.metrics();
    expect(metrics).toMatchObject({ hits: 1, misses: 1, savedCostCents: 12, savedTokens: 500 });
    expect(metrics.hitRate).toBe(0.5);
  });

  it('does not count skipped lookups against the hit rate', async () => {
    // Including them would make a disabled cache look like a cache with a terrible hit rate.
    const { cache: target } = cache({});

    await target.get(key());
    await target.get(key());

    expect(target.metrics()).toMatchObject({ skipped: 2, hitRate: 0 });
    expect(target.metrics().misses).toBe(0);
  });

  it('counts a hit on the stored entry, so a report can find hot keys', async () => {
    const { store, cache: target } = cache();
    await target.set({ ...key(), value: 'x' });

    await target.get(key());
    await target.get(key());

    expect((await store.get(buildCacheKey(key())))?.hits).toBe(2);
  });
});

describe('the in-memory store', () => {
  it('bounds itself, because an unbounded cache of AI responses is a memory leak', async () => {
    const store = new InMemoryCacheStore(5);

    for (let index = 0; index < 20; index += 1) {
      await store.set({
        key: `ai:org_1:completion:${index}`,
        organizationId: 'org_1',
        kind: 'completion',
        value: index,
        savedCostCents: 0,
        savedTokens: 0,
        createdAt: clock,
        expiresAt: new Date(clock.getTime() + 60_000),
        hits: 0,
      });
    }

    expect(await store.size()).toBeLessThanOrEqual(5);
  });
});

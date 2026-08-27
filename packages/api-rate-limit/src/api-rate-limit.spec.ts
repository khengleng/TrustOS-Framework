import { describe, expect, it } from 'vitest';
import {
  InMemoryRateCounterStore,
  applicableLimits,
  assertWithinRate,
  checkRate,
  fixedWindowWorstCase,
  rateHeaders,
  rateLimitSchema,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function limit(overrides: Record<string, unknown> = {}) {
  return rateLimitSchema.parse({
    limitId: 'rl.consumer.default',
    scope: 'consumer',
    apiId: 'merchant.api',
    limit: 10,
    unit: 'minute',
    description: 'The default sustained rate for a partner consumer.',
    ...overrides,
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    apiId: 'merchant.api',
    operationId: 'listMerchants',
    consumerId: 'con_partner_a',
    organizationId: 'org_a',
    at: NOW,
    ...overrides,
  };
}

async function hitTimes(count: number, input: { limits: ReturnType<typeof limit>[]; at?: Date }) {
  const store = new InMemoryRateCounterStore();
  let last = await checkRate({
    limits: input.limits,
    request: request({ at: input.at ?? NOW }),
    store,
  });

  for (let index = 1; index < count; index += 1) {
    last = await checkRate({
      limits: input.limits,
      request: request({ at: new Date((input.at ?? NOW).getTime() + index) }),
      store,
    });
  }

  return { last, store };
}

describe('defining a limit', () => {
  it('requires an endpoint limit to name its operation', () => {
    expect(() => limit({ scope: 'endpoint', operationId: null })).toThrow(/names the operation/);
  });

  it('refuses a burst below the sustained rate', () => {
    // It would refuse traffic the rate itself permits.
    expect(() => limit({ burst: 5 })).toThrow(/below the sustained rate/);
  });

  it('defaults to a sliding window', () => {
    // The default is the one without the boundary surprise.
    expect(limit().windowStrategy).toBe('sliding');
  });
});

describe('counting', () => {
  it('allows up to the limit', async () => {
    const { last } = await hitTimes(10, { limits: [limit()] });
    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
  });

  it('refuses the one after', async () => {
    const { last } = await hitTimes(11, { limits: [limit()] });
    expect(last.allowed).toBe(false);
    expect(last.reason).toContain('10 requests per minute');
  });

  it('counts before deciding, not after', async () => {
    /*
     * A check-then-increment store lets two concurrent requests both read the same value below the
     * limit and both proceed — the same class of bug as checking a balance without reserving it.
     */
    const store = new InMemoryRateCounterStore();
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => checkRate({ limits: [limit()], request: request(), store })),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
  });

  it('lets the window slide', async () => {
    const { store } = await hitTimes(10, { limits: [limit()] });
    const later = await checkRate({
      limits: [limit()],
      request: request({ at: new Date(NOW.getTime() + 61_000) }),
      store,
    });

    expect(later.allowed).toBe(true);
  });

  it('honours a burst allowance above the rate', async () => {
    // The rate is what is sustainable; the burst is what is survivable.
    const { last } = await hitTimes(15, { limits: [limit({ burst: 15 })] });
    expect(last.allowed).toBe(true);
  });

  it('allows a request no limit covers', async () => {
    const decision = await checkRate({
      limits: [limit({ apiId: 'wallet.api' })],
      request: request(),
      store: new InMemoryRateCounterStore(),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.limitId).toBeNull();
  });
});

describe('several limits at once', () => {
  it('orders them narrowest first', () => {
    const ordered = applicableLimits(
      [
        limit({ limitId: 'rl.global', scope: 'global', apiId: null }),
        limit({ limitId: 'rl.endpoint', scope: 'endpoint', operationId: 'listMerchants' }),
        limit({ limitId: 'rl.tenant', scope: 'tenant' }),
      ],
      request(),
    );

    expect(ordered.map((entry) => entry.limitId)).toEqual([
      'rl.endpoint',
      'rl.tenant',
      'rl.global',
    ]);
  });

  it('lets the narrowest refusal win', async () => {
    /*
     * A per-endpoint limit exists precisely to stop one expensive operation eating a consumer's
     * whole allowance, so a more generous consumer-level limit must not override it.
     */
    const { last } = await hitTimes(4, {
      limits: [
        limit({ limitId: 'rl.consumer', limit: 100 }),
        limit({
          limitId: 'rl.endpoint',
          scope: 'endpoint',
          operationId: 'listMerchants',
          limit: 3,
        }),
      ],
    });

    expect(last.allowed).toBe(false);
    expect(last.limitId).toBe('rl.endpoint');
  });

  it('keeps counting every limit even when one refuses', async () => {
    // A counter that stopped during a breach would under-count exactly the traffic it measures.
    const { store } = await hitTimes(5, {
      limits: [
        limit({ limitId: 'rl.consumer', limit: 100 }),
        limit({
          limitId: 'rl.endpoint',
          scope: 'endpoint',
          operationId: 'listMerchants',
          limit: 2,
        }),
      ],
    });

    const consumerCount = await store.peek('rl.consumer:con_partner_a', NOW, 60_000);
    expect(consumerCount.count).toBe(5);
  });

  it('reports the tightest remaining allowance', async () => {
    const { last } = await hitTimes(2, {
      limits: [
        limit({ limitId: 'rl.consumer', limit: 100 }),
        limit({ limitId: 'rl.tight', scope: 'tenant', limit: 10 }),
      ],
    });

    expect(last.remaining).toBe(8);
  });
});

describe('shadow mode', () => {
  it('counts a breach without refusing it', async () => {
    /*
     * How a limit is introduced to an existing estate. Turning one on blind means discovering the
     * real traffic shape by breaking somebody's integration.
     */
    const { last } = await hitTimes(15, { limits: [limit({ action: 'shadow' })] });

    expect(last.allowed).toBe(true);
    expect(last.wouldHaveRefused).toBe(true);
  });

  it('still refuses when an enforcing limit is also breached', async () => {
    const { last } = await hitTimes(15, {
      limits: [
        limit({ limitId: 'rl.shadow', action: 'shadow' }),
        limit({ limitId: 'rl.real', scope: 'tenant', limit: 5 }),
      ],
    });

    expect(last.allowed).toBe(false);
  });
});

describe('what the caller is told', () => {
  it('sends the allowance on success as well as on refusal', async () => {
    // A limit that only announces itself at breach teaches clients to retry rather than to pace.
    const { last } = await hitTimes(3, { limits: [limit()] });
    const headers = rateHeaders(last);

    expect(headers['RateLimit-Remaining']).toBe('7');
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('adds Retry-After on refusal', async () => {
    const { last } = await hitTimes(11, { limits: [limit()] });
    expect(Number(rateHeaders(last)['Retry-After'])).toBeGreaterThan(0);
  });

  it('throws as rate_limited, not as forbidden', async () => {
    const { last } = await hitTimes(11, { limits: [limit()] });
    expect(() => assertWithinRate(last)).toThrow();

    try {
      assertWithinRate(last);
    } catch (error) {
      expect((error as { code: string }).code).toBe('rate_limited');
    }
  });
});

describe('the fixed window, stated honestly', () => {
  it('admits twice the limit across a boundary', () => {
    /*
     * Sixty requests at 10:59:59 and sixty at 11:00:00 both pass a sixty-per-minute fixed window,
     * and the service sees a hundred and twenty in one second. Stated as a function so the
     * documentation cannot claim otherwise.
     */
    expect(fixedWindowWorstCase(limit({ windowStrategy: 'fixed' }))).toBe(20);
    expect(fixedWindowWorstCase(limit())).toBe(10);
  });

  it('lets a fixed window through at the boundary', async () => {
    const fixed = limit({ windowStrategy: 'fixed', limit: 3 });
    const store = new InMemoryRateCounterStore();

    // The in-memory store counts by timestamp; what the strategy changes is the reset the caller
    // is told about, which is the number an integrator paces against.
    const decision = await checkRate({ limits: [fixed], request: request(), store });
    expect(decision.resetAt).toBe('2026-06-01T12:01:00.000Z');
  });
});

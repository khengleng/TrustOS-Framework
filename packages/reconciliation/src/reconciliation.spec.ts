import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { ReconciliationService, compare } from './reconciliation';
import { InMemoryReconciliationStore } from './testing';

/**
 * The comparison tests are the point.
 *
 * A reconciliation that reports a single number has told nobody anything actionable, and one that
 * matches on amount alone pairs two unrelated payments and reports a clean run — which is worse
 * than reporting two exceptions.
 */

const currencies = new CurrencyRegistry();

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function detailsOf(error: unknown): string {
  const details = (error as { details?: Array<{ message: string }> }).details ?? [];
  return details.map((detail) => detail.message).join(' | ');
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a throw and got none.');
}

function setup() {
  const store = new InMemoryReconciliationStore();
  const audit = { record: vi.fn() };

  return {
    store,
    audit,
    reconciliation: new ReconciliationService({
      store,
      currencies,
      audit,
      now: () => clock,
      newId: (prefix) => `${prefix}_${(counter += 1)}`,
    }),
  };
}

const record = (
  reference: string,
  amount: string,
  sourceId: string,
  at: Date = new Date('2026-03-01T08:00:00.000Z'),
) => ({
  reference,
  amount: { currency: 'USD', amount },
  at,
  sourceId,
  description: '',
  metadata: {},
});

const run = (
  reconciliation: ReconciliationService,
  internal: ReturnType<typeof record>[],
  external: ReturnType<typeof record>[],
  overrides: Record<string, unknown> = {},
) =>
  reconciliation.run({
    organizationId: 'org_a',
    key: 'bank.usd',
    kind: 'external',
    currency: 'USD',
    windowStart: new Date('2026-02-28T00:00:00.000Z'),
    windowEnd: new Date('2026-03-01T00:00:00.000Z'),
    internal,
    external,
    actorId: 'usr_ops',
    ...overrides,
  });

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('matching', () => {
  it('matches by reference and reports a clean run', async () => {
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1'), record('REF-2', '50.00', 'jrn_2')],
      [record('REF-1', '100.00', 'bank_1'), record('REF-2', '50.00', 'bank_2')],
    );

    expect(result.run.matchedCount).toBe(2);
    expect(result.exceptions).toEqual([]);
    expect(formatMoney(money(result.run.difference.amount, 'USD', currencies))).toBe('0.00 USD');
  });

  it('does not pair two unrelated payments of the same amount', async () => {
    /*
     * Amount-only matching would report this as clean. It is two references that do not exist on
     * the other side, which is two investigations.
     */
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '50.00', 'jrn_1')],
      [record('REF-9', '50.00', 'bank_9')],
    );

    expect(result.run.matchedCount).toBe(0);
    expect(result.exceptions.map((exception) => exception.kind).sort()).toEqual([
      'missing_external',
      'missing_internal',
    ]);
  });
});

describe('exceptions', () => {
  it('reports money the platform does not know about as the most urgent kind', async () => {
    const { reconciliation } = setup();

    const result = await run(reconciliation, [], [record('REF-9', '250.00', 'bank_9')]);

    const exception = result.exceptions[0]!;

    expect(exception.kind).toBe('missing_internal');
    expect(exception.detail).toMatch(/most urgent kind of exception/);
    expect(exception.externalId).toBe('bank_9');
  });

  it('reports a posting the counterparty never saw', async () => {
    const { reconciliation } = setup();

    const result = await run(reconciliation, [record('REF-1', '100.00', 'jrn_1')], []);

    expect(result.exceptions[0]!.kind).toBe('missing_external');
    expect(result.exceptions[0]!.internalId).toBe('jrn_1');
  });

  it('reports an amount mismatch with both sides and the difference', async () => {
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1')],
      [record('REF-1', '99.50', 'bank_1')],
    );

    const exception = result.exceptions[0]!;

    expect(exception.kind).toBe('amount_mismatch');
    expect(exception.detail).toMatch(
      /"REF-1": internal 100.00 USD, external 99.50 USD, a difference of -0.50 USD/,
    );
  });

  it('reports a duplicate internal posting before trying to match it', async () => {
    /*
     * Matching one of them would leave the other looking like an orphan and hide the duplication,
     * which is almost always a double posting.
     */
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1'), record('REF-1', '100.00', 'jrn_2')],
      [record('REF-1', '100.00', 'bank_1')],
    );

    expect(result.exceptions[0]!.kind).toBe('duplicate_internal');
    expect(result.exceptions[0]!.detail).toMatch(/usually a double posting/);
    expect(result.exceptions[0]!.internalId).toBe('jrn_1, jrn_2');
  });

  it('reports a duplicate on the counterparty’s side too', async () => {
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1')],
      [record('REF-1', '100.00', 'bank_1'), record('REF-1', '100.00', 'bank_2')],
    );

    expect(result.exceptions[0]!.kind).toBe('duplicate_external');
    expect(result.exceptions[0]!.detail).toMatch(/may have sent the same item twice/);
  });
});

describe('tolerance', () => {
  it('lets a rounding difference through when the tolerance says so', async () => {
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1')],
      [record('REF-1', '100.01', 'bank_1')],
      {
        tolerance: { amount: '0.01', reason: 'Card networks round to the cent on conversion.' },
      },
    );

    expect(result.exceptions).toEqual([]);
    expect(result.run.matchedCount).toBe(1);
  });

  it('still catches a difference past the tolerance', async () => {
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1')],
      [record('REF-1', '100.02', 'bank_1')],
      { tolerance: { amount: '0.01', reason: 'Rounding.' } },
    );

    expect(result.exceptions[0]!.kind).toBe('amount_mismatch');
    expect(result.exceptions[0]!.detail).toMatch(/against a tolerance of 0.01 USD/);
  });

  it('tolerates in both directions', async () => {
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1')],
      [record('REF-1', '99.99', 'bank_1')],
      { tolerance: { amount: '0.01', reason: 'Rounding.' } },
    );

    expect(result.exceptions).toEqual([]);
  });

  it('records why the tolerance exists', async () => {
    // In a year the only question anybody asks about a tolerance is why.
    const { reconciliation } = setup();

    const result = await run(reconciliation, [], [], {
      tolerance: { amount: '0.05', reason: 'Provider rounds each leg independently.' },
    });

    expect(result.run.tolerance.reason).toBe('Provider rounds each leg independently.');
  });

  it('defaults to exact matching and says so', async () => {
    const { reconciliation } = setup();
    const result = await run(reconciliation, [], []);

    expect(result.run.tolerance.amount).toBe('0');
    expect(result.run.tolerance.reason).toMatch(/no difference is tolerated/);
  });

  it('flags a date gap without calling it a failure', async () => {
    // Settlement genuinely takes days; a gap that grows month over month is a counterparty whose
    // processing is slipping.
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1', new Date('2026-03-01T00:00:00.000Z'))],
      [record('REF-1', '100.00', 'bank_1', new Date('2026-03-04T00:00:00.000Z'))],
      { tolerance: { dateMs: 48 * 3_600_000, reason: 'Settlement takes up to two days.' } },
    );

    expect(result.exceptions[0]!.kind).toBe('date_mismatch');
    expect(result.exceptions[0]!.detail).toMatch(/72 hours apart, against a tolerance of 48/);
    // Still counted as matched: the money is there, the timing is the observation.
    expect(result.run.matchedCount).toBe(1);
  });
});

describe('totals', () => {
  it('reports both sides and the difference', async () => {
    const { reconciliation } = setup();

    const result = await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1'), record('REF-2', '50.00', 'jrn_2')],
      [record('REF-1', '100.00', 'bank_1')],
    );

    expect(result.run.internalTotal.amount).toBe('150.00');
    expect(result.run.externalTotal.amount).toBe('100.00');
    expect(result.run.difference.amount).toBe('-50.00');
  });

  it('refuses a run with mixed currencies', async () => {
    const { reconciliation } = setup();

    const error = await caught(() =>
      run(
        reconciliation,
        [record('REF-1', '100.00', 'jrn_1')],
        [
          {
            reference: 'REF-1',
            amount: { currency: 'KHR', amount: '400000' },
            at: clock,
            sourceId: 'bank_1',
            description: '',
            metadata: {},
          },
        ],
      ),
    );

    expect(detailsOf(error)).toMatch(/has a difference that means nothing/);
  });
});

describe('the exception queue', () => {
  it('assigns an exception to somebody', async () => {
    // A queue that nobody owns is a list that grows.
    const { reconciliation } = setup();

    const result = await run(reconciliation, [], [record('REF-9', '250.00', 'bank_9')]);

    const assigned = await reconciliation.assign({
      id: result.exceptions[0]!.id,
      organizationId: 'org_a',
      assignTo: 'usr_ops',
    });

    expect(assigned.status).toBe('investigating');
    expect(assigned.assignedTo).toBe('usr_ops');
  });

  it('requires an explanation to resolve one', async () => {
    /*
     * A closed ticket with no explanation means the same difference appears next month with
     * nobody knowing it was already looked at.
     */
    const { reconciliation } = setup();
    const result = await run(reconciliation, [], [record('REF-9', '250.00', 'bank_9')]);

    const error = await caught(() =>
      reconciliation.resolve({
        id: result.exceptions[0]!.id,
        organizationId: 'org_a',
        resolution: '   ',
      }),
    );

    expect(detailsOf(error)).toMatch(/appears next month with nobody knowing/);
  });

  it('records the correcting journal when there was one', async () => {
    const { reconciliation } = setup();
    const result = await run(reconciliation, [], [record('REF-9', '250.00', 'bank_9')]);

    const resolved = await reconciliation.resolve({
      id: result.exceptions[0]!.id,
      organizationId: 'org_a',
      resolution: 'A deposit we had not recorded. Posted to suspense and identified.',
      correctionJournalId: 'jrn_correction',
      actorId: 'usr_ops',
    });

    expect(resolved.status).toBe('resolved');
    expect(resolved.correctionJournalId).toBe('jrn_correction');
  });

  it('distinguishes a write-off from a resolution', async () => {
    const { reconciliation } = setup();
    const result = await run(reconciliation, [], [record('REF-9', '0.02', 'bank_9')]);

    const written = await reconciliation.resolve({
      id: result.exceptions[0]!.id,
      organizationId: 'org_a',
      resolution: 'Two cents. Below the cost of investigating.',
      writeOff: true,
    });

    expect(written.status).toBe('written_off');
  });

  it('refuses to resolve twice', async () => {
    const { reconciliation } = setup();
    const result = await run(reconciliation, [], [record('REF-9', '250.00', 'bank_9')]);

    await reconciliation.resolve({
      id: result.exceptions[0]!.id,
      organizationId: 'org_a',
      resolution: 'Found it.',
    });

    await expect(
      reconciliation.resolve({
        id: result.exceptions[0]!.id,
        organizationId: 'org_a',
        resolution: 'Again.',
      }),
    ).rejects.toThrow(/already resolved/);
  });

  it('reports the oldest open exception, which is the number to watch', async () => {
    /*
     * A queue with a six-week-old item is a queue where somebody has decided, without saying so,
     * that one difference is not worth investigating.
     */
    const { reconciliation } = setup();

    await run(reconciliation, [], [record('REF-9', '250.00', 'bank_9')]);

    clock = new Date(clock.getTime() + 6 * 7 * 86_400_000);

    const health = await reconciliation.queueHealth('org_a');

    expect(health.open).toBe(1);
    expect(health.oldestOpenAgeMs).toBe(6 * 7 * 86_400_000);
    expect(health.byKind.missing_internal).toBe(1);
  });

  it('does not show one tenant another’s exceptions', async () => {
    const { reconciliation } = setup();
    await run(reconciliation, [], [record('REF-9', '250.00', 'bank_9')]);

    expect((await reconciliation.queueHealth('org_b')).open).toBe(0);
  });
});

describe('the pure comparison', () => {
  it('gives the same answer on every machine', () => {
    // The most common question about a reconciliation is "why did it match last month and not
    // this month", and a comparison that depends on anything but its inputs cannot answer it.
    const inputs = {
      internal: [record('REF-1', '100.00', 'jrn_1')],
      external: [record('REF-1', '99.00', 'bank_1')],
      tolerance: { amount: '0', dateMs: 0, reason: 'Exact.' },
      currency: 'USD',
      currencies,
    };

    const first = compare(inputs);
    const second = compare(inputs);

    expect(first.exceptions.map((exception) => exception.detail)).toEqual(
      second.exceptions.map((exception) => exception.detail),
    );
  });
});

describe('audit', () => {
  it('records the run with its counts and its tolerance', async () => {
    const { reconciliation, audit } = setup();

    await run(
      reconciliation,
      [record('REF-1', '100.00', 'jrn_1')],
      [record('REF-1', '99.00', 'bank_1')],
      { tolerance: { amount: '0.01', reason: 'Rounding.' } },
    );

    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'reconciliation.run.completed',
      actorId: 'usr_ops',
      after: expect.objectContaining({
        key: 'bank.usd',
        exceptions: 1,
        difference: '-1.00 USD',
        tolerance: '0.01',
      }),
    });
  });
});

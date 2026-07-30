#!/usr/bin/env node
/**
 * Phase 8 benchmarks.
 *
 * Framework overhead only: no database, no network. What is measured is the arithmetic and the
 * in-process work a financial operation costs on top of whatever the database does — which is the
 * only part this repository controls.
 *
 * The number worth watching is the decimal arithmetic. It is the reason the phase does not use
 * floats, so it had better not be the reason a payment is slow.
 *
 *   npm run build:packages && node scripts/bench-financial.mjs
 */
import { performance } from 'node:perf_hooks';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => import(join(root, 'packages', name, 'dist/index.js'));

const core = await load('financial-core');
const { assertBalanced, credit, debit, Ledger, InMemoryLedgerStore } = await load('ledger');
const { AccountService, InMemoryAccountStore, normalBalance } = await load('accounts');
const { calculateFee, feeScheduleSchema } = await load('fees');
const { LimitEngine, InMemoryLimitStore, limitSchema, windowFor } = await load('limits');
const { compare } = await load('reconciliation');
const { applySpread } = await load('fx');

function bench(name, iterations, fn) {
  for (let i = 0; i < Math.min(iterations, 500); i += 1) fn();

  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  const elapsed = performance.now() - started;

  report(name, iterations, elapsed);
}

async function benchAsync(name, iterations, fn) {
  for (let i = 0; i < Math.min(iterations, 100); i += 1) await fn(i);

  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) await fn(i);
  const elapsed = performance.now() - started;

  report(name, iterations, elapsed);
}

function report(name, iterations, elapsed) {
  const perOp = elapsed / iterations;
  const unit =
    perOp < 0.001 ? `${(perOp * 1_000_000).toFixed(0)}ns` : `${(perOp * 1000).toFixed(1)}µs`;

  console.log(
    `  ${name.padEnd(44)} ${unit.padStart(9)}  ${Math.round(iterations / (elapsed / 1000))
      .toLocaleString('en-US')
      .padStart(11)} ops/s`,
  );
}

const currencies = new core.CurrencyRegistry();
const usd = (amount) => core.money(amount, 'USD', currencies);

const a = core.parseDecimal('1234.56');
const b = core.parseDecimal('0.025');

console.log('\ndecimal arithmetic');
bench('parseDecimal', 500_000, () => core.parseDecimal('1234.56'));
bench('add', 1_000_000, () => core.add(a, b));
bench('multiply (exact)', 1_000_000, () => core.multiply(a, b));
bench('divide (4 dp, half_even)', 500_000, () => core.divide(a, b, 4));
bench('scaleTo (round to 2 dp)', 1_000_000, () => core.scaleTo(core.multiply(a, b), 2));
bench('formatDecimal', 1_000_000, () => core.formatDecimal(a));
bench('allocate (3 ways)', 200_000, () => core.allocate(a, [1, 1, 1]));
bench('allocate (100 ways)', 20_000, () =>
  core.allocate(a, Array.from({ length: 100 }, () => 1)),
);

console.log('\nmoney');
const left = usd('1234.56');
const right = usd('99.99');

bench('money (parse and scale)', 300_000, () => usd('1234.56'));
bench('addMoney', 1_000_000, () => core.addMoney(left, right));
bench('multiplyMoney (2.5% fee)', 300_000, () => core.multiplyMoney(left, b, currencies));
bench('allocateMoney (3 ways)', 200_000, () => core.allocateMoney(left, [1, 1, 1]));
bench('formatMoney', 1_000_000, () => core.formatMoney(left));
bench('moneyToJson', 1_000_000, () => core.moneyToJson(left));

console.log('\nledger');
const entries = [
  { ...debit('acc_customer', usd('102.50')), id: 'e1' },
  { ...credit('acc_merchant', usd('100.00')), id: 'e2' },
  { ...credit('acc_fee', usd('2.50')), id: 'e3' },
];

bench('assertBalanced (3 entries)', 200_000, () => assertBalanced(entries, currencies));

const wide = Array.from({ length: 200 }, (_, index) =>
  index === 0
    ? { ...debit('acc_settlement', usd('1000.00')), id: 'e0' }
    : { ...credit(`acc_merchant_${index}`, usd('5.0251256281')), id: `e${index}` },
);

// A settlement batch's journal: one debit and many credits. Deliberately mismatched, so what is
// measured is the arithmetic rather than an early exit.
bench('checkBalance (200 entries)', 20_000, () => {
  try {
    assertBalanced(wide, currencies);
  } catch {
    /* the sum is what is being measured */
  }
});

let counter = 0;
const clock = new Date('2026-03-01T09:00:00.000Z');

const ledgerStore = new InMemoryLedgerStore(currencies);
const ledger = new Ledger({
  store: ledgerStore,
  currencies,
  now: () => clock,
  newId: (prefix) => `${prefix}_${(counter += 1)}`,
});

await benchAsync('Ledger.post (3 entries, in memory)', 20_000, (index) =>
  ledger.post({
    organizationId: 'org_a',
    description: 'Card payment',
    entries: [
      debit('acc_customer', usd('102.50')),
      credit('acc_merchant', usd('100.00')),
      credit('acc_fee', usd('2.50')),
    ],
    idempotencyKey: `bench_${index}`,
  }),
);

const accounts = new AccountService({
  store: new InMemoryAccountStore(),
  ledger,
  currencies,
  now: () => clock,
  newId: (prefix) => `${prefix}_${(counter += 1)}`,
});

const account = await accounts.open({
  organizationId: 'org_a',
  code: 'customer.bench.usd',
  name: 'Bench',
  type: 'customer',
  currency: 'USD',
});

bench('normalBalance (sign flip)', 1_000_000, () => normalBalance(account, left));
await benchAsync('accounts.balance (20k journals)', 200, () => accounts.balance(account));

console.log('\nfees');
const schedule = feeScheduleSchema.parse({
  id: 'fee_1',
  organizationId: 'org_a',
  key: 'payment.standard',
  version: 1,
  name: 'Standard',
  currency: 'USD',
  components: [
    { name: 'Processing', kind: 'percentage', basisPoints: 250 },
    { name: 'Network', kind: 'flat', amount: '0.30' },
    { name: 'VAT', kind: 'tax', basisPoints: 1000 },
  ],
  maximumFee: '50.00',
  status: 'published',
  effectiveFrom: clock,
  createdAt: clock,
});

bench('calculateFee (3 components + cap)', 200_000, () =>
  calculateFee({ schedule, amount: left, currencies }),
);

const tiered = feeScheduleSchema.parse({
  ...schedule,
  components: [
    {
      name: 'Processing',
      kind: 'tiered',
      tiers: [
        { fromAmount: '0.00', toAmount: '100.00', basisPoints: 300 },
        { fromAmount: '100.00', toAmount: '1000.00', basisPoints: 200 },
        { fromAmount: '1000.00', toAmount: null, basisPoints: 100, flatAmount: '1.00' },
      ],
    },
  ],
  maximumFee: null,
});

bench('calculateFee (3 tiers)', 200_000, () =>
  calculateFee({ schedule: tiered, amount: left, currencies }),
);

console.log('\nlimits');
const limitStore = new InMemoryLimitStore(currencies);

limitStore.add(
  limitSchema.parse({
    id: 'lmt_1',
    organizationId: 'org_a',
    key: 'wallet.daily.usd',
    name: 'daily',
    scope: 'wallet',
    window: 'day',
    timezone: 'Asia/Phnom_Penh',
    currency: 'USD',
    maxAmount: '1000000.00',
    createdAt: clock,
    updatedAt: clock,
  }),
);

const limits = new LimitEngine({ store: limitStore, currencies, now: () => clock });
const limitInput = {
  organizationId: 'org_a',
  scope: 'wallet',
  subjectId: 'wlt_1',
  amount: usd('10.00'),
};

bench('windowFor (calendar day, zoned)', 200_000, () =>
  windowFor(limitStore.limits[0], clock),
);
await benchAsync('LimitEngine.check', 50_000, () => limits.check(limitInput));

console.log('\nfx');
const rate = core.parseDecimal('4090.12345678');
bench('applySpread (50bp)', 500_000, () => applySpread(rate, 50));
bench('convert arithmetic (multiply + scale)', 300_000, () =>
  core.multiplyMoney(left, rate, currencies),
);

console.log('\nreconciliation');
const record = (index, amount) => ({
  reference: `REF-${index}`,
  amount: { currency: 'USD', amount },
  at: clock,
  sourceId: `src_${index}`,
  description: '',
  metadata: {},
});

for (const size of [100, 1000, 10_000]) {
  const internal = Array.from({ length: size }, (_, index) => record(index, '100.00'));
  const external = Array.from({ length: size }, (_, index) =>
    record(index, index % 50 === 0 ? '99.99' : '100.00'),
  );

  const iterations = size >= 10_000 ? 20 : size >= 1000 ? 200 : 2_000;

  bench(`compare (${size.toLocaleString('en-US')} x ${size.toLocaleString('en-US')})`, iterations, () =>
    compare({
      internal,
      external,
      tolerance: { amount: '0', dateMs: 0, reason: 'Exact.' },
      currency: 'USD',
      currencies,
    }),
  );
}

console.log('');

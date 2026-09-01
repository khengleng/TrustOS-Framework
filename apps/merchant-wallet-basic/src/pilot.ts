import { AccountService, InMemoryAccountStore } from '@trustsystem/accounts';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import { InMemoryLedgerStore, Ledger } from '@trustsystem/ledger';
import { InMemoryLimitStore, LimitEngine, limitSchema, type Limit } from '@trustsystem/limits';
import { feeScheduleSchema, type FeeSchedule } from '@trustsystem/fees';
import { InMemoryHoldStore, InMemoryWalletStore, WalletService } from '@trustsystem/wallet';
import { MerchantOnboarding } from './domain/onboarding';
import { PaymentEngine, type MockPaymentProvider, type RiskRule } from './domain/payment';

/**
 * The pilot, assembled.
 *
 * Everything here is framework. The only application code in the assembly is the two classes in
 * `domain/`, and the fee schedule and limits below are *configuration* — the values a deployment
 * sets, not logic the pilot implements.
 *
 * That is what the pilot is measuring. If accepting a payment on TrustOS needs a hundred lines of
 * wiring and two domain classes, the framework carries the weight; if it needs its own ledger, its
 * own limit engine or its own idempotency, it does not.
 *
 * The stores are in memory. Phase 8 ships Prisma implementations of every one of these ports and a
 * deployment binds them; the pilot runs against the in-memory doubles because a pilot that needed
 * a database would be a pilot nobody could run in CI, and the port is the same either way.
 */

export const PILOT_CURRENCY = 'USD';

/** Account codes. The ids are generated when the accounts are opened. */
export const PLATFORM_CLEARING_CODE = 'platform.clearing';
export const FEE_REVENUE_CODE = 'platform.fee.revenue';

/**
 * The merchant service fee: 0.50%.
 *
 * Configuration, and it lives here rather than in the payment path — the specification is explicit
 * that the fee must not be hardcoded in a controller, and the reason is that a rate in code is a
 * rate that needs a deployment to change.
 *
 * `basisPoints: 50` is 0.50%: a basis point is a hundredth of a percent, so fifty of them are half
 * of one. The minimum and maximum are the bounds a real agreement would carry.
 */
export function pilotFeeSchedule(overrides: Partial<FeeSchedule> = {}): FeeSchedule {
  return feeScheduleSchema.parse({
    id: 'fee_mwb_v1',
    organizationId: null,
    key: 'merchant.wallet.basic',
    version: 1,
    name: 'Merchant Wallet Basic — service fee',
    description: 'A 0.50% merchant service fee, with a floor of 0.05 and a ceiling of 25.00.',
    currency: PILOT_CURRENCY,
    components: [
      {
        name: 'Merchant service fee',
        kind: 'percentage',
        basisPoints: 50,
        revenueAccountCode: FEE_REVENUE_CODE,
      },
    ],
    minimumFee: '0.05',
    maximumFee: '25.00',
    rounding: 'half_up',
    status: 'published',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedById: 'usr_product',
    ...overrides,
  });
}

/**
 * The limits: 1,000 per transaction and 5,000 per day.
 *
 * Also configuration. The daily limit carries a timezone because "a day" is a local idea — a
 * platform that assumes UTC refuses a merchant at 07:00 local for yesterday's takings.
 */
export function pilotLimits(organizationId: string | null = null, timezone = 'UTC'): Limit[] {
  const now = new Date('2026-01-01T00:00:00.000Z');

  return [
    limitSchema.parse({
      id: 'lim_mwb_txn',
      organizationId,
      key: 'wallet.transaction.usd',
      name: 'Per-transaction limit',
      scope: 'wallet',
      window: 'transaction',
      currency: PILOT_CURRENCY,
      maxAmount: '1000.00',
      enforcement: 'block',
      createdAt: now,
      updatedAt: now,
    }),
    limitSchema.parse({
      id: 'lim_mwb_daily',
      organizationId,
      key: 'wallet.daily.usd',
      name: 'Daily limit',
      scope: 'wallet',
      window: 'day',
      timezone,
      currency: PILOT_CURRENCY,
      maxAmount: '5000.00',
      enforcement: 'block',
      createdAt: now,
      updatedAt: now,
    }),
  ];
}

export interface PilotOptions {
  /**
   * The organization the limits belong to.
   *
   * Limits are tenant-scoped in `@trustsystem/limits` — `applicable` matches on `organizationId`, so a
   * limit registered against `null` does not apply to a payment made by `org_a`. That is correct
   * and it is the sort of thing a pilot finds: a platform-wide limit and a tenant limit are
   * different objects, and configuring one while expecting the other means no limit applies at all.
   */
  organizationId?: string | null;
  now?: () => Date;
  provider?: MockPaymentProvider;
  riskRule?: RiskRule;
  feeSchedule?: FeeSchedule;
  limits?: Limit[];
}

export interface Pilot {
  readonly accounts: AccountService;
  readonly wallets: WalletService;
  readonly ledger: Ledger;
  readonly limits: LimitEngine;
  readonly onboarding: MerchantOnboarding;
  readonly payments: PaymentEngine;
  readonly audit: AuditService;
  readonly auditSink: InMemoryAuditSink;
  readonly ledgerStore: InMemoryLedgerStore;
  readonly limitStore: InMemoryLimitStore;
  readonly clearingAccountId: string;
  readonly feeRevenueAccountId: string;
  /** The merchant's wallet, or null before approval. */
  walletOf(organizationId: string, merchantId: string): Promise<{ id: string } | null>;
}

/**
 * Assembles the pilot.
 *
 * Read the body as the answer to "how much does an application have to do". Nine framework
 * services, two domain classes, and two pieces of configuration.
 */
export async function buildPilot(options: PilotOptions = {}): Promise<Pilot> {
  const now = options.now ?? (() => new Date());

  const auditSink = new InMemoryAuditSink();
  const audit = new AuditService({ sink: auditSink, now });

  /*
   * The ledger and the accounts service refer to each other: an account's balance is derived from
   * the journals, and a journal names accounts. The ledger is constructed first and the accounts
   * service takes its `balances` — which is the only part of it an account needs, and is why the
   * option is typed `Pick<Ledger, 'balances'>` rather than the whole thing.
   */
  const ledgerStore = new InMemoryLedgerStore();
  const ledger = new Ledger({ store: ledgerStore, audit, now });

  const accountStore = new InMemoryAccountStore();
  const accounts = new AccountService({ store: accountStore, ledger, audit, now });

  const limitStore = new InMemoryLimitStore();
  for (const limit of options.limits ?? pilotLimits(options.organizationId ?? 'org_a')) {
    limitStore.add(limit);
  }
  const limits = new LimitEngine({ store: limitStore, now });

  const walletStore = new InMemoryWalletStore();

  const wallets = new WalletService({
    wallets: walletStore,
    holds: new InMemoryHoldStore(),
    accounts,
    ledger,
    audit,
    now,
  });

  // The platform's own accounts. A deployment opens these in its chart of accounts; the pilot
  // opens them here so the journal has both sides.
  const clearing = await accounts.open({
    organizationId: null,
    code: 'platform.clearing',
    name: 'Payment clearing',
    // The platform's own funds. A payment arrives here before any of it is the merchant's.
    type: 'system',
    currency: PILOT_CURRENCY,
  });

  const feeRevenue = await accounts.open({
    organizationId: null,
    code: 'platform.fee.revenue',
    name: 'Merchant fee revenue',
    type: 'fee',
    currency: PILOT_CURRENCY,
  });

  const onboarding = new MerchantOnboarding({ wallets, audit, now });

  const payments = new PaymentEngine({
    wallets,
    ledger,
    limits,
    feeSchedule: options.feeSchedule ?? pilotFeeSchedule(),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.riskRule ? { riskRule: options.riskRule } : {}),
    audit,
    findMerchant: async (merchantId, organizationId) => onboarding.get(organizationId, merchantId),
    feeRevenueAccountId: feeRevenue.id,
    clearingAccountId: clearing.id,
    now,
  });

  return {
    accounts,
    wallets,
    ledger,
    limits,
    onboarding,
    payments,
    audit,
    auditSink,
    ledgerStore,
    limitStore,
    clearingAccountId: clearing.id,
    feeRevenueAccountId: feeRevenue.id,
    walletOf: async (organizationId, merchantId) =>
      walletStore.findByOwner({ organizationId, ownerId: merchantId, currency: PILOT_CURRENCY }),
  };
}

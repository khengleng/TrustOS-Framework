import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { LoggerPort } from '@trustos/logging';
import {
  DEFAULT_ROUNDING,
  addMoney,
  compareMoney,
  decimal,
  divide,
  formatMoney,
  maxMoney,
  minMoney,
  money,
  moneySchema,
  moneyFromJson,
  moneyToJson,
  multiply,
  negateMoney,
  parseDecimal,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
  type RoundingMode,
} from '@trustos/financial-core';

/**
 * The fee engine.
 *
 * A fee is a calculation somebody agreed to in a contract, so two things matter more than the
 * arithmetic:
 *
 *   1. **A published fee schedule is immutable, and versioned.** Changing what a customer is
 *      charged by editing a row means last month's invoice recalculates to a different number,
 *      and the customer's copy no longer matches yours. A change is a new version with an
 *      effective date; the old version still prices the transactions it priced.
 *   2. **Every computed fee shows its working.** The schedule, the version, the component that
 *      produced each part, and the order they were applied. "Why is this 2.47" is a question with
 *      an answer, and the answer should not require somebody to re-derive it.
 *
 * **Order matters and is fixed**: base components, then discount, then floor and cap, then tax.
 * Tax last because tax applies to what is actually charged; cap before tax because a capped fee is
 * capped before tax, not after. A deployment that needs the other order has a jurisdiction
 * requirement and should say so — but there is one order here, not a configurable one, because a
 * configurable order is four ways to compute a number nobody can reconcile.
 */

export const FEE_COMPONENT_KINDS = [
  /** A fixed amount, whatever the transaction. */
  'flat',
  /** A share of the transaction amount, in basis points. */
  'percentage',
  /** A percentage that changes with the amount. */
  'tiered',
  /** A percentage or flat amount that reduces the fee. Applied after the base components. */
  'discount',
  /** A percentage of the fee, applied last. */
  'tax',
] as const;

export type FeeComponentKind = (typeof FEE_COMPONENT_KINDS)[number];

export const feeTierSchema = z
  .object({
    /** Inclusive lower bound of the transaction amount, as a decimal string. */
    fromAmount: z.string(),
    /** Exclusive upper bound. Null is "and above". */
    toAmount: z.string().nullable().default(null),
    /** Hundredths of a percent. 250 is 2.5%. */
    basisPoints: z.number().int().min(0).max(1_000_000),
    /** An additional flat amount within this tier. */
    flatAmount: z.string().nullable().default(null),
  })
  .strict();

export type FeeTier = z.infer<typeof feeTierSchema>;

export const feeComponentSchema = z
  .object({
    /** Appears in the breakdown, so it should read as a line on an invoice. */
    name: z.string().min(1).max(120),
    kind: z.enum(FEE_COMPONENT_KINDS),

    /** For `flat` and a flat `discount`. A decimal string in the schedule's currency. */
    amount: z.string().nullable().default(null),
    /** For `percentage`, `tax` and a percentage `discount`. Hundredths of a percent. */
    basisPoints: z.number().int().min(0).max(1_000_000).nullable().default(null),
    /** For `tiered`. Non-overlapping and contiguous — checked when the schedule is published. */
    tiers: z.array(feeTierSchema).max(50).default([]),

    /** Which account this component's amount is booked to. */
    revenueAccountCode: z.string().max(120).nullable().default(null),

    /** Free-form, for a deployment that needs to group components on a report. */
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  })
  .strict()
  .superRefine((component, ctx) => {
    const needsAmount = component.kind === 'flat';
    const needsBasisPoints = component.kind === 'percentage' || component.kind === 'tax';

    if (needsAmount && component.amount === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'A flat component needs an amount.',
      });
    }

    if (needsBasisPoints && component.basisPoints === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['basisPoints'],
        message: `A ${component.kind} component needs basisPoints.`,
      });
    }

    if (component.kind === 'tiered' && component.tiers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers'],
        message: 'A tiered component needs at least one tier.',
      });
    }

    if (
      component.kind === 'discount' &&
      component.amount === null &&
      component.basisPoints === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'A discount needs an amount or basisPoints, or it discounts nothing.',
      });
    }
  });

export type FeeComponent = z.infer<typeof feeComponentSchema>;

export const FEE_SCHEDULE_STATUSES = ['draft', 'published', 'retired'] as const;
export type FeeScheduleStatus = (typeof FEE_SCHEDULE_STATUSES)[number];

export const feeScheduleSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** Stable across versions. What a caller asks for. */
    key: z
      .string()
      .min(1)
      .max(120)
      .regex(
        /^[a-z][a-z0-9]*(\.[a-z0-9_]+)*$/,
        'A fee schedule key is lowercase and dot-separated.',
      ),
    version: z.number().int().min(1),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).default(''),

    currency: z.string().min(3).max(8),
    components: z.array(feeComponentSchema).min(1).max(20),

    /** Never charge less than this, once everything is applied. */
    minimumFee: z.string().nullable().default(null),
    /** Never charge more than this. Applied before tax — see the header. */
    maximumFee: z.string().nullable().default(null),

    /**
     * Rounding for this schedule.
     *
     * Per schedule, because a fee agreement occasionally states it — and where it does, matching
     * the counterparty matters more than matching the platform default.
     */
    rounding: z
      .enum(['half_up', 'half_even', 'down', 'up', 'ceiling', 'floor'])
      .default(DEFAULT_ROUNDING),

    status: z.enum(FEE_SCHEDULE_STATUSES).default('draft'),

    /** When this version starts pricing. A version with a future date is scheduled, not live. */
    effectiveFrom: z.coerce.date(),
    /** When it stops. Set when a later version supersedes it. */
    effectiveTo: z.coerce.date().nullable().default(null),

    /** Marks a promotional schedule, so a report can separate it from standard pricing. */
    promotional: z.boolean().default(false),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
    publishedAt: z.coerce.date().nullable().default(null),
    publishedById: z.string().nullable().default(null),
  })
  .strict();

export type FeeSchedule = z.infer<typeof feeScheduleSchema>;

/** One line of the working. */
export interface FeeBreakdownLine {
  name: string;
  kind: FeeComponentKind;
  amount: Money;
  /** How it was computed, in words. Appears on an invoice or a support screen. */
  explanation: string;
  revenueAccountCode: string | null;
}

export interface FeeCalculation {
  scheduleKey: string;
  scheduleVersion: number;
  /** What the fee was computed on. */
  baseAmount: Money;
  /** The total charged. */
  total: Money;
  lines: FeeBreakdownLine[];
  /** Set when the floor or the cap changed the answer, so the reason is visible. */
  adjustment: string | null;
  calculatedAt: Date;
}

/**
 * Computes a fee.
 *
 * Pure: no store, no clock, no tenant. The schedule and the amount go in, the calculation comes
 * out, and it is the same answer on every machine — which is what makes it testable against a
 * counterparty's number rather than against itself.
 */
export function calculateFee(input: {
  schedule: FeeSchedule;
  amount: Money;
  currencies?: CurrencyRegistry;
  at?: Date;
}): FeeCalculation {
  const { schedule, amount } = input;

  if (amount.currency !== schedule.currency) {
    throw ApiError.validation(
      [
        {
          path: 'amount',
          message:
            `The "${schedule.key}" schedule prices in ${schedule.currency} and this amount is in ` +
            `${amount.currency}. Convert first, and record the rate — see @trustos/fx.`,
        },
      ],
      'Currency mismatch with the fee schedule.',
    );
  }

  const rounding = schedule.rounding as RoundingMode;
  const zero = zeroMoney(schedule.currency, input.currencies);
  const lines: FeeBreakdownLine[] = [];

  const parse = (value: string) => money(value, schedule.currency, input.currencies, rounding);

  // 1. Base components.
  let subtotal = zero;

  for (const component of schedule.components) {
    if (component.kind === 'discount' || component.kind === 'tax') continue;

    const line = computeComponent(component, amount, schedule, input.currencies, rounding);
    lines.push(line);
    subtotal = addMoney(subtotal, line.amount);
  }

  // 2. Discounts, against the base.
  for (const component of schedule.components) {
    if (component.kind !== 'discount') continue;

    const raw =
      component.amount !== null
        ? parse(component.amount)
        : money(
            multiply(subtotal.amount, basisPointFactor(component.basisPoints ?? 0)),
            schedule.currency,
            input.currencies,
            rounding,
          );

    // A discount never turns a fee into a payment. Capped at the subtotal.
    const applied = minMoney(raw, subtotal);

    lines.push({
      name: component.name,
      kind: 'discount',
      amount: negateMoney(applied),
      explanation:
        component.amount !== null
          ? `Flat discount of ${formatMoney(applied)}`
          : `${describeBasisPoints(component.basisPoints ?? 0)} of ${formatMoney(subtotal)}`,
      revenueAccountCode: component.revenueAccountCode,
    });

    subtotal = subtractMoney(subtotal, applied);
  }

  // 3. Floor and cap, before tax. A capped fee is capped before tax, not after.
  let adjustment: string | null = null;

  if (schedule.minimumFee !== null) {
    const minimum = parse(schedule.minimumFee);

    if (compareMoney(subtotal, minimum) < 0) {
      adjustment = `Raised to the ${formatMoney(minimum)} minimum from ${formatMoney(subtotal)}.`;
      subtotal = maxMoney(subtotal, minimum);
    }
  }

  if (schedule.maximumFee !== null) {
    const maximum = parse(schedule.maximumFee);

    if (compareMoney(subtotal, maximum) > 0) {
      adjustment = `Capped at ${formatMoney(maximum)} from ${formatMoney(subtotal)}.`;
      subtotal = minMoney(subtotal, maximum);
    }
  }

  // 4. Tax, on what is actually charged.
  let total = subtotal;

  for (const component of schedule.components) {
    if (component.kind !== 'tax') continue;

    const tax = money(
      multiply(subtotal.amount, basisPointFactor(component.basisPoints ?? 0)),
      schedule.currency,
      input.currencies,
      rounding,
    );

    lines.push({
      name: component.name,
      kind: 'tax',
      amount: tax,
      explanation: `${describeBasisPoints(component.basisPoints ?? 0)} of ${formatMoney(subtotal)}`,
      revenueAccountCode: component.revenueAccountCode,
    });

    total = addMoney(total, tax);
  }

  return {
    scheduleKey: schedule.key,
    scheduleVersion: schedule.version,
    baseAmount: amount,
    total,
    lines,
    adjustment,
    calculatedAt: input.at ?? new Date(0),
  };
}

function computeComponent(
  component: FeeComponent,
  amount: Money,
  schedule: FeeSchedule,
  currencies: CurrencyRegistry | undefined,
  rounding: RoundingMode,
): FeeBreakdownLine {
  const parse = (value: string) => money(value, schedule.currency, currencies, rounding);

  if (component.kind === 'flat') {
    const flat = parse(component.amount!);

    return {
      name: component.name,
      kind: 'flat',
      amount: flat,
      explanation: `Flat ${formatMoney(flat)}`,
      revenueAccountCode: component.revenueAccountCode,
    };
  }

  if (component.kind === 'percentage') {
    const computed = money(
      multiply(amount.amount, basisPointFactor(component.basisPoints ?? 0)),
      schedule.currency,
      currencies,
      rounding,
    );

    return {
      name: component.name,
      kind: 'percentage',
      amount: computed,
      explanation: `${describeBasisPoints(component.basisPoints ?? 0)} of ${formatMoney(amount)}`,
      revenueAccountCode: component.revenueAccountCode,
    };
  }

  // Tiered.
  const tier = findTier(component.tiers, amount, schedule.currency, currencies);

  if (!tier) {
    /*
     * An amount that falls in no tier.
     *
     * Refused rather than charged zero. A gap in a tier table is a configuration mistake, and
     * charging nothing for the transactions that land in the gap is the version nobody notices
     * until the revenue report.
     */
    throw ApiError.validation(
      [
        {
          path: 'tiers',
          message:
            `${formatMoney(amount)} falls into no tier of "${component.name}" in schedule ` +
            `"${schedule.key}" v${schedule.version}. A gap in a tier table charges nothing for the ` +
            'transactions that land in it.',
        },
      ],
      'No fee tier matches this amount.',
    );
  }

  const percentage = money(
    multiply(amount.amount, basisPointFactor(tier.basisPoints)),
    schedule.currency,
    currencies,
    rounding,
  );

  const flat = tier.flatAmount ? parse(tier.flatAmount) : zeroMoney(schedule.currency, currencies);

  return {
    name: component.name,
    kind: 'tiered',
    amount: addMoney(percentage, flat),
    explanation:
      `${describeBasisPoints(tier.basisPoints)} of ${formatMoney(amount)}` +
      (tier.flatAmount ? ` plus ${formatMoney(flat)}` : '') +
      ` (tier from ${tier.fromAmount}${tier.toAmount ? ` to ${tier.toAmount}` : ' and above'})`,
    revenueAccountCode: component.revenueAccountCode,
  };
}

function findTier(
  tiers: FeeTier[],
  amount: Money,
  currency: string,
  currencies: CurrencyRegistry | undefined,
): FeeTier | null {
  return (
    tiers.find((tier) => {
      const from = money(tier.fromAmount, currency, currencies);
      if (compareMoney(amount, from) < 0) return false;

      if (tier.toAmount === null) return true;

      return compareMoney(amount, money(tier.toAmount, currency, currencies)) < 0;
    }) ?? null
  );
}

/** Basis points as a decimal factor: 250bp → 0.025. */
export function basisPointFactor(basisPoints: number) {
  return divide(decimal(BigInt(basisPoints), 0), decimal(10_000n, 0), 6);
}

function describeBasisPoints(basisPoints: number): string {
  const percent = parseDecimal(
    (basisPoints / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''),
  );
  return `${percent.units === 0n ? '0' : formatPercent(percent)}%`;
}

function formatPercent(value: { units: bigint; scale: number }): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');
  const whole = digits.slice(0, digits.length - value.scale) || '0';
  const fraction =
    value.scale > 0 ? digits.slice(digits.length - value.scale).replace(/0+$/, '') : '';

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Checks a schedule's tiers before it is published.
 *
 * Overlaps and gaps are both configuration mistakes that price transactions wrongly and silently:
 * an overlap makes which tier applies a function of array order, and a gap charges nothing.
 */
export function validateSchedule(schedule: FeeSchedule, currencies?: CurrencyRegistry): string[] {
  const problems: string[] = [];

  for (const component of schedule.components) {
    if (component.kind !== 'tiered') continue;

    const sorted = [...component.tiers].sort((a, b) =>
      compareMoney(
        money(a.fromAmount, schedule.currency, currencies),
        money(b.fromAmount, schedule.currency, currencies),
      ),
    );

    for (let index = 0; index < sorted.length - 1; index += 1) {
      const current = sorted[index]!;
      const next = sorted[index + 1]!;

      if (current.toAmount === null) {
        problems.push(
          `"${component.name}" has an open-ended tier from ${current.fromAmount} followed by ` +
            `another from ${next.fromAmount}, which can never be reached.`,
        );
        continue;
      }

      const currentTo = money(current.toAmount, schedule.currency, currencies);
      const nextFrom = money(next.fromAmount, schedule.currency, currencies);
      const comparison = compareMoney(currentTo, nextFrom);

      if (comparison > 0) {
        problems.push(
          `"${component.name}" tiers overlap between ${current.fromAmount} and ${next.fromAmount}. ` +
            'Which tier applies would depend on array order.',
        );
      } else if (comparison < 0) {
        problems.push(
          `"${component.name}" has a gap between ${current.toAmount} and ${next.fromAmount}. ` +
            'Transactions in the gap would be charged nothing.',
        );
      }
    }

    if (sorted.length > 0 && sorted[sorted.length - 1]!.toAmount !== null) {
      problems.push(
        `"${component.name}" has no open-ended top tier, so an amount above ` +
          `${sorted[sorted.length - 1]!.toAmount} matches nothing.`,
      );
    }
  }

  if (schedule.minimumFee !== null && schedule.maximumFee !== null) {
    const minimum = money(schedule.minimumFee, schedule.currency, currencies);
    const maximum = money(schedule.maximumFee, schedule.currency, currencies);

    if (compareMoney(minimum, maximum) > 0) {
      problems.push(
        `The minimum fee ${formatMoney(minimum)} is above the maximum ${formatMoney(maximum)}, so ` +
          'the cap and the floor contradict each other.',
      );
    }
  }

  return problems;
}

/** The calculation as JSON, for storing beside a transaction. */
export function calculationToJson(calculation: FeeCalculation): Record<string, unknown> {
  return {
    scheduleKey: calculation.scheduleKey,
    scheduleVersion: calculation.scheduleVersion,
    baseAmount: moneyToJson(calculation.baseAmount),
    total: moneyToJson(calculation.total),
    adjustment: calculation.adjustment,
    lines: calculation.lines.map((line) => ({
      name: line.name,
      kind: line.kind,
      amount: moneyToJson(line.amount),
      explanation: line.explanation,
      revenueAccountCode: line.revenueAccountCode,
    })),
  };
}

/** The stored shape, for reading a calculation back. */
export const storedCalculationSchema = z
  .object({
    scheduleKey: z.string(),
    scheduleVersion: z.number().int(),
    baseAmount: moneySchema,
    total: moneySchema,
    adjustment: z.string().nullable(),
    lines: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(FEE_COMPONENT_KINDS),
        amount: moneySchema,
        explanation: z.string(),
        revenueAccountCode: z.string().nullable(),
      }),
    ),
  })
  .strict();

export function calculationFromJson(
  input: unknown,
  currencies?: CurrencyRegistry,
): Omit<FeeCalculation, 'calculatedAt'> {
  const parsed = storedCalculationSchema.parse(input);

  return {
    scheduleKey: parsed.scheduleKey,
    scheduleVersion: parsed.scheduleVersion,
    baseAmount: moneyFromJson(parsed.baseAmount, currencies),
    total: moneyFromJson(parsed.total, currencies),
    adjustment: parsed.adjustment,
    lines: parsed.lines.map((line) => ({
      name: line.name,
      kind: line.kind,
      amount: moneyFromJson(line.amount, currencies),
      explanation: line.explanation,
      revenueAccountCode: line.revenueAccountCode,
    })),
  };
}

export interface FeeScheduleStore {
  create(schedule: FeeSchedule): Promise<FeeSchedule>;
  find(id: string, organizationId: string | null): Promise<FeeSchedule | null>;
  /** The version live at a moment, for a key. */
  findEffective(input: {
    key: string;
    organizationId: string | null;
    at: Date;
  }): Promise<FeeSchedule | null>;
  listVersions(key: string, organizationId: string | null): Promise<FeeSchedule[]>;
  update(id: string, patch: Partial<FeeSchedule>): Promise<FeeSchedule | null>;
}

export interface FeeServiceOptions {
  store: FeeScheduleStore;
  currencies?: CurrencyRegistry;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class FeeService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: FeeServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2)}`);
  }

  /** Drafts a new version of a schedule. The next version number is assigned here. */
  async draft(input: {
    organizationId: string | null;
    key: string;
    name: string;
    currency: string;
    components: unknown[];
    description?: string;
    minimumFee?: string | null;
    maximumFee?: string | null;
    rounding?: RoundingMode;
    effectiveFrom?: Date;
    promotional?: boolean;
    actorId?: string | null;
  }): Promise<FeeSchedule> {
    const versions = await this.options.store.listVersions(input.key, input.organizationId);
    const now = this.now();

    const parsed = feeScheduleSchema.safeParse({
      id: this.newId('fee'),
      organizationId: input.organizationId,
      key: input.key,
      version: versions.reduce((highest, entry) => Math.max(highest, entry.version), 0) + 1,
      name: input.name,
      description: input.description ?? '',
      currency: input.currency,
      components: input.components,
      minimumFee: input.minimumFee ?? null,
      maximumFee: input.maximumFee ?? null,
      rounding: input.rounding ?? DEFAULT_ROUNDING,
      status: 'draft',
      effectiveFrom: input.effectiveFrom ?? now,
      promotional: input.promotional ?? false,
      createdAt: now,
      createdById: input.actorId ?? null,
    });

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'schedule',
          message: issue.message,
        })),
        `The "${input.key}" fee schedule is not valid.`,
      );
    }

    const problems = validateSchedule(parsed.data, this.options.currencies);

    if (problems.length > 0) {
      throw ApiError.validation(
        problems.map((problem) => ({ path: 'components', message: problem })),
        `The "${input.key}" fee schedule has tier problems.`,
      );
    }

    return this.options.store.create(parsed.data);
  }

  /**
   * Publishes a version, and closes the one it supersedes.
   *
   * The previous version keeps its `effectiveTo`, so a transaction priced last week still
   * re-prices to the same number — which is what makes an invoice reproducible.
   */
  async publish(input: {
    id: string;
    organizationId: string | null;
    actorId?: string | null;
  }): Promise<FeeSchedule> {
    const schedule = await this.require(input.id, input.organizationId);

    if (schedule.status !== 'draft') {
      throw ApiError.conflict(
        `Version ${schedule.version} of "${schedule.key}" is already ${schedule.status}. A ` +
          'published schedule is immutable — a change is a new version.',
        { reason: 'schedule_not_draft', id: schedule.id },
      );
    }

    const now = this.now();
    const current = await this.options.store.findEffective({
      key: schedule.key,
      organizationId: input.organizationId,
      at: schedule.effectiveFrom,
    });

    if (current && current.id !== schedule.id) {
      await this.options.store.update(current.id, { effectiveTo: schedule.effectiveFrom });
    }

    const published = await this.options.store.update(schedule.id, {
      status: 'published',
      publishedAt: now,
      publishedById: input.actorId ?? null,
    });

    if (!published) throw ApiError.notFound(`No fee schedule with id "${input.id}".`);

    return published;
  }

  /**
   * Prices an amount against the schedule live at a moment.
   *
   * `at` defaults to now, and passing it is how a re-priced invoice comes out the same: the
   * version that was live then is the version that prices it.
   */
  async calculate(input: {
    organizationId: string | null;
    key: string;
    amount: Money;
    at?: Date;
  }): Promise<FeeCalculation> {
    const at = input.at ?? this.now();

    const schedule = await this.options.store.findEffective({
      key: input.key,
      organizationId: input.organizationId,
      at,
    });

    if (!schedule) {
      throw ApiError.validation(
        [
          {
            path: 'key',
            message:
              `No published version of the "${input.key}" fee schedule was effective at ` +
              `${at.toISOString()}.`,
          },
        ],
        'No fee schedule.',
      );
    }

    return {
      ...calculateFee({ schedule, amount: input.amount, currencies: this.options.currencies }),
      calculatedAt: at,
    };
  }

  async versions(key: string, organizationId: string | null): Promise<FeeSchedule[]> {
    return this.options.store.listVersions(key, organizationId);
  }

  private async require(id: string, organizationId: string | null): Promise<FeeSchedule> {
    const schedule = await this.options.store.find(id, organizationId);
    if (!schedule) throw ApiError.notFound(`No fee schedule with id "${id}".`);
    return schedule;
  }
}

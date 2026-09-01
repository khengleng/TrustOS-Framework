import { ApiError } from '@trustsystem/errors';

/**
 * Fixed-point decimal arithmetic.
 *
 * **Never use floating point for money.** `0.1 + 0.2 === 0.30000000000000004` is the famous
 * example and it is not the dangerous one — the dangerous one is that a fee of 2.5% on 1,234.56
 * computed in a double gives an answer that is wrong in the fifteenth decimal place, is rounded to
 * two places, agrees with the expected value in every test somebody wrote, and disagrees with the
 * provider's number once in ten thousand transactions. Reconciliation then finds a mismatch nobody
 * can explain, and the explanation is that IEEE-754 cannot represent 0.1.
 *
 * So: a decimal here is a **bigint of scaled units plus a scale**. `12.34` at scale 2 is
 * `{ units: 1234n, scale: 2 }`. Every operation is exact except division, and division is the only
 * operation that takes a rounding mode — because it is the only one where information is lost, and
 * losing it silently is how a rounding policy becomes an accident.
 *
 * **Why not a library.** decimal.js and big.js are good and this is not a claim they are not. This
 * implementation is about 200 lines, has no transitive dependencies, and is exercised by the tests
 * beside it; adding a dependency to the one package that every financial number passes through is
 * a decision that wants more justification than "it exists".
 */

export const ROUNDING_MODES = [
  /** Toward the nearest neighbour; ties away from zero. What people mean by "round". */
  'half_up',
  /** Toward the nearest neighbour; ties to the even digit. Banker's rounding. */
  'half_even',
  /** Toward zero. Truncation. */
  'down',
  /** Away from zero. */
  'up',
  /** Toward positive infinity. */
  'ceiling',
  /** Toward negative infinity. */
  'floor',
] as const;

export type RoundingMode = (typeof ROUNDING_MODES)[number];

/**
 * The default.
 *
 * `half_even` rather than `half_up`, and the reason is statistical rather than aesthetic. Rounding
 * halves consistently upward introduces a positive bias of half a minor unit per tie; over a
 * million fee calculations that is a real number that appears in a suspense account and nobody can
 * account for. Banker's rounding distributes ties evenly, which is why it is what accountants and
 * the IEEE both specify.
 *
 * A deployment that must match a counterparty using `half_up` sets it explicitly, per calculation,
 * where the requirement is visible.
 */
export const DEFAULT_ROUNDING: RoundingMode = 'half_even';

/** The largest scale anything here supports. Beyond it, a bigint is doing no useful work. */
export const MAX_SCALE = 18;

export interface Decimal {
  /** The value, scaled: `units / 10^scale`. */
  readonly units: bigint;
  readonly scale: number;
}

const POWERS: bigint[] = Array.from({ length: MAX_SCALE + 1 }, (_, index) => 10n ** BigInt(index));

function pow10(scale: number): bigint {
  return POWERS[scale] ?? 10n ** BigInt(scale);
}

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw ApiError.validation(
      [
        {
          path: 'scale',
          message: `A scale must be an integer between 0 and ${MAX_SCALE}, and was ${scale}.`,
        },
      ],
      'Invalid decimal scale.',
    );
  }
}

/** Builds a decimal from scaled units. The primitive constructor; everything else routes here. */
export function decimal(units: bigint, scale: number): Decimal {
  assertScale(scale);
  return { units, scale };
}

/**
 * Parses a decimal string.
 *
 * Accepts `-12.34`, `12`, `+0.5`, `1_000.25`. Rejects everything else — including `1e3`, `Infinity`
 * and `12.34.56`. **Exponent notation is rejected on purpose**: `1e3` in a financial file is
 * either a mistake or a number that was already through a float, and accepting it would hide both.
 *
 * The scale is taken from the string. `"1.50"` is scale 2 and `"1.5"` is scale 1 — they are equal
 * in value and different in precision, and the distinction matters when a price says 1.50.
 */
export function parseDecimal(input: string | number | bigint, scale?: number): Decimal {
  if (typeof input === 'bigint') return decimal(input, scale ?? 0);

  if (typeof input === 'number') {
    /*
     * A number is accepted only when it is an integer.
     *
     * `parseDecimal(0.1)` would have to decide what `0.1` means, and the honest answer is
     * `0.1000000000000000055511151231257827` — the double nearest to a tenth. Silently treating it
     * as one-tenth is the exact class of error this module exists to prevent.
     */
    if (!Number.isSafeInteger(input)) {
      throw ApiError.validation(
        [
          {
            path: 'value',
            message:
              `The number ${input} is not a safe integer, so it cannot be converted to a decimal ` +
              'without deciding what its floating-point error means. Pass it as a string.',
          },
        ],
        'Cannot convert this number to a decimal.',
      );
    }

    return scaleTo(decimal(BigInt(input), 0), scale ?? 0);
  }

  const text = input.trim().replace(/_/g, '');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text);

  if (!match) {
    throw ApiError.validation(
      [
        {
          path: 'value',
          message:
            `"${input}" is not a decimal. Expected digits with an optional sign and a single ` +
            'decimal point. Exponent notation is rejected deliberately: a number written as 1e3 ' +
            'in a financial file has usually been through a float already.',
        },
      ],
      'Invalid decimal.',
    );
  }

  const [, sign, whole, fraction = ''] = match;

  if (fraction.length > MAX_SCALE) {
    throw ApiError.validation(
      [
        {
          path: 'value',
          message: `"${input}" has ${fraction.length} decimal places and the maximum is ${MAX_SCALE}.`,
        },
      ],
      'Too many decimal places.',
    );
  }

  const units = BigInt(`${sign === '-' ? '-' : ''}${whole}${fraction}`);
  const parsed = decimal(units, fraction.length);

  return scale === undefined ? parsed : scaleTo(parsed, scale);
}

/** `0` at the given scale. */
export function zero(scale = 0): Decimal {
  return decimal(0n, scale);
}

/**
 * Changes the scale.
 *
 * Increasing it is exact. Decreasing it loses information, so it rounds — and takes the mode
 * explicitly rather than defaulting silently, because "which way did that round" is a question
 * that gets asked during reconciliation.
 */
export function scaleTo(
  value: Decimal,
  scale: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Decimal {
  assertScale(scale);

  if (scale === value.scale) return value;
  if (scale > value.scale) return decimal(value.units * pow10(scale - value.scale), scale);

  return decimal(divideRounded(value.units, pow10(value.scale - scale), mode), scale);
}

/** Divides, applying the rounding mode to the remainder. The only lossy primitive. */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw ApiError.validation(
      [{ path: 'divisor', message: 'Division by zero.' }],
      'Division by zero.',
    );
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  if (remainder === 0n) return quotient;

  const negative = numerator < 0n !== denominator < 0n;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const step = negative ? -1n : 1n;

  switch (mode) {
    case 'down':
      return quotient;
    case 'up':
      return quotient + step;
    case 'ceiling':
      return negative ? quotient : quotient + 1n;
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'half_up':
      return twice >= absDenominator ? quotient + step : quotient;
    case 'half_even': {
      if (twice > absDenominator) return quotient + step;
      if (twice < absDenominator) return quotient;
      // Exactly half: to the even neighbour.
      return quotient % 2n === 0n ? quotient : quotient + step;
    }
  }
}

/** Brings two decimals to a common scale — the larger of the two, so nothing is lost. */
function align(left: Decimal, right: Decimal): { left: bigint; right: bigint; scale: number } {
  const scale = Math.max(left.scale, right.scale);

  return {
    left: left.units * pow10(scale - left.scale),
    right: right.units * pow10(scale - right.scale),
    scale,
  };
}

export function add(left: Decimal, right: Decimal): Decimal {
  const aligned = align(left, right);
  return decimal(aligned.left + aligned.right, aligned.scale);
}

export function subtract(left: Decimal, right: Decimal): Decimal {
  const aligned = align(left, right);
  return decimal(aligned.left - aligned.right, aligned.scale);
}

export function negate(value: Decimal): Decimal {
  return decimal(-value.units, value.scale);
}

export function absolute(value: Decimal): Decimal {
  return value.units < 0n ? negate(value) : value;
}

/**
 * Multiplies. Exact.
 *
 * The result's scale is the sum of the operands', which is what makes it exact: 1.5 × 1.5 is
 * exactly 2.25, at scale 2. A caller wanting a specific scale calls `scaleTo` afterwards and says
 * how to round — rather than the multiplication guessing.
 */
export function multiply(left: Decimal, right: Decimal): Decimal {
  const scale = left.scale + right.scale;

  if (scale > MAX_SCALE) {
    // Exactness is not free. Rather than silently truncating, say what happened.
    return scaleTo({ units: left.units * right.units, scale }, MAX_SCALE, DEFAULT_ROUNDING);
  }

  return decimal(left.units * right.units, scale);
}

/**
 * Divides to a stated scale with a stated rounding mode.
 *
 * Both are required. A division with an implied scale is a division whose precision is whatever
 * the operands happened to be, and a division with an implied rounding mode is a rounding policy
 * nobody chose.
 */
export function divide(
  left: Decimal,
  right: Decimal,
  scale: number,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Decimal {
  assertScale(scale);

  if (right.units === 0n) {
    throw ApiError.validation(
      [{ path: 'divisor', message: 'Division by zero.' }],
      'Division by zero.',
    );
  }

  // Shift the numerator so the quotient lands at the requested scale, then round once.
  const shift = scale + right.scale - left.scale;
  const numerator = shift >= 0 ? left.units * pow10(shift) : left.units;
  const denominator = shift >= 0 ? right.units : right.units * pow10(-shift);

  return decimal(divideRounded(numerator, denominator, mode), scale);
}

export function compare(left: Decimal, right: Decimal): -1 | 0 | 1 {
  const aligned = align(left, right);
  if (aligned.left < aligned.right) return -1;
  if (aligned.left > aligned.right) return 1;
  return 0;
}

/** Value equality, ignoring scale. `1.50` equals `1.5`. */
export function equals(left: Decimal, right: Decimal): boolean {
  return compare(left, right) === 0;
}

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

export function isNegative(value: Decimal): boolean {
  return value.units < 0n;
}

export function isPositive(value: Decimal): boolean {
  return value.units > 0n;
}

export function min(left: Decimal, right: Decimal): Decimal {
  return compare(left, right) <= 0 ? left : right;
}

export function max(left: Decimal, right: Decimal): Decimal {
  return compare(left, right) >= 0 ? left : right;
}

/**
 * The canonical string form.
 *
 * Always shows every place the scale declares, so `1.50` at scale 2 renders as `"1.50"` rather
 * than `"1.5"`. A price that renders differently depending on its value is a price somebody will
 * compare as a string.
 */
export function formatDecimal(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, '0');

  const whole = digits.slice(0, digits.length - value.scale) || '0';
  const fraction = value.scale > 0 ? `.${digits.slice(digits.length - value.scale)}` : '';

  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * A number, for a display layer that cannot take a string.
 *
 * Named to be uncomfortable, because this is where precision is lost and the name is the only
 * warning at the call site. Never use the result in a calculation, and never store it.
 */
export function unsafeToNumber(value: Decimal): number {
  return Number(formatDecimal(value));
}

/**
 * Splits a value into parts that sum back to exactly the original.
 *
 * The classic problem: 100 split three ways is 33.33, 33.33 and 33.33, which is 99.99. The penny
 * has to go somewhere, and a system that loses it has an unbalanced ledger.
 *
 * This distributes the remainder one minor unit at a time to the largest shares first, which is
 * the convention most accounting systems use and — more importantly — is deterministic. The same
 * split always produces the same parts, so two systems computing it independently agree.
 */
export function allocate(value: Decimal, weights: number[]): Decimal[] {
  if (weights.length === 0) {
    throw ApiError.validation(
      [{ path: 'weights', message: 'An allocation needs at least one weight.' }],
      'Nothing to allocate to.',
    );
  }

  if (weights.some((weight) => weight < 0)) {
    throw ApiError.validation(
      [{ path: 'weights', message: 'A negative weight would allocate a negative share.' }],
      'Invalid allocation weights.',
    );
  }

  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total === 0) {
    throw ApiError.validation(
      [{ path: 'weights', message: 'The weights sum to zero, so there is nothing to divide by.' }],
      'Invalid allocation weights.',
    );
  }

  // Floor each share, then hand out the remainder. Flooring first guarantees the remainder is
  // non-negative and smaller than the number of parts, so the loop below terminates.
  const scaled = weights.map(
    (weight) => (value.units * BigInt(Math.round(weight * 1e9))) / BigInt(Math.round(total * 1e9)),
  );
  const distributed = scaled.reduce((sum, part) => sum + part, 0n);
  let remainder = value.units - distributed;

  const order = weights
    .map((weight, index) => ({ weight, index }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  const step = remainder < 0n ? -1n : 1n;
  const parts = [...scaled];

  for (let position = 0; remainder !== 0n; position += 1) {
    const target = order[position % order.length]!.index;
    parts[target] = parts[target]! + step;
    remainder -= step;
  }

  return parts.map((units) => decimal(units, value.scale));
}

/**
 * The sum of a list.
 *
 * Empty sums to zero at the requested scale rather than throwing: a period with no transactions
 * has a balance of zero, not an error.
 */
export function sum(values: Decimal[], scale = 0): Decimal {
  return values.reduce<Decimal>((total, value) => add(total, value), zero(scale));
}

import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { formatMoney, type Money } from '@trustos/financial-core';

/**
 * Period closing.
 *
 * A closed period is one nothing may post into. That is the whole feature, and it exists because
 * of a specific failure: a report run in April for March, sent to somebody who acted on it, and
 * then a journal posted with a March effective date. The report is now wrong and nobody knows,
 * because reports are run on demand and nobody re-runs March.
 *
 * **Closing is about the effective date, not the posting date.** A journal posted today with an
 * effective date inside a closed period is exactly what closing prevents; a journal posted today
 * with today's date is fine however many periods are closed behind it. Getting this backwards
 * makes closing either useless (checking the posting date, which is always now) or a freeze on
 * the whole ledger.
 *
 * **A closed period can be reopened, and it is loud.** Refusing outright sounds stricter and is
 * worse in practice: the correction still has to happen, so it happens as a journal dated after
 * the close with a description explaining that it belongs in March — which is the same lie, told
 * less legibly. Reopening is audited, takes a reason, and records who did it.
 */

export const PERIOD_STATUSES = [
  /** Postings are permitted. */
  'open',
  /**
   * Closed to new postings.
   *
   * Not "locked": a reopen is possible and audited. See the header.
   */
  'closed',
] as const;

export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const accountingPeriodSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),
    ledgerId: z.string().min(1).max(120).default('default'),

    /** Readable and sortable: `2026-03`, `2026-Q1`, `FY2026`. */
    code: z.string().min(1).max(60),

    /**
     * The window, half-open: `[start, end)`.
     *
     * Half-open so consecutive periods tile without a gap and without an overlap. An inclusive end
     * makes midnight on the last day belong to two periods, and which one a journal lands in then
     * depends on which query ran.
     */
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),

    status: z.enum(PERIOD_STATUSES).default('open'),

    /**
     * The trial balance at the moment of closing, per currency.
     *
     * Stored rather than recomputed. Recomputing it later gives a different answer the moment
     * anything is posted into a reopened period — and the number people need is the one the
     * report they acted on was based on.
     */
    closingTotals: z
      .array(
        z.object({
          currency: z.string(),
          debits: z.string(),
          credits: z.string(),
        }),
      )
      .default([]),

    closedAt: z.coerce.date().nullable().default(null),
    closedById: z.string().nullable().default(null),
    closingNote: z.string().max(2000).nullable().default(null),

    /** Every reopen, so "who unlocked March" has an answer. */
    reopenings: z
      .array(
        z.object({
          at: z.coerce.date(),
          actorId: z.string().nullable(),
          reason: z.string().max(1000),
        }),
      )
      .max(50)
      .default([]),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict()
  .superRefine((period, ctx) => {
    if (period.endsAt <= period.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'A period must end after it starts, or it covers nothing.',
      });
    }
  });

export type AccountingPeriod = z.infer<typeof accountingPeriodSchema>;

export interface PeriodStore {
  create(period: AccountingPeriod): Promise<AccountingPeriod>;
  find(id: string, organizationId: string | null): Promise<AccountingPeriod | null>;
  update(id: string, patch: Partial<AccountingPeriod>): Promise<AccountingPeriod | null>;

  /**
   * The period containing an instant, if any.
   *
   * Called on **every posting**, so it must be indexed on `(organizationId, ledgerId, startsAt,
   * endsAt)`. A sequential scan here turns period closing into a per-posting table scan.
   */
  containing(input: {
    organizationId: string | null;
    ledgerId: string;
    at: Date;
  }): Promise<AccountingPeriod | null>;

  list(input: {
    organizationId: string | null;
    ledgerId?: string;
    status?: PeriodStatus;
    limit?: number;
  }): Promise<AccountingPeriod[]>;
}

/** Whether an instant falls inside a period. Half-open — see the schema. */
export function contains(period: AccountingPeriod, at: Date): boolean {
  return at >= period.startsAt && at < period.endsAt;
}

/**
 * Refuses a posting into a closed period.
 *
 * The message names the period and says what to do, because the answer is almost always "post it
 * to the current period with a note" rather than "reopen March" — and somebody who has just been
 * refused will reach for whichever option the error suggests.
 */
export function assertPeriodOpen(period: AccountingPeriod | null, effectiveAt: Date): void {
  if (!period || period.status === 'open') return;

  throw ApiError.conflict(
    `Period ${period.code} (${period.startsAt.toISOString().slice(0, 10)} to ` +
      `${period.endsAt.toISOString().slice(0, 10)}) was closed at ` +
      `${period.closedAt?.toISOString() ?? 'an unknown time'}, so nothing may post with an ` +
      `effective date of ${effectiveAt.toISOString()}. Post to the current period with a note ` +
      'explaining what it corrects, or reopen the period deliberately — reopening is recorded.',
    {
      reason: 'period_closed',
      periodId: period.id,
      periodCode: period.code,
      effectiveAt: effectiveAt.toISOString(),
    },
  );
}

/**
 * Periods that overlap a candidate window.
 *
 * Two periods covering one instant means a journal belongs to both, and which one a report uses
 * depends on which query ran. Checked before a period is created rather than discovered when a
 * close produces the wrong total.
 */
export function overlapping(
  existing: AccountingPeriod[],
  candidate: { startsAt: Date; endsAt: Date; ledgerId: string },
): AccountingPeriod[] {
  return existing.filter(
    (period) =>
      period.ledgerId === candidate.ledgerId &&
      period.startsAt < candidate.endsAt &&
      candidate.startsAt < period.endsAt,
  );
}

/** The closing totals as money, for a report. */
export function closingTotalsOf(
  period: AccountingPeriod,
  parse: (amount: string, currency: string) => Money,
): Array<{ currency: string; debits: Money; credits: Money }> {
  return period.closingTotals.map((total) => ({
    currency: total.currency,
    debits: parse(total.debits, total.currency),
    credits: parse(total.credits, total.currency),
  }));
}

/** `"2026-03: closed 2026-04-02, 130.00 USD each side"`. For an operator screen. */
export function describePeriod(
  period: AccountingPeriod,
  parse: (amount: string, currency: string) => Money,
): string {
  if (period.status === 'open') {
    return `${period.code}: open (${period.startsAt.toISOString().slice(0, 10)} to ${period.endsAt
      .toISOString()
      .slice(0, 10)})`;
  }

  const totals = closingTotalsOf(period, parse)
    .map((total) => `${formatMoney(total.debits)} each side`)
    .join(', ');

  return (
    `${period.code}: closed ${period.closedAt?.toISOString().slice(0, 10) ?? '?'}` +
    (totals ? `, ${totals}` : '') +
    (period.reopenings.length > 0 ? ` (reopened ${period.reopenings.length} time(s))` : '')
  );
}

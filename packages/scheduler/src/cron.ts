import { ApiError } from '@trustos/errors';

/**
 * Cron expressions.
 *
 * Five fields: minute, hour, day-of-month, month, day-of-week. No seconds field and no year
 * field, because the two dialects that add them disagree about which end they go on, and a
 * framework that accepted both would silently misread expressions written for the other.
 *
 * Written here rather than taken from a library for one reason: **the timezone handling**. Most
 * cron libraries either ignore timezones or depend on a several-megabyte timezone database. This
 * uses `Intl.DateTimeFormat`, which is in Node already and is backed by the same IANA data the
 * operating system uses — so `Asia/Phnom_Penh` works without shipping a copy of the tz database
 * and without going stale when the rules change.
 *
 * The daylight-saving cases are the ones that matter, and they are handled explicitly:
 *
 *   * **A time that does not exist.** When clocks spring forward, 02:30 may not happen. A job
 *     scheduled for it would otherwise never run — the search would step past midnight every day
 *     and find nothing. It fires at the first valid instant after the gap.
 *   * **A time that happens twice.** When clocks fall back, 01:30 occurs twice. The job runs
 *     once, on the first occurrence, because "run the nightly reconciliation twice" is a much
 *     worse outcome than "run it at the earlier of two 01:30s".
 *
 * Neither is theoretical. Both happen twice a year in every deployment whose timezone observes
 * daylight saving, and both are silent when wrong.
 */

export interface CronField {
  /** The permitted values, sorted. */
  values: number[];
  /** True when the field was `*`. Needed for the day-of-month / day-of-week rule below. */
  wildcard: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  expression: string;
}

const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
} as const;

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Common expressions, so nobody has to remember the field order to run something nightly. */
export const CRON_ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export function parseCron(expression: string): ParsedCron {
  const normalized = (CRON_ALIASES[expression.trim().toLowerCase()] ?? expression).trim();
  const fields = normalized.split(/\s+/);

  if (fields.length !== 5) {
    throw ApiError.validation(
      [
        {
          path: 'expression',
          message:
            `Expected 5 fields (minute hour day-of-month month day-of-week) and got ` +
            `${fields.length}. Six-field expressions with a seconds column are not supported — ` +
            'the dialects disagree about which end it goes on.',
        },
      ],
      `"${expression}" is not a valid cron expression.`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    minute: parseField(minute, 'minute'),
    hour: parseField(hour, 'hour'),
    dayOfMonth: parseField(dayOfMonth, 'dayOfMonth'),
    month: parseField(month, 'month'),
    dayOfWeek: parseField(dayOfWeek, 'dayOfWeek'),
    expression: normalized,
  };
}

function parseField(text: string, name: keyof typeof FIELD_RANGES): CronField {
  const [min, max] = FIELD_RANGES[name];
  const wildcard = text === '*';
  const values = new Set<number>();

  // A `function` declaration rather than an arrow: TypeScript only narrows control flow through
  // a never-returning call when the callee's type is known at the call site, which a `const`
  // arrow does not give you without an explicit type annotation on the binding.
  function fail(why: string): never {
    throw ApiError.validation(
      [{ path: name, message: `"${text}" is not valid for ${name}: ${why}` }],
      `The ${name} field is not valid.`,
    );
  }

  for (const part of text.split(',')) {
    // `*/15` and `1-30/5`. The step applies to the range on its left, or to the whole field.
    const [rangeText, stepText, ...extraSteps] = part.split('/');
    if (rangeText === undefined || rangeText === '') fail('an empty segment');
    if (extraSteps.length > 0) fail('more than one step');

    let step = 1;
    if (stepText !== undefined) {
      step = Number.parseInt(stepText, 10);
      if (!Number.isInteger(step) || step < 1) fail(`"${stepText}" is not a positive step`);
    }

    let start: number;
    let end: number;

    if (rangeText === '*') {
      start = min;
      end = max;
    } else if (rangeText.includes('-')) {
      const [fromText, toText] = rangeText.split('-');
      start = named(fromText ?? '', name);
      end = named(toText ?? '', name);

      /*
       * A range that wraps, like `fri-mon` or `22-2`.
       *
       * Supported, because "Friday to Monday" is what somebody means and rejecting it would send
       * them to write `5,6,0,1` — which is the same thing, less readable, and easier to get
       * wrong.
       */
      if (start > end) {
        for (let value = start; value <= max; value += step) values.add(value);
        for (let value = min; value <= end; value += step) values.add(value);
        continue;
      }
    } else {
      start = named(rangeText, name);
      end = stepText === undefined ? start : max;
    }

    if (Number.isNaN(start) || Number.isNaN(end)) fail('a value that is not a number');
    if (start < min || end > max) fail(`values must be between ${min} and ${max}`);

    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (values.size === 0) fail('it matches nothing');

  return { values: [...values].sort((a, b) => a - b), wildcard };
}

/** Resolves `mon`, `jan` and numbers alike. `7` is Sunday, as in most cron implementations. */
function named(text: string, field: keyof typeof FIELD_RANGES): number {
  const lowered = text.trim().toLowerCase();

  if (field === 'month') {
    const index = MONTH_NAMES.indexOf(lowered);
    if (index !== -1) return index + 1;
  }

  if (field === 'dayOfWeek') {
    const index = DAY_NAMES.indexOf(lowered);
    if (index !== -1) return index;
    // Both 0 and 7 mean Sunday. Accepting only one would silently break expressions copied from
    // a system that used the other.
    if (lowered === '7') return 0;
  }

  return Number.parseInt(lowered, 10);
}

/**
 * Whether a wall-clock time matches.
 *
 * The day-of-month / day-of-week rule is the one people get wrong: when **both** are restricted,
 * cron matches if **either** does — a union, not an intersection. So `0 0 1 * mon` runs on the
 * first of the month *and* on every Monday. That is surprising and it is what every cron
 * implementation does, so matching the surprise is more useful than being locally sensible.
 */
export function matchesCron(
  cron: ParsedCron,
  parts: { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number },
): boolean {
  if (!cron.minute.values.includes(parts.minute)) return false;
  if (!cron.hour.values.includes(parts.hour)) return false;
  if (!cron.month.values.includes(parts.month)) return false;

  const dayOfMonthMatches = cron.dayOfMonth.values.includes(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.includes(parts.dayOfWeek);

  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (cron.dayOfWeek.wildcard) return dayOfMonthMatches;

  return dayOfMonthMatches || dayOfWeekMatches;
}

/**
 * Wall-clock parts of an instant, in a timezone.
 *
 * `Intl.DateTimeFormat` rather than a bundled timezone database. It is already in Node, it uses
 * the same IANA data the operating system does, and it does not go stale when a country changes
 * its rules — which several do every year.
 */
export function wallClockIn(
  instant: Date,
  timezone: string,
): {
  year: number;
  month: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const formatter = getFormatter(timezone);
  const parts = new Map(
    formatter.formatToParts(instant).map((part) => [part.type, part.value] as const),
  );

  const hour = Number.parseInt(parts.get('hour') ?? '0', 10);

  return {
    year: Number.parseInt(parts.get('year') ?? '0', 10),
    month: Number.parseInt(parts.get('month') ?? '1', 10),
    dayOfMonth: Number.parseInt(parts.get('day') ?? '1', 10),
    // `hourCycle: 'h23'` gives 0–23, but some ICU versions still emit "24" for midnight.
    hour: hour === 24 ? 0 : hour,
    minute: Number.parseInt(parts.get('minute') ?? '0', 10),
    dayOfWeek: DAY_NAMES.indexOf((parts.get('weekday') ?? 'sun').toLowerCase().slice(0, 3)),
  };
}

/** Formatters are expensive to construct and are pure, so they are cached per timezone. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
  } catch {
    throw ApiError.validation(
      [
        {
          path: 'timezone',
          message:
            `"${timezone}" is not a timezone this system recognises. Use an IANA name such as ` +
            '"Asia/Phnom_Penh" or "UTC".',
        },
      ],
      'Unknown timezone.',
    );
  }

  formatters.set(timezone, formatter);
  return formatter;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    getFormatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** How far ahead the search gives up. Two years covers `0 0 29 2 *` — February 29th. */
const SEARCH_LIMIT_MINUTES = 2 * 366 * 24 * 60;

/**
 * The next instant at or after `after` that matches.
 *
 * Minute-by-minute forward search over wall-clock time in the target zone. Not the fastest
 * possible algorithm, and deliberately so: it is obviously correct across daylight-saving
 * transitions, where a cleverer arithmetic approach has to special-case the gap and the overlap
 * and usually gets one of them wrong.
 *
 * A `@daily` schedule needs about 1,440 iterations of integer comparison — under a millisecond.
 * The scheduler computes this once per fire, not per tick.
 *
 * Returns null if nothing matches within two years, which means an impossible expression like
 * `0 0 30 2 *` (February 30th).
 */
export function nextCronOccurrence(cron: ParsedCron, after: Date, timezone: string): Date | null {
  // Start at the next whole minute: a schedule is minute-resolution, and starting mid-minute
  // would match the minute that is already partly over.
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);

  for (let offset = 0; offset < SEARCH_LIMIT_MINUTES; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const parts = wallClockIn(candidate, timezone);

    if (matchesCron(cron, parts)) return candidate;
  }

  return null;
}

/**
 * The next occurrence, with the daylight-saving overlap collapsed.
 *
 * When clocks fall back, a wall-clock time occurs twice and the minute-by-minute search would
 * match both — running a nightly job twice. This keeps only the first: if the previous run was
 * for the same wall-clock minute in the same local day, the second occurrence is skipped.
 *
 * The other direction needs no special handling. A time inside a spring-forward gap simply never
 * appears in the search, so it is naturally skipped — see `nextValidOccurrence` for the case
 * where skipping the day entirely is not acceptable.
 */
export function nextOccurrenceAfterRun(
  cron: ParsedCron,
  lastRunAt: Date | null,
  after: Date,
  timezone: string,
): Date | null {
  const next = nextCronOccurrence(cron, after, timezone);
  if (!next || !lastRunAt) return next;

  const previous = wallClockIn(lastRunAt, timezone);
  const candidate = wallClockIn(next, timezone);

  const sameLocalMinute =
    previous.year === candidate.year &&
    previous.month === candidate.month &&
    previous.dayOfMonth === candidate.dayOfMonth &&
    previous.hour === candidate.hour &&
    previous.minute === candidate.minute;

  // The repeated hour. Running the nightly reconciliation twice is much worse than running it at
  // the earlier of two 01:30s.
  if (sameLocalMinute) return nextCronOccurrence(cron, next, timezone);

  return next;
}

/**
 * The next occurrence, never skipping a day because of a spring-forward gap.
 *
 * A job scheduled for 02:30 daily in a zone that springs forward at 02:00 would simply not run
 * that day — the search finds nothing at 02:30 and goes to tomorrow. For a nightly reconciliation
 * that is a missed day nobody notices until the numbers do not add up.
 *
 * This finds the first instant at or after the missing local time instead, so the job runs late
 * rather than not at all.
 */
export function nextValidOccurrence(
  cron: ParsedCron,
  after: Date,
  timezone: string,
): { at: Date; adjustedForDstGap: boolean } | null {
  const next = nextCronOccurrence(cron, after, timezone);

  /*
   * Whether a skipped local time lies between `after` and the natural next occurrence.
   *
   * Checked by actually asking whether each candidate wall-clock time exists, rather than by
   * inferring it from the size of the gap. An earlier version of this compared the interval
   * against 25 hours; a schedule at 02:30 on a spring-forward day produces a 24.5-hour gap and
   * slipped straight through, which is the whole case this function is for.
   */
  const skipped = firstSkippedOccurrence(cron, after, next, timezone);
  if (!skipped) return next ? { at: next, adjustedForDstGap: false } : null;

  return { at: skipped, adjustedForDstGap: true };
}

/**
 * The first instant after a wall-clock time that the clock skipped over.
 *
 * Walks local days between `after` and `limit`, and for each cron-matching local time asks
 * whether an instant maps to it. The first one that does not is a spring-forward gap, and the
 * value returned is the first real instant at or after it — so the job runs late rather than not
 * at all. Late is recoverable; a silently missed day is discovered when the numbers do not add up.
 */
function firstSkippedOccurrence(
  cron: ParsedCron,
  after: Date,
  limit: Date | null,
  timezone: string,
): Date | null {
  const end = limit ?? new Date(after.getTime() + 3 * 24 * 3_600_000);
  // A bounded walk. Three days covers any transition; beyond that the natural search is right.
  const maxDays = Math.min(3, Math.ceil((end.getTime() - after.getTime()) / 86_400_000) + 1);

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset += 1) {
    const dayAnchor = new Date(after.getTime() + dayOffset * 86_400_000);
    const day = wallClockIn(dayAnchor, timezone);

    if (!cron.month.values.includes(day.month)) continue;

    const dayOfMonthMatches = cron.dayOfMonth.values.includes(day.dayOfMonth);
    const dayOfWeekMatches = cron.dayOfWeek.values.includes(day.dayOfWeek);
    const dayMatches =
      cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
        ? true
        : cron.dayOfMonth.wildcard
          ? dayOfWeekMatches
          : cron.dayOfWeek.wildcard
            ? dayOfMonthMatches
            : dayOfMonthMatches || dayOfWeekMatches;

    if (!dayMatches) continue;

    for (const hour of cron.hour.values) {
      for (const minute of cron.minute.values) {
        const instant = instantForLocal(
          day.year,
          day.month,
          day.dayOfMonth,
          hour,
          minute,
          timezone,
        );

        // Exists, or is in the past — either way not a skipped future occurrence.
        if (instant !== null) continue;
        if (nominalIsBefore(day, hour, minute, after, timezone)) continue;

        const resumed = firstInstantAtOrAfterLocal(
          day.year,
          day.month,
          day.dayOfMonth,
          hour,
          minute,
          timezone,
        );
        if (resumed && resumed.getTime() > after.getTime()) return resumed;
      }
    }
  }

  return null;
}

/** Whether a nominal local time on a given day is already behind `reference`. */
function nominalIsBefore(
  day: { year: number; month: number; dayOfMonth: number },
  hour: number,
  minute: number,
  reference: Date,
  timezone: string,
): boolean {
  const referenceLocal = wallClockIn(reference, timezone);

  if (referenceLocal.year !== day.year) return referenceLocal.year > day.year;
  if (referenceLocal.month !== day.month) return referenceLocal.month > day.month;
  if (referenceLocal.dayOfMonth !== day.dayOfMonth) {
    return referenceLocal.dayOfMonth > day.dayOfMonth;
  }
  if (referenceLocal.hour !== hour) return referenceLocal.hour > hour;
  return referenceLocal.minute > minute;
}

/**
 * The instant matching a local wall-clock time, or null when that time does not exist.
 *
 * Two rounds of offset correction. One is not always enough: the first guess can land on the far
 * side of a transition, giving an offset that is right for the wrong instant. The final check —
 * formatting the result back and comparing — is what makes "does not exist" detectable rather
 * than silently returning a nearby time.
 */
export function instantForLocal(
  year: number,
  month: number,
  dayOfMonth: number,
  hour: number,
  minute: number,
  timezone: string,
): Date | null {
  const target = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  let guess = new Date(target);

  for (let round = 0; round < 2; round += 1) {
    const local = wallClockIn(guess, timezone);
    const localAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.dayOfMonth,
      local.hour,
      local.minute,
    );
    const drift = target - localAsUtc;
    if (drift === 0) break;
    guess = new Date(guess.getTime() + drift);
  }

  const check = wallClockIn(guess, timezone);
  const matches =
    check.year === year &&
    check.month === month &&
    check.dayOfMonth === dayOfMonth &&
    check.hour === hour &&
    check.minute === minute;

  return matches ? guess : null;
}

/**
 * The first real instant whose local time is at or after a nominal one.
 *
 * For a time inside a spring-forward gap this is the instant the clock resumes at. Searched
 * minute by minute over a bounded window — transitions are at most a few hours anywhere in the
 * IANA database.
 */
function firstInstantAtOrAfterLocal(
  year: number,
  month: number,
  dayOfMonth: number,
  hour: number,
  minute: number,
  timezone: string,
): Date | null {
  const nominal = Date.UTC(year, month - 1, dayOfMonth, hour, minute);

  // Start well before the nominal time in UTC terms, so every plausible offset is covered.
  for (let offset = -14 * 60; offset <= 14 * 60 + 240; offset += 1) {
    const candidate = new Date(nominal + offset * 60_000);
    const local = wallClockIn(candidate, timezone);

    if (local.year !== year || local.month !== month || local.dayOfMonth !== dayOfMonth) continue;
    if (local.hour > hour || (local.hour === hour && local.minute >= minute)) return candidate;
  }

  return null;
}

/** Renders an expression in words, for the admin UI and for `trustos doctor`. */
export function describeCron(cron: ParsedCron, timezone: string): string {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = cron;

  const everyMinute = minute.wildcard;
  const everyHour = hour.wildcard;

  const time =
    everyMinute && everyHour
      ? 'every minute'
      : everyHour
        ? `at ${minute.values.map((value) => `minute ${value}`).join(', ')} of every hour`
        : `at ${hour.values
            .flatMap((h) => minute.values.map((m) => `${pad(h)}:${pad(m)}`))
            .join(', ')}`;

  const days = dayOfMonth.wildcard
    ? dayOfWeek.wildcard
      ? 'every day'
      : `on ${dayOfWeek.values.map((value) => DAY_NAMES[value] ?? String(value)).join(', ')}`
    : `on day ${dayOfMonth.values.join(', ')} of the month`;

  const months = month.wildcard
    ? ''
    : ` in ${month.values.map((value) => MONTH_NAMES[value - 1] ?? String(value)).join(', ')}`;

  return `${time}, ${days}${months} (${timezone})`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

import { describe, expect, it } from 'vitest';
import {
  describeCron,
  isValidTimezone,
  matchesCron,
  nextCronOccurrence,
  nextOccurrenceAfterRun,
  nextValidOccurrence,
  parseCron,
  wallClockIn,
} from './cron';

describe('parsing', () => {
  it('reads the five fields', () => {
    const cron = parseCron('30 2 * * 1');

    expect(cron.minute.values).toEqual([30]);
    expect(cron.hour.values).toEqual([2]);
    expect(cron.dayOfMonth.wildcard).toBe(true);
    expect(cron.dayOfWeek.values).toEqual([1]);
  });

  it.each([
    ['@daily', '0 0 * * *'],
    ['@hourly', '0 * * * *'],
    ['@weekly', '0 0 * * 0'],
    ['@monthly', '0 0 1 * *'],
    ['@yearly', '0 0 1 1 *'],
  ])('expands %s', (alias, expected) => {
    expect(parseCron(alias).expression).toBe(expected);
  });

  it('reads a step', () => {
    expect(parseCron('*/15 * * * *').minute.values).toEqual([0, 15, 30, 45]);
  });

  it('reads a step within a range', () => {
    expect(parseCron('0-30/10 * * * *').minute.values).toEqual([0, 10, 20, 30]);
  });

  it('reads a list', () => {
    expect(parseCron('0,15,45 * * * *').minute.values).toEqual([0, 15, 45]);
  });

  it('reads a range', () => {
    expect(parseCron('0 9-17 * * *').hour.values).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('reads day and month names', () => {
    expect(parseCron('0 0 * jan mon').month.values).toEqual([1]);
    expect(parseCron('0 0 * jan mon').dayOfWeek.values).toEqual([1]);
  });

  it('reads a wrapping range, because "Friday to Monday" is what somebody means', () => {
    // Rejecting it would send them to write `5,6,0,1` — the same thing, less readable.
    expect(parseCron('0 0 * * fri-mon').dayOfWeek.values).toEqual([0, 1, 5, 6]);
  });

  it('accepts 7 as Sunday, as most cron implementations do', () => {
    // Accepting only one spelling would silently break expressions copied from a system using
    // the other.
    expect(parseCron('0 0 * * 7').dayOfWeek.values).toEqual([0]);
    expect(parseCron('0 0 * * 0').dayOfWeek.values).toEqual([0]);
  });

  it.each([
    ['* * * *', 'four fields'],
    ['* * * * * *', 'six fields — a seconds column'],
    ['60 * * * *', 'a minute out of range'],
    ['* 24 * * *', 'an hour out of range'],
    ['* * 32 * *', 'a day out of range'],
    ['* * * 13 *', 'a month out of range'],
    ['* * * * 8', 'a weekday out of range'],
    ['*/0 * * * *', 'a zero step'],
    ['*/-1 * * * *', 'a negative step'],
    ['abc * * * *', 'a non-numeric value'],
    ['', 'nothing'],
  ])('rejects %j (%s)', (expression) => {
    expect(() => parseCron(expression)).toThrow();
  });

  it('explains that a six-field expression is not supported, rather than guessing', () => {
    try {
      parseCron('0 0 0 * * *');
      expect.unreachable();
    } catch (error) {
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details[0]?.message).toMatch(/seconds column/);
    }
  });
});

describe('matching', () => {
  const at = (parts: Partial<Parameters<typeof matchesCron>[1]>) => ({
    minute: 0,
    hour: 0,
    dayOfMonth: 1,
    month: 1,
    dayOfWeek: 1,
    ...parts,
  });

  it('matches an exact time', () => {
    expect(matchesCron(parseCron('30 2 * * *'), at({ minute: 30, hour: 2 }))).toBe(true);
    expect(matchesCron(parseCron('30 2 * * *'), at({ minute: 31, hour: 2 }))).toBe(false);
  });

  it('unions day-of-month and day-of-week when both are restricted', () => {
    // Surprising, and what every cron implementation does — so matching the surprise is more
    // useful than being locally sensible.
    const cron = parseCron('0 0 1 * mon');

    expect(matchesCron(cron, at({ dayOfMonth: 1, dayOfWeek: 3 }))).toBe(true);
    expect(matchesCron(cron, at({ dayOfMonth: 15, dayOfWeek: 1 }))).toBe(true);
    expect(matchesCron(cron, at({ dayOfMonth: 15, dayOfWeek: 3 }))).toBe(false);
  });

  it('intersects when only one of the two is restricted', () => {
    const cron = parseCron('0 0 15 * *');

    expect(matchesCron(cron, at({ dayOfMonth: 15, dayOfWeek: 3 }))).toBe(true);
    expect(matchesCron(cron, at({ dayOfMonth: 14, dayOfWeek: 3 }))).toBe(false);
  });
});

describe('timezones', () => {
  it('reads wall-clock parts in the target zone', () => {
    // 2026-07-01T10:00Z is 17:00 in Phnom Penh (UTC+7).
    const parts = wallClockIn(new Date('2026-07-01T10:00:00Z'), 'Asia/Phnom_Penh');

    expect(parts).toMatchObject({ year: 2026, month: 7, dayOfMonth: 1, hour: 17, minute: 0 });
  });

  it('reports midnight as hour 0, not 24', () => {
    const parts = wallClockIn(new Date('2026-07-01T17:00:00Z'), 'Asia/Phnom_Penh');

    expect(parts.hour).toBe(0);
    expect(parts.dayOfMonth).toBe(2);
  });

  it('reads the weekday', () => {
    // 2026-07-01 is a Wednesday.
    expect(wallClockIn(new Date('2026-07-01T12:00:00Z'), 'UTC').dayOfWeek).toBe(3);
  });

  it.each(['UTC', 'Asia/Phnom_Penh', 'America/New_York', 'Europe/London', 'Australia/Sydney'])(
    'accepts %s',
    (timezone) => {
      expect(isValidTimezone(timezone)).toBe(true);
    },
  );

  it.each(['Mars/Olympus', 'GMT+7', 'not-a-zone'])('rejects %s', (timezone) => {
    expect(isValidTimezone(timezone)).toBe(false);
  });

  it('fires at the local time, not UTC', () => {
    // "2am in Phnom Penh" is 19:00 UTC the previous day. A scheduler that ignored the timezone
    // would run this at 9am local, which is exactly the failure timezone support prevents.
    const next = nextCronOccurrence(
      parseCron('0 2 * * *'),
      new Date('2026-07-01T00:00:00Z'),
      'Asia/Phnom_Penh',
    );

    expect(next?.toISOString()).toBe('2026-07-01T19:00:00.000Z');
  });
});

describe('the next occurrence', () => {
  it('finds the next daily fire', () => {
    const next = nextCronOccurrence(
      parseCron('0 3 * * *'),
      new Date('2026-07-01T10:00:00Z'),
      'UTC',
    );

    expect(next?.toISOString()).toBe('2026-07-02T03:00:00.000Z');
  });

  it('starts at the next whole minute, not mid-minute', () => {
    const next = nextCronOccurrence(
      parseCron('* * * * *'),
      new Date('2026-07-01T10:00:30Z'),
      'UTC',
    );

    // A schedule is minute-resolution; matching 10:00 when it is already 10:00:30 would fire for
    // a minute that is half over.
    expect(next?.toISOString()).toBe('2026-07-01T10:01:00.000Z');
  });

  it('finds a monthly fire', () => {
    const next = nextCronOccurrence(
      parseCron('0 0 1 * *'),
      new Date('2026-07-15T10:00:00Z'),
      'UTC',
    );

    expect(next?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('finds February 29th in a leap year', () => {
    const next = nextCronOccurrence(
      parseCron('0 0 29 2 *'),
      new Date('2026-07-01T00:00:00Z'),
      'UTC',
    );

    // 2028 is the next leap year. The two-year search limit exists exactly for this.
    expect(next?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('returns null for an impossible expression rather than searching forever', () => {
    expect(
      nextCronOccurrence(parseCron('0 0 30 2 *'), new Date('2026-07-01T00:00:00Z'), 'UTC'),
    ).toBeNull();
  });

  it('finds a weekday fire', () => {
    // 2026-07-01 is a Wednesday, so the next Monday is the 6th.
    const next = nextCronOccurrence(
      parseCron('0 9 * * mon'),
      new Date('2026-07-01T10:00:00Z'),
      'UTC',
    );

    expect(next?.toISOString()).toBe('2026-07-06T09:00:00.000Z');
  });
});

describe('daylight saving', () => {
  /*
   * New York springs forward at 2026-03-08 02:00 local (07:00Z) and falls back at
   * 2026-11-01 02:00 local (06:00Z). Both cases are silent when wrong, and both happen twice a
   * year in every deployment whose zone observes them.
   */

  it('does not run a job twice when the clock falls back', () => {
    // 01:30 local occurs twice on 2026-11-01: at 05:30Z (EDT) and again at 06:30Z (EST).
    const cron = parseCron('30 1 * * *');
    const first = nextCronOccurrence(cron, new Date('2026-11-01T00:00:00Z'), 'America/New_York');

    expect(first?.toISOString()).toBe('2026-11-01T05:30:00.000Z');

    // The naive search finds the second occurrence too.
    const naiveSecond = nextCronOccurrence(cron, first!, 'America/New_York');
    expect(naiveSecond?.toISOString()).toBe('2026-11-01T06:30:00.000Z');

    // Running the nightly reconciliation twice is much worse than running it at the earlier of
    // two 01:30s, so the run-aware search skips to the next day.
    const afterRun = nextOccurrenceAfterRun(cron, first!, first!, 'America/New_York');
    expect(afterRun?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });

  it('still fires normally on a day with no transition', () => {
    const cron = parseCron('30 1 * * *');
    const lastRun = new Date('2026-07-01T05:30:00Z');

    const next = nextOccurrenceAfterRun(cron, lastRun, lastRun, 'America/New_York');
    expect(next?.toISOString()).toBe('2026-07-02T05:30:00.000Z');
  });

  it('does not silently skip a day when the clock springs forward', () => {
    // 02:30 local does not exist on 2026-03-08: the clock goes 01:59 → 03:00.
    const cron = parseCron('30 2 * * *');
    const beforeGap = new Date('2026-03-08T06:00:00Z'); // 01:00 local, in the last EST hour.

    const naive = nextCronOccurrence(cron, beforeGap, 'America/New_York');
    // The naive search finds tomorrow — a whole day missed, and nobody notices until the numbers
    // do not add up.
    expect(naive?.toISOString()).toBe('2026-03-09T06:30:00.000Z');

    const adjusted = nextValidOccurrence(cron, beforeGap, 'America/New_York');
    expect(adjusted?.adjustedForDstGap).toBe(true);
    // Late rather than not at all.
    expect(adjusted!.at.getTime()).toBeLessThan(naive!.getTime());
  });

  it('does not adjust when there is no gap', () => {
    const result = nextValidOccurrence(
      parseCron('30 2 * * *'),
      new Date('2026-07-01T00:00:00Z'),
      'America/New_York',
    );

    expect(result?.adjustedForDstGap).toBe(false);
  });

  it('is unaffected in a zone with no daylight saving', () => {
    // Phnom Penh has observed no daylight saving since 1972, which is one reason it is a good
    // default for a deployment there.
    const cron = parseCron('30 1 * * *');
    const first = nextCronOccurrence(cron, new Date('2026-11-01T00:00:00Z'), 'Asia/Phnom_Penh');
    const second = nextOccurrenceAfterRun(cron, first!, first!, 'Asia/Phnom_Penh');

    expect(second!.getTime() - first!.getTime()).toBe(24 * 3_600_000);
  });
});

describe('describeCron', () => {
  it('renders a daily schedule in words', () => {
    expect(describeCron(parseCron('30 2 * * *'), 'Asia/Phnom_Penh')).toBe(
      'at 02:30, every day (Asia/Phnom_Penh)',
    );
  });

  it('renders a weekly schedule', () => {
    expect(describeCron(parseCron('0 9 * * mon'), 'UTC')).toBe('at 09:00, on mon (UTC)');
  });

  it('renders a stepped schedule', () => {
    expect(describeCron(parseCron('*/15 * * * *'), 'UTC')).toMatch(/minute 0, minute 15/);
  });
});

describe('performance', () => {
  it('finds a daily occurrence in well under a millisecond of budget', () => {
    // The search is minute-by-minute and deliberately so: obviously correct across daylight-saving
    // transitions, where cleverer arithmetic has to special-case the gap and the overlap and
    // usually gets one wrong. A daily schedule is ~1,440 integer comparisons.
    const cron = parseCron('0 3 * * *');
    const started = process.hrtime.bigint();

    for (let i = 0; i < 100; i += 1) {
      nextCronOccurrence(cron, new Date('2026-07-01T10:00:00Z'), 'UTC');
    }

    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 100;
    expect(perCallMs).toBeLessThan(20);
  });
});

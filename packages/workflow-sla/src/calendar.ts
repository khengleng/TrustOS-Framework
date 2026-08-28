/**
 * Business calendars.
 *
 * An SLA of "8 hours" means different deadlines depending on what counts as an hour.
 * Elapsed time is one answer; working hours, excluding weekends and public holidays,
 * is another — and for a bank they differ by days.
 *
 * This phase ships **elapsed time only**, and the abstraction exists so that adding
 * a working-hours calendar later is one class rather than a change to every SLA
 * calculation. A real holiday calendar is genuinely large: per-country, per-region,
 * per-year, with substitution rules for holidays falling at weekends, and it has to
 * be maintained forever. Guessing at it would produce a calendar that is wrong in
 * some jurisdiction and trusted anyway.
 *
 * The interface is two methods, and the second is the one that matters:
 *
 *   * `deadline` — when does 8 hours from now expire?
 *   * `elapsed` — how much of the SLA has been consumed between two instants?
 *
 * They are not inverses of each other under a working-hours calendar, which is why
 * both are on the interface rather than one being derived from the other.
 */

export interface BusinessCalendar {
  /** Registry key. `elapsed` is reserved for the shipped implementation. */
  readonly id: string;
  readonly description: string;

  /** The instant at which `seconds` of calendar time from `from` will have passed. */
  deadline(from: Date, seconds: number): Date;

  /** Calendar seconds between two instants. Never negative. */
  elapsed(from: Date, to: Date): number;
}

/**
 * Wall-clock time.
 *
 * The default, and correct for most operational SLAs: an incident does not pause
 * overnight, and a customer waiting for an approval does not care that it is Sunday.
 * A working-hours calendar is the right choice for a target somebody committed to in
 * a contract, which is a different thing and is why the abstraction exists.
 */
export class ElapsedTimeCalendar implements BusinessCalendar {
  readonly id = 'elapsed';
  readonly description = 'Wall-clock time. Weekends and holidays count.';

  deadline(from: Date, seconds: number): Date {
    return new Date(from.getTime() + seconds * 1000);
  }

  elapsed(from: Date, to: Date): number {
    // Clamped at zero. A negative elapsed time would come from clock skew or from a
    // caller passing the two instants the wrong way round, and either way "minus
    // three hours have passed" is not a useful number to propagate into an SLA
    // status.
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  }
}

/**
 * The calendar registry.
 *
 * A definition names a calendar by id, and validation refuses an unregistered one —
 * so a workflow referring to `working-hours-kh` fails at publication rather than
 * silently falling back to elapsed time. A silent fallback would be the worst
 * outcome: the SLA would appear to work and would be wrong by a factor of three.
 */
export class CalendarRegistry {
  private readonly calendars = new Map<string, BusinessCalendar>();

  constructor(calendars: BusinessCalendar[] = [new ElapsedTimeCalendar()]) {
    for (const calendar of calendars) this.register(calendar);
    // Always available, whatever the caller passed. Every default in the definition
    // schema is `elapsed`, so a registry without it would break every workflow that
    // did not name one explicitly.
    if (!this.calendars.has('elapsed')) this.register(new ElapsedTimeCalendar());
  }

  register(calendar: BusinessCalendar): void {
    this.calendars.set(calendar.id, calendar);
  }

  has(id: string): boolean {
    return this.calendars.has(id);
  }

  ids(): string[] {
    return [...this.calendars.keys()].sort();
  }

  /**
   * Resolves a calendar.
   *
   * Throws on an unknown id rather than falling back. See the note above: a fallback
   * here is an SLA that looks correct and is not.
   */
  get(id: string): BusinessCalendar {
    const calendar = this.calendars.get(id);
    if (!calendar) {
      throw new Error(
        `No business calendar is registered as "${id}". Registered: ${this.ids().join(', ')}. ` +
          'Refusing to fall back to elapsed time, which would make the SLA quietly wrong.',
      );
    }
    return calendar;
  }
}

/**
 * A worked example of a second calendar, for the documentation.
 *
 * Deliberately *not* registered by default and deliberately simple: Monday to Friday,
 * a fixed window, no holidays. It exists to show the shape of an implementation, and
 * its own docstring says why it is not good enough for a contractual SLA.
 */
export class SimpleWorkingHoursCalendar implements BusinessCalendar {
  readonly id: string;
  readonly description: string;

  /**
   * @param startHour first working hour, UTC, inclusive (9 = 09:00)
   * @param endHour last working hour, UTC, exclusive (17 = 17:00)
   *
   * UTC rather than a named timezone, because a timezone means DST, and DST means a
   * day that is 23 hours long. A production calendar has to handle that; this one
   * documents that it does not.
   */
  constructor(
    id = 'working-hours',
    private readonly startHour = 9,
    private readonly endHour = 17,
  ) {
    this.id = id;
    this.description =
      `Monday to Friday, ${startHour}:00–${endHour}:00 UTC. No holidays, no DST. ` +
      'An example implementation — not suitable for a contractual SLA.';
  }

  private isWorking(date: Date): boolean {
    const day = date.getUTCDay();
    if (day === 0 || day === 6) return false;
    const hour = date.getUTCHours();
    return hour >= this.startHour && hour < this.endHour;
  }

  /**
   * Steps forward in minutes until the budget is spent.
   *
   * Minute granularity, and a hard iteration cap. A loop over a caller-supplied
   * duration is a denial of service if it is unbounded — 400 days of minutes is 576k
   * iterations, which is fast, but a definition asking for 400 *years* would not be.
   * The schema caps a duration at one year; the cap here is the second line of
   * defence, and it fails loudly rather than spinning.
   */
  deadline(from: Date, seconds: number): Date {
    let remaining = Math.ceil(seconds / 60);
    let cursor = new Date(from.getTime());
    let iterations = 0;
    const maxIterations = 60 * 24 * 365 * 3;

    while (remaining > 0) {
      if (iterations++ > maxIterations) {
        throw new Error(
          `Could not compute a working-hours deadline for ${seconds}s within ` +
            `${maxIterations} minutes of simulation. The duration is too long for this calendar.`,
        );
      }
      cursor = new Date(cursor.getTime() + 60_000);
      if (this.isWorking(cursor)) remaining -= 1;
    }

    return cursor;
  }

  elapsed(from: Date, to: Date): number {
    if (to.getTime() <= from.getTime()) return 0;

    let working = 0;
    let cursor = new Date(from.getTime());
    let iterations = 0;
    const maxIterations = 60 * 24 * 365 * 3;

    while (cursor.getTime() < to.getTime()) {
      if (iterations++ > maxIterations) break;
      cursor = new Date(cursor.getTime() + 60_000);
      if (this.isWorking(cursor)) working += 1;
    }

    return working * 60;
  }
}

import { ModuleRepository, type ModuleContext } from '@trustsystem/module-sdk';
import { z } from 'zod';
import type { ReportingConfig } from './config';
import { EXPORT_FORMATS, type ExportFormat } from './export';

/**
 * Scheduled reports.
 *
 * The module computes *when* a report should next run and stores it; it does not
 * run anything. There is no scheduler here, and adding one would mean adding a
 * timer to a library that gets imported into request-handling processes, or a
 * queue the framework has explicitly kept out of scope. The application triggers
 * `dueSchedules` from whatever it already has — a platform cron, a worker, a
 * Railway scheduled job — and the module tells it what is due.
 */

export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/**
 * A frequency plus a time, rather than a cron expression.
 *
 * Cron is more expressive than a report schedule needs, and every field of it is
 * a way to write something that never fires — `0 0 31 2 *` runs on the 31st of
 * February. A closed set of frequencies cannot express an impossible schedule.
 */
export const reportScheduleSchema = z
  .object({
    reportId: z.string().min(1).max(80),
    frequency: z.enum(FREQUENCIES),
    /** Hour of the day, UTC. Stored in UTC so a schedule does not shift with DST. */
    hourUtc: z.number().int().min(0).max(23).default(6),
    /** 1 = Monday .. 7 = Sunday. Required for `weekly`. */
    dayOfWeek: z.number().int().min(1).max(7).nullable().default(null),
    /** 1..31, clamped to the last day of a shorter month. Required for `monthly`. */
    dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
    format: z.enum(EXPORT_FORMATS).default('csv'),
    filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.frequency === 'weekly' && value.dayOfWeek === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dayOfWeek'],
        message: 'Required for a weekly schedule.',
      });
    }
    if (value.frequency === 'monthly' && value.dayOfMonth === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dayOfMonth'],
        message: 'Required for a monthly schedule.',
      });
    }
  });

export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;

export interface ReportScheduleRow {
  id: string;
  organizationId: string;
  reportId: string;
  frequency: Frequency;
  hourUtc: number;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  format: ExportFormat;
  filters: Record<string, string | number | boolean>;
  nextRunAt: Date;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ReportScheduleStore {
  list(): Promise<ReportScheduleRow[]>;
  find(id: string, organizationId: string): Promise<ReportScheduleRow>;
  create(
    row: Omit<ReportScheduleRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<ReportScheduleRow>;
  update(id: string, patch: Partial<ReportScheduleRow>): Promise<ReportScheduleRow>;
  softDelete(id: string, now: Date): Promise<ReportScheduleRow>;
}

export class PrismaReportScheduleStore implements ReportScheduleStore {
  private readonly schedules: ModuleRepository<ReportScheduleRow>;

  constructor(context: ModuleContext<ReportingConfig>) {
    this.schedules = new ModuleRepository(context.prisma, 'reportSchedule', context.moduleId);
  }

  list(): Promise<ReportScheduleRow[]> {
    return this.schedules.list({ orderBy: { nextRunAt: 'asc' } });
  }

  find(id: string, organizationId: string): Promise<ReportScheduleRow> {
    return this.schedules.findById(id, organizationId);
  }

  create(
    row: Omit<ReportScheduleRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<ReportScheduleRow> {
    return this.schedules.create({ ...row });
  }

  update(id: string, patch: Partial<ReportScheduleRow>): Promise<ReportScheduleRow> {
    return this.schedules.update(id, { ...patch });
  }

  softDelete(id: string, now: Date): Promise<ReportScheduleRow> {
    return this.schedules.softDelete(id, now);
  }
}

/**
 * The next run strictly after `from`.
 *
 * Strictly after, not at-or-after: computing the next run immediately after a run
 * completes would otherwise return the same instant and the schedule would fire
 * in a loop.
 */
export function nextRunAt(
  schedule: Pick<ReportScheduleInput, 'frequency' | 'hourUtc' | 'dayOfWeek' | 'dayOfMonth'>,
  from: Date,
): Date {
  const candidate = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      schedule.hourUtc,
      0,
      0,
      0,
    ),
  );

  switch (schedule.frequency) {
    case 'daily': {
      if (candidate.getTime() > from.getTime()) return candidate;
      return addDays(candidate, 1);
    }

    case 'weekly': {
      // 1 = Monday .. 7 = Sunday, mapped from JavaScript's 0 = Sunday.
      const target = schedule.dayOfWeek ?? 1;
      const current = candidate.getUTCDay() === 0 ? 7 : candidate.getUTCDay();

      let delta = target - current;
      if (delta < 0 || (delta === 0 && candidate.getTime() <= from.getTime())) delta += 7;
      return addDays(candidate, delta);
    }

    case 'monthly': {
      const day = schedule.dayOfMonth ?? 1;
      const thisMonth = monthlyRun(
        from.getUTCFullYear(),
        from.getUTCMonth(),
        day,
        schedule.hourUtc,
      );
      if (thisMonth.getTime() > from.getTime()) return thisMonth;

      return monthlyRun(from.getUTCFullYear(), from.getUTCMonth() + 1, day, schedule.hourUtc);
    }

    default:
      return addDays(candidate, 1);
  }
}

/**
 * A monthly run, clamped to the last day of a short month.
 *
 * A schedule set for the 31st must fire in February rather than skipping it — a
 * month-end report that silently misses February is the failure this clamp exists
 * to prevent.
 */
function monthlyRun(year: number, month: number, day: number, hourUtc: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay), hourUtc, 0, 0, 0));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000);
}

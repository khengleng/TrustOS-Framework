import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustos/errors';
import { createTestModuleContext, type RecordingAuditPort } from '@trustos/module-sdk';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { reportingConfigSchema } from './config';
import { escapeCsvCell, exportFilename, toCsv, UnavailablePdfRenderer } from './export';
import { createStaticReportDataSource, resolveFilters, type ReportDefinition } from './report';
import { createReporting, reportingModule } from './reporting.module';
import type { ReportingService } from './reporting.service';
import { nextRunAt } from './schedule';

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const READ = 'payments.report.read';
const PRIVILEGED = 'payments.settlement.read';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

interface Harness {
  service: ReportingService;
  audit: RecordingAuditPort;
  schedules: FakeModelDelegate;
}

const ROWS = [
  { organizationId: ACME, reference: 'A-1', amount: 1050, merchant: 'Acme Ltd' },
  { organizationId: ACME, reference: 'A-2', amount: 2000, merchant: '=SUM(A1:A9)' },
];

function payoutsReport(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    id: 'payouts',
    name: 'Payouts',
    description: 'Payouts in the period.',
    permission: READ,
    columns: [
      { key: 'reference', label: 'Reference', type: 'string' },
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'merchant', label: 'Merchant', type: 'string' },
    ],
    filters: [
      { key: 'from', label: 'From', type: 'date', required: false },
      { key: 'merchant', label: 'Merchant', type: 'string', required: false },
    ],
    dataSource: createStaticReportDataSource(ROWS),
    ...overrides,
  };
}

function buildHarness(config: Record<string, unknown> = {}): Harness {
  const schedules = new FakeModelDelegate([
    {
      id: 'sch_rival',
      organizationId: RIVAL,
      reportId: 'payouts',
      frequency: 'daily',
      hourUtc: 6,
      dayOfWeek: null,
      dayOfMonth: null,
      format: 'csv',
      filters: {},
      nextRunAt: new Date('2026-01-02T06:00:00.000Z'),
      lastRunAt: null,
      ...timestamps,
    },
  ]);

  const { context, audit } = createTestModuleContext(reportingModule, {
    config,
    prisma: { reportSchedule: schedules },
  });

  const instance = createReporting(context);
  instance.service.register(payoutsReport());

  return { service: instance.service, audit, schedules };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('report access', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('lists only reports whose permission the caller holds', () => {
    harness.service.register(payoutsReport({ id: 'settlements', permission: PRIVILEGED }));

    expect(harness.service.list([READ]).map((report) => report.id)).toEqual(['payouts']);
    expect(harness.service.list([READ, PRIVILEGED]).map((report) => report.id)).toEqual([
      'payouts',
      'settlements',
    ]);
    expect(harness.service.list(['*'])).toHaveLength(2);
  });

  it('reports a report the caller may not read as not_found, not forbidden', async () => {
    harness.service.register(payoutsReport({ id: 'settlements', permission: PRIVILEGED }));

    try {
      await asAcme(() => harness.service.run('settlements', ACME, [READ]));
      expect.unreachable('should have thrown');
    } catch (error) {
      // A 403 would confirm which reports exist, and a report id names the data
      // it exposes.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('never returns a report definition data source over the wire', () => {
    const summary = harness.service.find('payouts', [READ]);
    expect('dataSource' in summary).toBe(false);
  });

  it('refuses to register the same report id twice', () => {
    // Otherwise the report a caller gets depends on module import order.
    expect(() => harness.service.register(payoutsReport())).toThrowError(/already registered/);
  });
});

describe('running a report', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('paginates and reports the total', async () => {
    const page = await asAcme(() =>
      harness.service.run('payouts', ACME, [READ], { page: 1, pageSize: 1 }),
    );

    expect(page.items).toHaveLength(1);
    expect(page.meta.totalItems).toBe(2);
    expect(page.meta.hasNextPage).toBe(true);
  });

  it('audits the run with its filters but not its rows', async () => {
    await asAcme(() =>
      harness.service.run('payouts', ACME, [READ], { filters: { merchant: 'Acme Ltd' } }),
    );

    const record = harness.audit.byAction('reporting.report.run')[0];
    expect(record?.after).toMatchObject({ filters: { merchant: 'Acme Ltd' }, rows: 2 });
    // A report is a bulk read of customer data; the trail records that it
    // happened, not a second copy of the data.
    expect(JSON.stringify(record)).not.toContain('A-1');
  });

  it('rejects a filter the report does not declare', async () => {
    // Silently dropping it would return a full result set to a caller who
    // believed they had narrowed it.
    await expect(
      asAcme(() => harness.service.run('payouts', ACME, [READ], { filters: { secret: 'x' } })),
    ).rejects.toThrow(/filters are not valid/);
  });

  it('rejects a filter value of the wrong type', async () => {
    await expect(
      asAcme(() => harness.service.run('payouts', ACME, [READ], { filters: { from: 'nonsense' } })),
    ).rejects.toThrow(/filters are not valid/);
  });

  it('refuses rows belonging to another organization', async () => {
    const leaky = buildHarness();
    leaky.service.register(
      payoutsReport({
        id: 'leaky',
        dataSource: createStaticReportDataSource([
          { organizationId: RIVAL, reference: 'R-1', amount: 1, merchant: 'Rival' },
        ]),
      }),
    );

    // A report is exactly the shape in which a cross-tenant leak goes unnoticed:
    // a list of rows nobody reads individually.
    await expect(asAcme(() => leaky.service.run('leaky', ACME, [READ]))).rejects.toThrow(
      /could not be produced/,
    );
  });

  it('caps the page size at the configured maximum', async () => {
    const capped = buildHarness({ maxPageSize: 1 });
    const page = await asAcme(() => capped.service.run('payouts', ACME, [READ], { pageSize: 500 }));

    expect(page.meta.pageSize).toBe(1);
  });
});

describe('CSV export', () => {
  it('neutralises a cell that a spreadsheet would treat as a formula', () => {
    // `=cmd|' /c calc'!A1` in a CSV opened in Excel is code execution on the
    // machine of whoever opened it.
    expect(escapeCsvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('-1')).toBe("'-1");
    expect(escapeCsvCell('@import')).toBe("'@import");
    // A tab needs no quoting under RFC 4180 — only a comma, a quote or a line
    // break do — but it still gets the apostrophe, which is what neutralises it.
    expect(escapeCsvCell('\tstart')).toBe("'\tstart");
  });

  it('quotes and doubles quotes per RFC 4180', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('renders empty for null and undefined rather than the word null', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('takes column order from the definition, not from the first row', () => {
    const columns = [
      { key: 'a', label: 'A', type: 'string' as const },
      { key: 'b', label: 'B', type: 'string' as const },
      { key: 'c', label: 'C', type: 'string' as const },
    ];

    // The second row is missing `b`. Its cell must be empty, not shift `c` left.
    const csv = toCsv(columns, [
      { a: '1', b: '2', c: '3' },
      { a: '4', c: '6' },
    ]);

    expect(csv.split('\r\n')).toEqual(['A,B,C', '1,2,3', '4,,6']);
  });

  it('exports a report and audits it', async () => {
    const harness = buildHarness();
    const result = await asAcme(() => harness.service.export('payouts', ACME, [READ], 'csv'));

    expect(result.contentType).toContain('text/csv');
    expect(result.filename).toMatch(/^payouts-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
    expect(result.content.toString()).toContain("'=SUM(A1:A9)");
    expect(harness.audit.byAction('reporting.report.exported')).toHaveLength(1);
  });

  it('refuses an export larger than the ceiling rather than truncating it', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      organizationId: ACME,
      reference: `R-${index}`,
      amount: index,
      merchant: 'Acme',
    }));

    const harness = buildHarness({ maxExportRows: 2 });
    harness.service.register(
      payoutsReport({ id: 'big', dataSource: createStaticReportDataSource(rows) }),
    );

    // A partial export that looks complete is how a reconciliation ends up short
    // by exactly the rows nobody knew were missing.
    await expect(asAcme(() => harness.service.export('big', ACME, [READ], 'csv'))).rejects.toThrow(
      /too large to export/,
    );
  });

  it('sanitises the filename, which crosses into a response header', () => {
    const name = exportFilename('../../etc/passwd', 'csv', new Date('2026-01-01T00:00:00.000Z'));
    expect(name).toBe('------etc-passwd-2026-01-01-00-00-00.csv');
    expect(name).not.toContain('/');
  });
});

describe('PDF export', () => {
  it('refuses with a clear message rather than producing an empty file', async () => {
    const harness = buildHarness();

    await expect(
      asAcme(() => harness.service.export('payouts', ACME, [READ], 'pdf')),
    ).rejects.toThrow(/not configured/);
  });

  it('uses a renderer when the application supplies one', async () => {
    const { context } = createTestModuleContext(reportingModule, {
      prisma: { reportSchedule: new FakeModelDelegate([]) },
    });

    const instance = createReporting(context, {
      pdf: {
        id: 'test',
        render: async () => Buffer.from('%PDF-1.4 test'),
      },
    });
    instance.service.register(payoutsReport());

    const result = await asAcme(() => instance.service.export('payouts', ACME, [READ], 'pdf'));
    expect(result.content.toString()).toContain('%PDF');
  });

  it('refuses to start when pdfEnabled is set with no renderer', async () => {
    const { context } = createTestModuleContext(reportingModule, {
      config: { pdfEnabled: true },
      prisma: { reportSchedule: new FakeModelDelegate([]) },
    });

    // An application that advertises PDF export and has no renderer fails on the
    // export, in front of a user.
    await expect(createReporting(context).initialize()).rejects.toThrow(/no PdfRenderer/);
  });

  it('is the only implementation shipped, and it always throws', async () => {
    await expect(new UnavailablePdfRenderer().render()).rejects.toThrow(/not configured/);
  });
});

describe('schedules', () => {
  it('computes the next daily run strictly after now', () => {
    const from = new Date('2026-03-01T07:00:00.000Z');
    // 06:00 today has passed, so the next run is tomorrow.
    expect(
      nextRunAt({ frequency: 'daily', hourUtc: 6, dayOfWeek: null, dayOfMonth: null }, from),
    ).toEqual(new Date('2026-03-02T06:00:00.000Z'));

    expect(
      nextRunAt({ frequency: 'daily', hourUtc: 9, dayOfWeek: null, dayOfMonth: null }, from),
    ).toEqual(new Date('2026-03-01T09:00:00.000Z'));
  });

  it('computes the next weekly run', () => {
    // 2026-03-01 is a Sunday (7).
    const from = new Date('2026-03-01T07:00:00.000Z');
    expect(
      nextRunAt({ frequency: 'weekly', hourUtc: 6, dayOfWeek: 1, dayOfMonth: null }, from),
    ).toEqual(new Date('2026-03-02T06:00:00.000Z'));

    // Same day, but the hour has passed: next week.
    expect(
      nextRunAt({ frequency: 'weekly', hourUtc: 6, dayOfWeek: 7, dayOfMonth: null }, from),
    ).toEqual(new Date('2026-03-08T06:00:00.000Z'));
  });

  it('clamps a monthly run to the last day of a short month', () => {
    const from = new Date('2026-02-01T00:00:00.000Z');
    // A month-end report set for the 31st must fire in February, not skip it.
    expect(
      nextRunAt({ frequency: 'monthly', hourUtc: 6, dayOfWeek: null, dayOfMonth: 31 }, from),
    ).toEqual(new Date('2026-02-28T06:00:00.000Z'));
  });

  it('never returns the instant it was given, so a schedule cannot loop', () => {
    const at = new Date('2026-03-01T06:00:00.000Z');
    const next = nextRunAt(
      { frequency: 'daily', hourUtc: 6, dayOfWeek: null, dayOfMonth: null },
      at,
    );
    expect(next.getTime()).toBeGreaterThan(at.getTime());
  });

  it('creates a schedule and records the next run', async () => {
    const harness = buildHarness();
    const row = await asAcme(() =>
      harness.service.schedule(
        {
          reportId: 'payouts',
          frequency: 'daily',
          hourUtc: 6,
          dayOfWeek: null,
          dayOfMonth: null,
          format: 'csv',
          filters: {},
        },
        ACME,
        [READ],
      ),
    );

    expect(row.nextRunAt.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00.000Z').getTime());
    expect(harness.audit.byAction('reporting.schedule.created')).toHaveLength(1);
  });

  it('refuses to schedule a report the caller cannot run', async () => {
    const harness = buildHarness();
    harness.service.register(payoutsReport({ id: 'settlements', permission: PRIVILEGED }));

    // Otherwise scheduling is a way to receive data the caller may not read.
    await expect(
      asAcme(() =>
        harness.service.schedule(
          {
            reportId: 'settlements',
            frequency: 'daily',
            hourUtc: 6,
            dayOfWeek: null,
            dayOfMonth: null,
            format: 'csv',
            filters: {},
          },
          ACME,
          [READ],
        ),
      ),
    ).rejects.toThrow(/No report with id/);
  });

  it('rejects a weekly schedule with no day', () => {
    const harness = buildHarness();
    return expect(
      asAcme(() =>
        harness.service.schedule(
          {
            reportId: 'payouts',
            frequency: 'weekly',
            hourUtc: 6,
            dayOfWeek: null,
            dayOfMonth: null,
            format: 'csv',
            filters: {},
          },
          ACME,
          [READ],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('reporting tenant isolation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('lists only the calling organization schedules', async () => {
    await asAcme(() =>
      harness.service.schedule(
        {
          reportId: 'payouts',
          frequency: 'daily',
          hourUtc: 6,
          dayOfWeek: null,
          dayOfMonth: null,
          format: 'csv',
          filters: {},
        },
        ACME,
        [READ],
      ),
    );

    expect(
      (await asAcme(() => harness.service.listSchedules())).every(
        (row) => row.organizationId === ACME,
      ),
    ).toBe(true);
    expect((await asRival(() => harness.service.listSchedules())).map((row) => row.id)).toEqual([
      'sch_rival',
    ]);
  });

  it('cannot remove another organization schedule', async () => {
    await expect(asAcme(() => harness.service.removeSchedule('sch_rival', ACME))).rejects.toThrow();
  });

  it('passes the calling organization to the data source', async () => {
    let seen: string | null = null;
    harness.service.register(
      payoutsReport({
        id: 'probe',
        dataSource: async (query) => {
          seen = query.organizationId;
          return { rows: [], totalRows: 0 };
        },
      }),
    );

    await asRival(() => harness.service.run('probe', RIVAL, [READ]));
    expect(seen).toBe(RIVAL);
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(harness.service.listSchedules()).rejects.toThrow(
      /Organization context is required/,
    );
  });
});

describe('filter resolution', () => {
  it('drops empty values rather than treating them as filters', () => {
    const resolved = resolveFilters(payoutsReport(), { merchant: '', from: undefined });
    expect(resolved).toEqual({});
  });

  it('requires a filter marked required', () => {
    const definition = payoutsReport({
      filters: [{ key: 'from', label: 'From', type: 'date', required: true }],
    });
    expect(() => resolveFilters(definition, {})).toThrowError(/not valid/);
  });
});

describe('configuration validation', () => {
  it('installs with no configuration at all', () => {
    expect(reportingConfigSchema.parse({})).toEqual({
      maxExportRows: 50_000,
      maxPageSize: 100,
      pdfEnabled: false,
    });
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    expect(reportingConfigSchema.safeParse({ maxExport: 10 }).success).toBe(false);
  });
});

describe('lifecycle', () => {
  it('refuses to start without a database for schedules', async () => {
    const { context } = createTestModuleContext(reportingModule, { prisma: null });

    // Schedules are rows. Falling back to memory would mean a scheduled report
    // that silently stops existing after a restart.
    await expect(createReporting(context).initialize()).rejects.toThrow(/needs a database/);
  });

  it('starts when a schedule store is supplied instead', async () => {
    const { context } = createTestModuleContext(reportingModule, { prisma: null });
    const instance = createReporting(context, {
      schedules: {
        list: async () => [],
        find: async () => {
          throw new Error('not used');
        },
        create: async () => {
          throw new Error('not used');
        },
        update: async () => {
          throw new Error('not used');
        },
        softDelete: async () => {
          throw new Error('not used');
        },
      },
    });

    await expect(instance.initialize()).resolves.toBeUndefined();
  });

  it('names the PDF renderer in its health detail', async () => {
    const harness = buildHarness();
    expect(harness.service).toBeDefined();

    const { context } = createTestModuleContext(reportingModule, {
      prisma: { reportSchedule: new FakeModelDelegate([]) },
    });
    const indicator = createReporting(context).healthIndicator();

    expect(indicator.name).toBe('module:reporting');
    expect((await indicator.check()).detail).toContain('unavailable');
  });
});

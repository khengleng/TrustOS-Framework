import { describe, expect, it, vi } from 'vitest';
import { BufferSink, ExportService, type ExportSource } from './export-service';
import {
  CsvFormatter,
  FormatterRegistry,
  JsonFormatter,
  JsonLinesFormatter,
  escapeCsvCell,
  stripFormulaPrefix,
} from './formats';
import { InMemoryExportStore } from './testing';

let counter = 0;

/** A source over a fixed list of rows, paged with a keyset cursor. */
function sourceOver(rows: Array<Record<string, unknown>>, overrides: Partial<ExportSource> = {}) {
  const source: ExportSource = {
    type: 'test.people',
    description: 'People.',
    columns: [
      { key: 'id' },
      { key: 'name', header: 'Full name' },
      { key: 'joinedAt', format: (value) => (value as Date | null)?.toISOString().slice(0, 10) },
    ],
    fetchPage: async ({ cursor, limit, organizationId }) => {
      const scoped = rows.filter((row) => row.organizationId === organizationId);
      const start = cursor === null ? 0 : Number.parseInt(cursor, 10);
      const page = scoped.slice(start, start + limit);
      const next = start + page.length;

      return { rows: page, nextCursor: next < scoped.length ? String(next) : null };
    },
    ...overrides,
  };

  return source;
}

function setup(source: ExportSource) {
  const store = new InMemoryExportStore();
  const audit = { record: vi.fn() };

  const service = new ExportService({
    store,
    formatters: new FormatterRegistry(),
    sources: [source],
    audit,
    pageSize: 2,
    now: () => new Date('2026-07-01T10:00:00Z'),
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { service, store, audit };
}

const people = [
  { organizationId: 'org_1', id: '1', name: 'Ada', joinedAt: new Date('2026-01-01') },
  { organizationId: 'org_1', id: '2', name: 'Grace', joinedAt: new Date('2026-02-01') },
  { organizationId: 'org_1', id: '3', name: 'Alan', joinedAt: new Date('2026-03-01') },
  { organizationId: 'org_2', id: '4', name: 'Other tenant', joinedAt: new Date('2026-04-01') },
];

describe('CSV escaping', () => {
  it('quotes a value containing a comma', () => {
    expect(escapeCsvCell('Smith, Ada')).toBe('"Smith, Ada"');
  });

  it('doubles an internal quote', () => {
    expect(escapeCsvCell('She said "hi"')).toBe('"She said ""hi"""');
  });

  it('quotes a value containing a newline', () => {
    expect(escapeCsvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('leaves a plain value alone', () => {
    expect(escapeCsvCell('Ada')).toBe('Ada');
  });

  it.each([
    ["=cmd|' /C calc'!A0", 'the classic payload'],
    ['+1234', 'a plus'],
    ['-1+1', 'a minus'],
    ['@SUM(A1)', 'an at sign'],
  ])('neutralises %j (%s)', (value) => {
    // The data came from a user — a customer name, a note field — so this is a stored injection
    // whose payload runs on the machine of whoever opens the export.
    const escaped = escapeCsvCell(value);

    expect(escaped.startsWith(`"'`)).toBe(true);
    expect(escaped).not.toMatch(/^[=+\-@]/);
  });

  it('round-trips through the prefix stripper for a machine consumer', () => {
    expect(stripFormulaPrefix(escapeCsvCell('-42').slice(1, -1))).toBe('-42');
  });

  it('can be turned off explicitly, for a machine-read export', () => {
    expect(escapeCsvCell('-42', { escapeFormulas: false })).toBe('-42');
  });

  it('formats a date and a null consistently', () => {
    expect(escapeCsvCell(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07-01T00:00:00.000Z');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });
});

describe('the CSV formatter', () => {
  it('writes a header from the column headers', () => {
    const formatter = new CsvFormatter();
    const header = formatter.begin([{ key: 'id' }, { key: 'name', header: 'Full name' }]);

    expect(header).toContain('id,Full name');
  });

  it('writes a byte-order mark, so Excel does not mangle non-ASCII', () => {
    // Three bytes between a usable export and a support ticket about mojibake.
    expect(new CsvFormatter().begin([{ key: 'id' }]).charCodeAt(0)).toBe(0xfeff);
  });

  it('applies a column formatter', () => {
    const formatter = new CsvFormatter();
    const columns = [
      { key: 'joinedAt', format: (value: unknown) => (value as Date).getFullYear() },
    ];

    expect(formatter.write([{ joinedAt: new Date('2026-07-01') }], columns)).toBe('2026\n');
  });

  it('writes nothing for an empty batch', () => {
    expect(new CsvFormatter().write([], [{ key: 'id' }])).toBe('');
  });
});

describe('the JSON formatter', () => {
  it('produces valid JSON across several batches', () => {
    // The brackets and commas are managed incrementally, so a large export never holds every row.
    const formatter = new JsonFormatter();
    const columns = [{ key: 'id' }];

    const output =
      formatter.begin() +
      formatter.write([{ id: '1' }], columns) +
      formatter.write([{ id: '2' }], columns) +
      formatter.end();

    expect(JSON.parse(output)).toEqual({ items: [{ id: '1' }, { id: '2' }] });
  });

  it('produces valid JSON with no rows at all', () => {
    const formatter = new JsonFormatter();
    expect(JSON.parse(formatter.begin() + formatter.end())).toEqual({ items: [] });
  });

  it('projects only the declared columns', () => {
    const formatter = new JsonFormatter();
    const output =
      formatter.begin() +
      formatter.write([{ id: '1', secret: 'x' }], [{ key: 'id' }]) +
      formatter.end();

    expect(JSON.parse(output)).toEqual({ items: [{ id: '1' }] });
  });
});

describe('the JSON-lines formatter', () => {
  it('writes one independently-parseable object per line', () => {
    // A consumer streams a million rows without a streaming parser, and a truncated file is still
    // readable up to the truncation.
    const formatter = new JsonLinesFormatter();
    const output = formatter.write([{ id: '1' }, { id: '2' }], [{ key: 'id' }]);

    expect(
      output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ id: '1' }, { id: '2' }]);
  });
});

describe('running an export', () => {
  it('streams every page into the sink', async () => {
    const { service } = setup(sourceOver(people));
    const sink = new BufferSink();

    const run = await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink,
      actorId: 'usr_1',
    });

    expect(run.status).toBe('completed');
    expect(run.rowCount).toBe(3);
    expect(sink.content).toContain('Ada');
    expect(sink.content).toContain('Alan');
  });

  it('never gives one tenant another’s rows', async () => {
    const { service } = setup(sourceOver(people));
    const sink = new BufferSink();

    await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink,
      actorId: 'usr_1',
    });

    // The worst single failure available in this package.
    expect(sink.content).not.toContain('Other tenant');
  });

  it('pages rather than fetching everything at once', async () => {
    const fetchPage = vi.fn(sourceOver(people).fetchPage);
    const { service } = setup(sourceOver(people, { fetchPage }));

    await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink: new BufferSink(),
      actorId: 'usr_1',
    });

    // Page size 2 over 3 rows: two pages, then a third call that returns the tail.
    expect(fetchPage.mock.calls.length).toBeGreaterThan(1);
    expect(fetchPage.mock.calls.every(([input]) => input.limit <= 2)).toBe(true);
  });

  it('stops at the row limit and records that it truncated', async () => {
    const { service } = setup(sourceOver(people, { maxRows: 2 }));
    const sink = new BufferSink();

    const run = await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink,
      actorId: 'usr_1',
    });

    expect(run.rowCount).toBe(2);
    // Recorded rather than only logged: somebody reading the file needs to know it is not the
    // whole answer.
    expect(run.error).toMatch(/Truncated at the 2-row limit/);
  });

  it('stops rather than looping when a source returns a cursor with no rows', async () => {
    // Continuing means an export that never finishes, holding a connection and a sink open.
    const { service } = setup(
      sourceOver(people, { fetchPage: async () => ({ rows: [], nextCursor: 'always' }) }),
    );

    const run = await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink: new BufferSink(),
      actorId: 'usr_1',
    });

    expect(run.rowCount).toBe(0);
    expect(run.status).toBe('completed');
  });

  it('discards the partial artefact when the source fails', async () => {
    const { service } = setup(
      sourceOver(people, {
        fetchPage: async () => {
          throw new Error('the query timed out');
        },
      }),
    );
    const sink = new BufferSink();

    await expect(
      service.run({
        type: 'test.people',
        format: 'csv',
        organizationId: 'org_1',
        sink,
        actorId: 'usr_1',
      }),
    ).rejects.toThrow(/timed out/);

    // A half-written export left in storage is one somebody will download and treat as complete.
    expect(sink.aborted?.message).toMatch(/timed out/);
  });

  it('records a failed run with the reason', async () => {
    const { service, store } = setup(
      sourceOver(people, {
        fetchPage: async () => {
          throw new Error('the query timed out');
        },
      }),
    );

    await service
      .run({
        type: 'test.people',
        format: 'csv',
        organizationId: 'org_1',
        sink: new BufferSink(),
        actorId: 'usr_1',
      })
      .catch(() => {});

    const [run] = [...store.runs.values()];
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/timed out/);
  });

  it('honours a cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    const { service, store } = setup(sourceOver(people));

    await expect(
      service.run({
        type: 'test.people',
        format: 'csv',
        organizationId: 'org_1',
        sink: new BufferSink(),
        actorId: 'usr_1',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);

    expect([...store.runs.values()][0]?.status).toBe('cancelled');
  });

  it('reports progress as rows are written', async () => {
    const { service } = setup(sourceOver(people));
    const progress: number[] = [];

    await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink: new BufferSink(),
      actorId: 'usr_1',
      onProgress: (rowCount) => progress.push(rowCount),
    });

    expect(progress.at(-1)).toBe(3);
  });

  it('records the parameters, for "what exactly did this file contain"', async () => {
    const { service, audit } = setup(sourceOver(people));

    await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      params: { status: 'active', from: '2026-01-01' },
      sink: new BufferSink(),
      actorId: 'usr_1',
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'export.completed',
        after: expect.objectContaining({
          parameters: { status: 'active', from: '2026-01-01' },
        }),
      }),
    );
  });

  it('names the file from the type and date when none is given', async () => {
    const { service } = setup(sourceOver(people));

    const run = await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink: new BufferSink(),
      actorId: 'usr_1',
    });

    expect(run.fileName).toBe('test-people-2026-07-01.csv');
  });
});

describe('column selection', () => {
  it('restricts the output to the requested columns', async () => {
    const { service } = setup(sourceOver(people));
    const sink = new BufferSink();

    await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink,
      actorId: 'usr_1',
      columns: ['name'],
    });

    expect(sink.content).toContain('Full name');
    expect(sink.content).not.toContain('joinedAt');
  });

  it('refuses a column the source never declared', async () => {
    // Without this, a caller could name any property on the row object — including one the source
    // never meant to expose. `organizationId` is on every row here and is not a declared column.
    const { service } = setup(sourceOver(people));

    await expect(
      service.run({
        type: 'test.people',
        format: 'csv',
        organizationId: 'org_1',
        sink: new BufferSink(),
        actorId: 'usr_1',
        columns: ['organizationId'],
      }),
    ).rejects.toThrow(/does not have those columns/);
  });
});

describe('preview', () => {
  it('returns a sample and the columns without running the export', async () => {
    const { service, store } = setup(sourceOver(people));

    const preview = await service.preview({
      type: 'test.people',
      organizationId: 'org_1',
      limit: 2,
    });

    expect(preview.sample).toHaveLength(2);
    expect(preview.hasMore).toBe(true);
    expect(preview.columns.map((column) => column.key)).toEqual(['id', 'name', 'joinedAt']);
    expect(store.runs.size).toBe(0);
  });
});

describe('registration', () => {
  it('refuses two sources for one type', () => {
    const { service } = setup(sourceOver(people));

    expect(() => service.register(sourceOver(people))).toThrow(/already registered/);
  });

  it('names what is registered when asked for an unknown type', async () => {
    const { service } = setup(sourceOver(people));

    await expect(
      service.run({
        type: 'test.missing',
        format: 'csv',
        organizationId: 'org_1',
        sink: new BufferSink(),
        actorId: 'usr_1',
      }),
    ).rejects.toThrow(/Unknown export type/);
  });

  it('names Excel and PDF as ports rather than failing opaquely', () => {
    expect(() => new FormatterRegistry().get('pdf')).toThrow();
    expect(new FormatterRegistry().formats()).toEqual(['csv', 'json', 'jsonl']);
  });
});

describe('tenant isolation', () => {
  it('does not return another organization’s run', async () => {
    const { service } = setup(sourceOver(people));

    const run = await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink: new BufferSink(),
      actorId: 'usr_1',
    });

    await expect(service.get(run.id, 'org_2')).rejects.toThrow(/No export/);
  });
});

describe('end to end', () => {
  it('produces a CSV that a spreadsheet reads correctly and safely', async () => {
    const hostile = [
      {
        organizationId: 'org_1',
        id: '1',
        name: "=cmd|' /C calc'!A0",
        joinedAt: new Date('2026-01-01'),
      },
      { organizationId: 'org_1', id: '2', name: 'Smith, Ada', joinedAt: new Date('2026-02-01') },
    ];

    const { service } = setup(sourceOver(hostile));
    const sink = new BufferSink();

    await service.run({
      type: 'test.people',
      format: 'csv',
      organizationId: 'org_1',
      sink,
      actorId: 'usr_1',
    });

    const lines = sink.content
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\n');

    expect(lines[0]).toBe('id,Full name,joinedAt');
    // Neutralised, and the comma-containing name is quoted rather than splitting the row.
    expect(lines[1]).toBe(`1,"'=cmd|' /C calc'!A0",2026-01-01`);
    expect(lines[2]).toBe('2,"Smith, Ada",2026-02-01');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ImportService, MAX_STORED_ERRORS, type ImportHandlerDefinition } from './import-service';
import { CsvParser, JsonParser, ParserRegistry, looksLikeFormula } from './parsers';
import { InMemoryImportStore } from './testing';

let clock = new Date('2026-07-01T10:00:00Z');
let counter = 0;

const rowSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  national_id: z.string().optional(),
});

function makeHandler(overrides: Partial<ImportHandlerDefinition> = {}): ImportHandlerDefinition {
  const applied: unknown[] = [];

  return {
    type: 'test.people',
    description: 'Imports people.',
    row: rowSchema,
    sensitiveColumns: ['national_id'],
    apply: async ({ rows }) => {
      applied.push(...rows);
      return { applied: rows.length, summary: { ids: rows.map((row) => row.rowNumber) } };
    },
    ...overrides,
  } as ImportHandlerDefinition;
}

function setup(handler = makeHandler()) {
  const store = new InMemoryImportStore();
  const audit = { record: vi.fn() };

  const service = new ImportService({
    store,
    parsers: new ParserRegistry(),
    handlers: [handler],
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { service, store, audit };
}

const csv = (text: string) => Buffer.from(text, 'utf8');

const goodCsv = csv('email,name\nada@example.com,Ada\ngrace@example.com,Grace\n');

beforeEach(() => {
  clock = new Date('2026-07-01T10:00:00Z');
  counter = 0;
});

describe('the CSV parser', () => {
  const parse = (text: string) =>
    new CsvParser().parse(csv(text), {
      maxRows: 1000,
      maxColumns: 100,
      maxCellLength: 1000,
      maxBytes: 1_000_000,
    });

  it('reads a header and rows', async () => {
    const result = await parse('email,name\na@b.com,Ada\n');

    expect(result.columns).toEqual(['email', 'name']);
    expect(result.rows[0]?.values).toEqual({ email: 'a@b.com', name: 'Ada' });
  });

  it('handles a comma inside a quoted field', async () => {
    // The failure this prevents: a naive split shifts every column after the comma, and the row
    // then imports as valid data in the wrong fields.
    const result = await parse('name,note\n"Smith, Ada","a, b, c"\n');

    expect(result.rows[0]?.values).toEqual({ name: 'Smith, Ada', note: 'a, b, c' });
  });

  it('handles an escaped quote', async () => {
    const result = await parse('name\n"She said ""hello"""\n');

    expect(result.rows[0]?.values.name).toBe('She said "hello"');
  });

  it('handles a newline inside a quoted field', async () => {
    const result = await parse('name,note\n"Ada","line one\nline two"\n');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.values.note).toBe('line one\nline two');
  });

  it('treats CRLF as one break, not two', async () => {
    // Otherwise every file written on Windows gets a blank record between every real one.
    const result = await parse('email,name\r\na@b.com,Ada\r\nb@c.com,Bob\r\n');

    expect(result.rows).toHaveLength(2);
  });

  it('strips the byte-order mark Excel writes', async () => {
    // Left in place it becomes part of the first column's name, so a header `email` silently
    // becomes `\uFEFFemail` and every row is missing its required field.
    const result = await new CsvParser().parse(
      Buffer.from('\uFEFFemail,name\na@b.com,Ada\n', 'utf8'),
      { maxRows: 10, maxColumns: 10, maxCellLength: 100, maxBytes: 10_000 },
    );

    expect(result.columns).toEqual(['email', 'name']);
  });

  it('normalizes column names, so " Email " and "email" are the same column', async () => {
    const result = await parse(' Email , Full Name \na@b.com,Ada\n');

    expect(result.columns).toEqual(['email', 'full_name']);
  });

  it('reports a row with the wrong number of values rather than guessing', async () => {
    // Padding would import empty strings as data; truncating would discard a value. Both
    // silently.
    const result = await parse('email,name\na@b.com\n');

    expect(result.rows).toHaveLength(0);
    expect(result.malformed[0]?.reason).toMatch(/Expected 2 values and found 1/);
  });

  it('skips a trailing blank line without reporting it', async () => {
    const result = await parse('email,name\na@b.com,Ada\n\n');

    expect(result.rows).toHaveLength(1);
    expect(result.malformed).toEqual([]);
  });

  it('refuses duplicate columns rather than silently keeping one', async () => {
    await expect(parse('email,email\na,b\n')).rejects.toThrow(/duplicate columns/i);
  });

  it('flags a cell a spreadsheet would treat as a formula', async () => {
    const result = await parse('name\n"=SUM(A1:A9)"\n');

    // Not an error — a legitimate value can start with `-` or `+`. Flagged so the validator can
    // decide and the export side knows to escape it.
    expect(result.rows[0]?.formulaCells).toEqual(['name']);
    expect(result.rows[0]?.values.name).toBe('=SUM(A1:A9)');
  });

  it.each(['=cmd', '+1', '-1', '@SUM'])('recognises %j as formula-shaped', (value) => {
    expect(looksLikeFormula(value)).toBe(true);
  });

  it('truncates beyond the row limit and says so', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => `a${index}@b.com,Name`).join('\n');
    const result = await new CsvParser().parse(csv(`email,name\n${rows}\n`), {
      maxRows: 10,
      maxColumns: 10,
      maxCellLength: 100,
      maxBytes: 100_000,
    });

    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it('refuses a file over the byte limit', async () => {
    await expect(
      new CsvParser().parse(csv('email\na@b.com\n'), {
        maxRows: 10,
        maxColumns: 10,
        maxCellLength: 100,
        maxBytes: 5,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it('rejects a cell over the length limit rather than storing it', async () => {
    const result = await new CsvParser().parse(csv(`name\n${'x'.repeat(50)}\n`), {
      maxRows: 10,
      maxColumns: 10,
      maxCellLength: 10,
      maxBytes: 10_000,
    });

    expect(result.rows).toHaveLength(0);
    expect(result.malformed[0]?.reason).toMatch(/longer than the 10-character limit/);
  });

  it('refuses an empty file', async () => {
    await expect(parse('')).rejects.toThrow(/no rows/i);
  });
});

describe('the JSON parser', () => {
  const parse = (text: string) =>
    new JsonParser().parse(csv(text), {
      maxRows: 1000,
      maxColumns: 100,
      maxCellLength: 1000,
      maxBytes: 1_000_000,
    });

  it('reads a bare array', async () => {
    const result = await parse('[{"email":"a@b.com","name":"Ada"}]');

    expect(result.rows[0]?.values).toEqual({ email: 'a@b.com', name: 'Ada' });
  });

  it('reads an items wrapper, because that is what an API returns', async () => {
    const result = await parse('{"items":[{"email":"a@b.com"}]}');

    expect(result.rows).toHaveLength(1);
  });

  it('stringifies values so the row shape matches CSV’s', async () => {
    // One validator then handles both formats rather than two that drift apart.
    const result = await parse('[{"count":42,"active":true,"missing":null}]');

    expect(result.rows[0]?.values).toEqual({ count: '42', active: 'true', missing: '' });
  });

  it('skips a reserved key rather than carrying it into a row object', async () => {
    const result = await parse('[{"__proto__":{"polluted":true},"email":"a@b.com"}]');

    expect(Object.keys(result.rows[0]!.values)).toEqual(['email']);
  });

  it('reports a non-object entry', async () => {
    const result = await parse('[{"email":"a@b.com"}, "not an object"]');

    expect(result.rows).toHaveLength(1);
    expect(result.malformed[0]?.reason).toMatch(/Expected an object/);
  });

  it('refuses malformed JSON with the parser’s own message', async () => {
    await expect(parse('{ not json')).rejects.toThrow(/could not be parsed/i);
  });

  it('refuses a shape it does not understand', async () => {
    await expect(parse('{"data":{}}')).rejects.toThrow(/not in a shape/i);
  });
});

describe('the parser registry', () => {
  it('names what is available, and that Excel is a port', () => {
    const registry = new ParserRegistry();

    expect(registry.formats()).toEqual(['csv', 'json']);
    expect(() => registry.get('xlsx')).toThrow();
  });
});

describe('preview', () => {
  it('validates every row without writing anything', async () => {
    const applyFn = vi.fn();
    const { service } = setup(makeHandler({ apply: applyFn }));

    const { run } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    expect(run.status).toBe('previewed');
    expect(run.rowsAccepted).toBe(2);
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('reports which rows would be rejected and why', async () => {
    const { service } = setup();

    const { run } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: csv('email,name\nnot-an-email,Ada\n'),
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    expect(run.rowsRejected).toBe(1);
    expect(run.errors[0]).toMatchObject({ rowNumber: 2, column: 'email' });
  });

  it('flags a column the handler does not use, which is how a typo surfaces', async () => {
    const { service } = setup();

    const { unknownColumns } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: csv('email,name,emial\na@b.com,Ada,x\n'),
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    // `emial` in this list is the whole explanation for why every row is missing its email.
    expect(unknownColumns).toEqual(['emial']);
  });

  it('returns a sample of the valid rows', async () => {
    const { service } = setup();

    const { sample } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
      sampleSize: 1,
    });

    expect(sample).toHaveLength(1);
    expect(sample[0]?.data).toMatchObject({ email: 'ada@example.com' });
  });
});

describe('apply', () => {
  it('imports every valid row', async () => {
    const { service } = setup();

    const run = await service.apply({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    expect(run.status).toBe('completed');
    expect(run.rowsAccepted).toBe(2);
  });

  it('imports nothing when any row is invalid', async () => {
    const applyFn = vi.fn();
    const { service } = setup(makeHandler({ apply: applyFn }));

    // An import that wrote 4,000 rows and stopped leaves a state nobody can describe afterwards.
    await expect(
      service.apply({
        type: 'test.people',
        format: 'csv',
        fileName: 'people.csv',
        content: csv('email,name\nada@example.com,Ada\nbad,Bob\n'),
        organizationId: 'org_1',
        actorId: 'usr_1',
      }),
    ).rejects.toThrow(/nothing was imported/);

    expect(applyFn).not.toHaveBeenCalled();
  });

  it('imports the valid rows when partial is asked for explicitly', async () => {
    const { service } = setup();

    const run = await service.apply({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: csv('email,name\nada@example.com,Ada\nbad,Bob\n'),
      organizationId: 'org_1',
      actorId: 'usr_1',
      partial: true,
    });

    expect(run.status).toBe('completed');
    expect(run.rowsAccepted).toBe(1);
    expect(run.rowsRejected).toBe(1);
  });

  it('records an audit entry with the counts', async () => {
    const { service, audit } = setup();

    await service.apply({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'import.completed',
        after: expect.objectContaining({ rowsAccepted: 2, rowsRejected: 0 }),
      }),
    );
  });

  it('marks the run failed when the handler throws', async () => {
    const { service, store } = setup(
      makeHandler({
        apply: async () => {
          throw new Error('the database refused');
        },
      }),
    );

    await expect(
      service.apply({
        type: 'test.people',
        format: 'csv',
        fileName: 'people.csv',
        content: goodCsv,
        organizationId: 'org_1',
        actorId: 'usr_1',
      }),
    ).rejects.toThrow(/the database refused/);

    const [run] = [...store.runs.values()];
    expect(run?.status).toBe('failed');
    expect(run?.errors.at(-1)?.message).toMatch(/the database refused/);
  });

  it('records a checksum, so a re-upload of the same file is recognisable', async () => {
    const { service, store } = setup();

    await service.apply({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    const [run] = [...store.runs.values()];
    expect(run?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rollback', () => {
  it('undoes an applied import', async () => {
    const rollback = vi.fn(async () => ({ reverted: 2 }));
    const { service } = setup(makeHandler({ rollback }));

    const run = await service.apply({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    const result = await service.rollback(run.id, 'org_1', 'usr_1');

    expect(result.reverted).toBe(2);
    // The summary the handler returned is what the rollback works from.
    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ summary: { ids: [2, 3] } }));
  });

  it('says plainly when a handler does not support rollback', async () => {
    const { service } = setup();

    const run = await service.apply({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    // Reporting a success that did nothing is the worst outcome for an operator undoing a mistake.
    await expect(service.rollback(run.id, 'org_1', 'usr_1')).rejects.toThrow(
      /cannot be rolled back/,
    );
  });

  it('refuses to roll back a preview', async () => {
    const { service } = setup(makeHandler({ rollback: async () => ({ reverted: 0 }) }));

    const { run } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    await expect(service.rollback(run.id, 'org_1', 'usr_1')).rejects.toThrow(
      /Only a completed import/,
    );
  });
});

describe('error reporting', () => {
  it('never echoes a sensitive column’s value', async () => {
    const { service } = setup();

    const { run } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      // `national_id` is optional and a string, so it validates; `email` is what fails. The point
      // is that a report is read in more places than the file is.
      content: csv('email,name,national_id\nbad,Ada,010203040\n'),
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    expect(JSON.stringify(run.errors)).not.toContain('010203040');
  });

  it('caps stored errors but keeps the count exact', async () => {
    const { service } = setup();
    const rows = Array.from({ length: 700 }, () => 'bad,Name').join('\n');

    const { run } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: csv(`email,name\n${rows}\n`),
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    // An operator reading "500 errors" must be able to tell 500 from 50,000.
    expect(run.errors).toHaveLength(MAX_STORED_ERRORS);
    expect(run.rowsRejected).toBe(700);
  });

  it('escapes a formula in the CSV error report', async () => {
    const { service } = setup();

    const { run } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: csv('email,name\n"=cmd|\' /C calc\'!A0",Ada\n'),
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    const report = service.buildErrorReport(run);

    // An error report is the one file guaranteed to be opened in a spreadsheet.
    expect(report).toContain(`"'=cmd`);
    expect(report).not.toMatch(/,=cmd/);
  });

  it('says how many errors were omitted', async () => {
    const { service } = setup();
    const rows = Array.from({ length: 700 }, () => 'bad,Name').join('\n');

    const { run } = await service.preview({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: csv(`email,name\n${rows}\n`),
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    expect(service.buildErrorReport(run)).toMatch(/further errors are not listed/);
  });
});

describe('handler registration', () => {
  it('refuses two handlers for one type', () => {
    const { service } = setup();

    expect(() => service.register(makeHandler())).toThrow(/already registered/);
  });

  it('lists what is registered when asked for an unknown type', async () => {
    const { service } = setup();

    await expect(
      service.preview({
        type: 'test.missing',
        format: 'csv',
        fileName: 'x.csv',
        content: goodCsv,
        organizationId: 'org_1',
        actorId: 'usr_1',
      }),
    ).rejects.toThrow(/Unknown import type/);
  });
});

describe('tenant isolation', () => {
  it('does not return another organization’s run', async () => {
    const { service } = setup();

    const run = await service.apply({
      type: 'test.people',
      format: 'csv',
      fileName: 'people.csv',
      content: goodCsv,
      organizationId: 'org_1',
      actorId: 'usr_1',
    });

    await expect(service.get(run.id, 'org_2')).rejects.toThrow(/No import/);
  });
});

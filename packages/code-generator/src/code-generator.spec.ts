import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import { describeGeneration, generateSlice, parseSlice, sliceSchema } from './index';

/** `toThrow(/…/)` sees only the summary; the useful text is in the details. */
function detailsOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (error) {
    if (error instanceof ApiError) return (error.details ?? []).map((d) => d.message).join(' | ');
    return error instanceof Error ? error.message : String(error);
  }
}

const SLICE = {
  entity: 'Invoice',
  plural: 'invoices',
  label: 'Invoices',
  singular: 'Invoice',
  description: 'A bill issued to a customer.',
  namespace: 'billing',
  packageName: 'acme',
  fields: [
    {
      name: 'number',
      label: 'Number',
      type: 'text' as const,
      required: true,
      unique: true,
      immutable: true,
    },
    { name: 'total', label: 'Total', type: 'money' as const, required: true },
    { name: 'customerEmail', label: 'Email', type: 'email' as const, pii: true },
    {
      name: 'status',
      label: 'Status',
      type: 'enum' as const,
      values: ['DRAFT', 'ISSUED', 'PAID'],
      default: 'DRAFT',
    },
  ],
};

const content = (files: ReturnType<typeof generateSlice>, kind: string): string =>
  files.find((file) => file.kind === kind)?.content ?? '';

describe('the declaration', () => {
  it('refuses an enum with no values', () => {
    // Validating against nothing accepts everything.
    expect(() =>
      parseSlice({ ...SLICE, fields: [{ name: 'a', label: 'A', type: 'enum', required: true }] }),
    ).toThrow();
  });

  it('refuses a field that shadows a generated one', () => {
    for (const name of ['id', 'organizationId', 'createdAt', 'deletedAt']) {
      expect(() =>
        parseSlice({ ...SLICE, fields: [{ name, label: 'X', type: 'text', required: true }] }),
      ).toThrow();
    }
  });

  it('refuses an entity where nothing is required', () => {
    // An empty POST would create a row. Not always wrong, but a decision rather than an oversight.
    expect(() =>
      parseSlice({ ...SLICE, fields: [{ name: 'note', label: 'Note', type: 'text' }] }),
    ).toThrow();
  });

  it('refuses a duplicate field name', () => {
    expect(() =>
      parseSlice({
        ...SLICE,
        fields: [
          { name: 'a', label: 'A', type: 'text', required: true },
          { name: 'a', label: 'A again', type: 'text' },
        ],
      }),
    ).toThrow();
  });

  it('refuses a delete on an entity holding sensitive data', () => {
    /*
     * Generated deletes are soft, so the sensitive data would remain in the table. Erasure needs
     * to be handled explicitly rather than implied by a "delete".
     */
    expect(
      detailsOf(() =>
        generateSlice(
          sliceSchema.parse({
            ...SLICE,
            operations: ['list', 'delete'],
            fields: [{ name: 'ssn', label: 'SSN', type: 'text', required: true, sensitive: true }],
          }),
        ),
      ),
    ).toMatch(/handle erasure explicitly/);
  });
});

describe('the generated schema', () => {
  const files = generateSlice(parseSlice(SLICE));

  it('scopes every entity to an organization, with no way to opt out', () => {
    /*
     * A generator that could emit an unscoped repository would eventually emit one, and the
     * endpoint returns every tenant's rows while passing every test written against a
     * single-tenant fixture.
     */
    expect(content(files, 'schema')).toMatch(/organizationId String/);
    expect(content(files, 'repository')).toMatch(/TenantRepository/);
  });

  it('scopes a unique constraint to the organization', () => {
    // Two tenants may legitimately use the same invoice number.
    expect(content(files, 'schema')).toMatch(/@@unique\(\[organizationId, number\]\)/);
  });

  it('makes money a Decimal, never a Float', () => {
    expect(content(files, 'schema')).toMatch(/total Decimal @db\.Decimal\(28, 8\)/);
    expect(content(files, 'schema')).not.toMatch(/Float/);
  });

  it('makes money a string in TypeScript', () => {
    expect(content(files, 'types')).toMatch(/total: string;/);
  });

  it('makes a defaulted field non-nullable', () => {
    // A column with three states — set, defaulted and null — where the domain has two.
    expect(content(files, 'schema')).toMatch(/status InvoiceStatus @default\(DRAFT\)/);
  });

  it('adds soft-delete columns', () => {
    expect(content(files, 'schema')).toMatch(/deletedAt DateTime\?/);
  });
});

describe('the generated code', () => {
  const files = generateSlice(parseSlice(SLICE));

  it('audits every write', () => {
    expect(content(files, 'service')).toMatch(/billing\.invoices\.created/);
    expect(content(files, 'service')).toMatch(/billing\.invoices\.updated/);
  });

  it('records only the changed fields on an update', () => {
    // Recording the whole row buries the one field that moved.
    expect(content(files, 'service')).toMatch(/pick\(before, Object\.keys\(changes\)\)/);
  });

  it('keeps personal data out of the audit projection', () => {
    expect(content(files, 'service')).not.toMatch(/customerEmail: created\.customerEmail/);
  });

  it('declares a permission on every route', () => {
    const controller = content(files, 'controller');

    expect(controller.match(/@RequirePermissions/g)).toHaveLength(4);
    expect(controller).toMatch(/billing\.invoices\.pii\.read/);
  });

  it('takes the organization from the tenant guard, never the request', () => {
    expect(content(files, 'controller')).toMatch(/@OrganizationId\(\) organizationId: string/);
  });

  it('leaves immutable fields out of the update type rather than ignoring them', () => {
    const types = content(files, 'types');
    const updateBlock = types.slice(types.indexOf('UpdateInvoiceInput'));

    expect(updateBlock).not.toMatch(/number\?/);
    expect(updateBlock).toMatch(/total\?/);
  });

  it('ships a tenant isolation test', () => {
    expect(content(files, 'test')).toMatch(/never returns another organization/);
  });

  it('documents the guarantees, including the PII permission', () => {
    const documentation = content(files, 'documentation');

    expect(documentation).toMatch(/Every query is scoped to the calling organization/);
    expect(documentation).toMatch(/billing\.invoices\.pii\.read/);
  });
});

describe('output', () => {
  it('writes nothing and returns the files', () => {
    // Which is what makes --dry-run the same code path as the real run.
    const files = generateSlice(parseSlice(SLICE));

    expect(files).toHaveLength(7);
    expect(describeGeneration(files)).toMatch(/7 file\(s\)/);
  });

  it('omits an operation the slice does not declare', () => {
    const files = generateSlice(parseSlice({ ...SLICE, operations: ['list', 'read'] }));

    expect(content(files, 'controller')).not.toMatch(/@Post\(\)/);
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import {
  allowAll,
  assertCan,
  assertContentMatches,
  assertFileCount,
  assertPageSize,
  assertUploadAllowed,
  auditAction,
  breadcrumbsFor,
  buildCursorPage,
  buildFormSchema,
  buildListQuery,
  buildListResponse,
  buildNotification,
  buildOffsetPage,
  buildUpdateSchema,
  cursorTake,
  dailyRange,
  defaultAlign,
  definePermission,
  defineCrudPermissions,
  denyAll,
  escapeLikePattern,
  fillSeriesGaps,
  filterNavigation,
  filterSections,
  findActiveItem,
  groupFields,
  interpretTrend,
  isEmpty,
  isPathActive,
  normalizeSearchTerm,
  notificationTemplateSchema,
  parseFilterQuery,
  parseFilters,
  permissionsFrom,
  pickColumns,
  redactSensitive,
  resolveChannels,
  resolveSort,
  safeFilename,
  sniffContentType,
  toPrismaWhere,
  toSearchWhere,
  toSeries,
  toSkipTake,
  tokenize,
  visibleColumns,
  visibleWidgets,
  type ChartSpec,
  type DashboardDefinition,
  type FilterDefinition,
  type FormDefinition,
  type NavigationItem,
  type ResourceDefinition,
  type TableDefinition,
  type UploadPolicy,
} from './index';

/**
 * The tests worth writing are the ones where the convenient behaviour is the wrong one.
 *
 * Filtering a menu after rendering, accepting a filter on an undeclared field, hiding a column in
 * CSS, believing a client's content type, interpolating a balance into an SMS. Each of those
 * produces an application that works, demos well, and is wrong.
 */

/** `toThrow(/…/)` sees only the summary; the useful text is in the details. */
function detailsOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (error) {
    if (error instanceof ApiError) {
      return (error.details ?? []).map((detail) => detail.message).join(' | ');
    }
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------------------------------------------------------------------------
// navigation

const NAV: NavigationItem[] = [
  { key: 'home', label: 'Home', href: '/', order: 0 },
  {
    key: 'money',
    label: 'Money',
    order: 1,
    children: [
      { key: 'orders', label: 'Orders', href: '/orders', permission: 'order.read' },
      { key: 'refunds', label: 'Refunds', href: '/orders/refunds', permission: 'refund.read' },
    ],
  },
  { key: 'settings', label: 'Settings', href: '/settings', permission: 'settings.read', order: 2 },
];

describe('navigation', () => {
  it('removes items the actor cannot reach', () => {
    const visible = filterNavigation(NAV, permissionsFrom(['order.read']));

    expect(visible.map((item) => item.key)).toEqual(['home', 'money']);
    expect(visible[1]?.children?.map((child) => child.key)).toEqual(['orders']);
  });

  it('drops a grouping node whose children all disappear', () => {
    /*
     * An empty menu heading is a dead end that reads as a bug. The group has no href of its own,
     * so with nothing under it there is nowhere to go.
     */
    const visible = filterNavigation(NAV, denyAll);

    expect(visible.map((item) => item.key)).toEqual(['home']);
  });

  it('takes a hidden parent’s children with it', () => {
    const items: NavigationItem[] = [
      {
        key: 'admin',
        label: 'Admin',
        permission: 'admin.read',
        children: [{ key: 'users', label: 'Users', href: '/users' }],
      },
    ];

    // The child allows everyone, and it is still gone: a child of a hidden parent is
    // unreachable, and listing it would be a lie.
    expect(filterNavigation(items, denyAll)).toEqual([]);
  });

  it('orders by weight, then by declaration', () => {
    const items: NavigationItem[] = [
      { key: 'c', label: 'C', href: '/c', order: 2 },
      { key: 'a', label: 'A', href: '/a', order: 1 },
      { key: 'b', label: 'B', href: '/b', order: 1 },
    ];

    expect(filterNavigation(items, allowAll).map((item) => item.key)).toEqual(['a', 'b', 'c']);
  });

  it('prefers the longest match when two routes are prefixes', () => {
    // First-match highlights "Orders" while the user is looking at refunds.
    expect(findActiveItem(NAV, '/orders/refunds')?.key).toBe('refunds');
    expect(findActiveItem(NAV, '/orders')?.key).toBe('orders');
  });

  it('does not treat /order as a prefix of /orders', () => {
    expect(isPathActive('/order', '/orders')).toBe(false);
    expect(isPathActive('/orders', '/orders/refunds')).toBe(true);
  });

  it('leaves the last breadcrumb unlinked', () => {
    const trail = breadcrumbsFor(NAV, '/orders/refunds');

    expect(trail.map((crumb) => crumb.label)).toEqual(['Money', 'Refunds']);
    expect(trail[trail.length - 1]?.href).toBeUndefined();
  });

  it('drops a section with nothing visible in it', () => {
    const sections = filterSections(
      [
        { key: 'ops', label: 'Operations', items: NAV },
        {
          key: 'sec',
          label: 'Security',
          items: [{ key: 'keys', label: 'Keys', href: '/keys', permission: 'key.read' }],
        },
      ],
      permissionsFrom(['order.read']),
    );

    expect(sections.map((section) => section.key)).toEqual(['ops']);
  });
});

// ---------------------------------------------------------------------------
// forms and validation

const FORM: FormDefinition = {
  key: 'customer',
  title: 'Customer',
  fields: [
    { name: 'code', label: 'Code', type: 'slug', required: true, immutable: true },
    { name: 'name', label: 'Name', type: 'text', required: true, max: 120, group: 'Identity' },
    { name: 'email', label: 'Email', type: 'email', group: 'Contact' },
    { name: 'phone', label: 'Phone', type: 'phone', group: 'Contact' },
    { name: 'creditLimit', label: 'Credit limit', type: 'money' },
    { name: 'nationalId', label: 'National ID', type: 'text', sensitive: true },
    {
      name: 'tier',
      label: 'Tier',
      type: 'select',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'premium', label: 'Premium' },
      ],
      defaultValue: 'standard',
    },
  ],
};

describe('forms', () => {
  it('derives a schema the endpoint can use directly', () => {
    const parsed = buildFormSchema(FORM).parse({
      code: 'acme-ltd',
      name: '  Acme Ltd  ',
      email: 'Ops@ACME.example',
      creditLimit: '15000.00',
    });

    expect(parsed).toMatchObject({
      code: 'acme-ltd',
      name: 'Acme Ltd',
      email: 'ops@acme.example',
      creditLimit: '15000.00',
      tier: 'standard',
    });
  });

  it('keeps money a string', () => {
    /*
     * Phase 8's rule reaching the form layer. 0.1 + 0.2 in a browser is 0.30000000000000004, and
     * a number that arrives already wrong cannot be validated back into being right.
     */
    expect(() =>
      buildFormSchema(FORM).parse({ code: 'a-b', name: 'A', creditLimit: 1e21 }),
    ).toThrow();
    expect(
      buildFormSchema(FORM).parse({ code: 'a-b', name: 'A', creditLimit: '0.30' }).creditLimit,
    ).toBe('0.30');
  });

  it('refuses a key the form does not declare', () => {
    // A renamed field where the client keeps sending the old name is a value that silently
    // stops being saved. `.strict()` turns that into an error.
    expect(() => buildFormSchema(FORM).parse({ code: 'a-b', name: 'A', emial: 'x@y.z' })).toThrow();
  });

  it('removes immutable fields from the update schema rather than ignoring them', () => {
    // Accepting-and-ignoring is worse than refusing: the caller believes it was applied.
    expect(() => buildUpdateSchema(FORM).parse({ code: 'new-code' })).toThrow();
    expect(buildUpdateSchema(FORM).parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('refuses a form with nothing editable', () => {
    expect(
      detailsOf(() =>
        buildUpdateSchema({
          key: 'frozen',
          title: 'Frozen',
          fields: [{ name: 'id', label: 'Id', type: 'text', immutable: true }],
        }),
      ),
    ).toMatch(/nothing to update/);
  });

  it('refuses a select with no options', () => {
    expect(
      detailsOf(() =>
        buildFormSchema({
          key: 'x',
          title: 'X',
          fields: [{ name: 'status', label: 'Status', type: 'select' }],
        }),
      ),
    ).toMatch(/validating against nothing accepts everything/);
  });

  it('accepts the phone numbers people actually type', () => {
    const schema = buildFormSchema(FORM);

    for (const phone of ['012 345 678', '+855 12 345 678', '(023) 987-654']) {
      expect(schema.parse({ code: 'a-b', name: 'A', phone }).phone).toBe(phone);
    }

    expect(() => schema.parse({ code: 'a-b', name: 'A', phone: 'call me' })).toThrow();
  });

  it('groups fields in declaration order', () => {
    expect(groupFields(FORM).map((group) => group.group)).toEqual(['', 'Identity', 'Contact']);
  });

  it('strips sensitive fields before a row leaves', () => {
    const redacted = redactSensitive(FORM, { name: 'Dara', nationalId: '01234567' });

    expect(redacted).toEqual({ name: 'Dara' });
  });
});

// ---------------------------------------------------------------------------
// tables

const TABLE: TableDefinition = {
  key: 'orders',
  label: 'Orders',
  endpoint: '/orders',
  defaultSort: { key: 'createdAt', direction: 'desc' },
  columns: [
    { key: 'reference', label: 'Reference', sortable: true },
    { key: 'total', label: 'Total', format: 'money', currencyKey: 'currency', sortable: true },
    { key: 'margin', label: 'Margin', format: 'money', permission: 'order.margin.read' },
    { key: 'createdAt', label: 'Placed', format: 'datetime', sortable: true },
  ],
};

describe('tables', () => {
  it('right-aligns money and numbers without being told', () => {
    expect(defaultAlign(TABLE.columns[1] as never)).toBe('right');
    expect(defaultAlign(TABLE.columns[0] as never)).toBe('left');
  });

  it('removes a column the actor may not see', () => {
    expect(visibleColumns(TABLE, denyAll).map((column) => column.key)).toEqual([
      'reference',
      'total',
      'createdAt',
    ]);
  });

  it('projects the row so the hidden column is absent from the payload, not just the screen', () => {
    const row = { reference: 'ORD-1', total: '100.00', margin: '12.00', createdAt: new Date() };

    expect(pickColumns(row, visibleColumns(TABLE, denyAll))).not.toHaveProperty('margin');
    expect(pickColumns(row, visibleColumns(TABLE, allowAll))).toHaveProperty('margin');
  });

  it('falls back to the default sort rather than trusting the caller', () => {
    // A sort key passed straight through is a caller-supplied string reaching the query builder.
    expect(resolveSort(TABLE, { key: 'passwordHash', direction: 'asc' })).toEqual({
      key: 'createdAt',
      direction: 'desc',
    });
    expect(resolveSort(TABLE, { key: 'margin', direction: 'asc' }).key).toBe('createdAt');
    expect(resolveSort(TABLE, { key: 'total', direction: 'asc' })).toEqual({
      key: 'total',
      direction: 'asc',
    });
  });
});

// ---------------------------------------------------------------------------
// pagination

describe('pagination', () => {
  it('computes an offset page', () => {
    const page = buildOffsetPage([1, 2, 3], 47, { page: 2, pageSize: 3 });

    expect(page).toMatchObject({ totalPages: 16, hasNext: true, hasPrevious: true });
    expect(toSkipTake({ page: 2, pageSize: 3 })).toEqual({ skip: 3, take: 3 });
  });

  it('returns an empty page rather than throwing past the end', () => {
    // A bookmark to page 9 of a list that shrank to 3 is not an error the user can act on.
    const page = buildOffsetPage([], 5, { page: 9, pageSize: 10 });

    expect(page.rows).toEqual([]);
    expect(page.hasPrevious).toBe(true);
    expect(page.hasNext).toBe(false);
  });

  it('answers hasNext from one extra row instead of a count query', () => {
    const fetched = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    expect(cursorTake({ limit: 2 })).toBe(3);
    expect(buildCursorPage(fetched, { limit: 2 })).toEqual({
      rows: [{ id: 'a' }, { id: 'b' }],
      nextCursor: 'b',
      hasNext: true,
    });
  });

  it('ends a cursor walk with a null cursor', () => {
    expect(buildCursorPage([{ id: 'a' }], { limit: 5 })).toEqual({
      rows: [{ id: 'a' }],
      nextCursor: null,
      hasNext: false,
    });
  });

  it('refuses an oversized page rather than clamping it', () => {
    // A silently clamped response looks like a short page and gets retried forever.
    expect(detailsOf(() => assertPageSize(10_000))).toMatch(/between 1 and 200/);
  });
});

// ---------------------------------------------------------------------------
// filters

const FILTERS: FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    type: 'enum',
    operators: ['eq', 'in'],
    options: [
      { value: 'ACTIVE', label: 'Active' },
      { value: 'CLOSED', label: 'Closed' },
    ],
  },
  { key: 'total', label: 'Total', type: 'number', operators: ['gte', 'between'] },
  { key: 'name', label: 'Name', type: 'string', operators: ['contains'] },
  {
    key: 'margin',
    label: 'Margin',
    type: 'number',
    operators: ['gte'],
    permission: 'order.margin.read',
  },
];

describe('filters', () => {
  it('refuses a field the resource did not declare', () => {
    // The naive implementation spreads the query string into a Prisma `where`.
    expect(
      detailsOf(() => parseFilters(FILTERS, [{ key: 'passwordHash', operator: 'eq', value: 'x' }])),
    ).toMatch(/not a filterable field/);
  });

  it('refuses an operator the field does not allow', () => {
    expect(
      detailsOf(() => parseFilters(FILTERS, [{ key: 'name', operator: 'in', value: ['a'] }])),
    ).toMatch(/is not allowed on "name"/);
  });

  it('gives an unauthorized filter the same answer as a nonexistent one', () => {
    /*
     * "You may not filter by margin" confirms that margin exists. The two messages are identical
     * on purpose.
     */
    const denied = detailsOf(() =>
      parseFilters(FILTERS, [{ key: 'margin', operator: 'gte', value: 1 }], denyAll),
    );
    const missing = detailsOf(() =>
      parseFilters(FILTERS, [{ key: 'nope', operator: 'eq', value: 1 }], denyAll),
    );

    expect(denied).toMatch(/not a filterable field/);
    expect(missing).toMatch(/not a filterable field/);
  });

  it('refuses a value outside an enum', () => {
    expect(
      detailsOf(() => parseFilters(FILTERS, [{ key: 'status', operator: 'eq', value: 'DELETED' }])),
    ).toMatch(/Expected one of: ACTIVE, CLOSED/);
  });

  it('refuses a reversed range rather than swapping it', () => {
    // A reversed range is two bound variables crossed upstream; correcting it hides the bug.
    expect(
      detailsOf(() =>
        parseFilters(FILTERS, [{ key: 'total', operator: 'between', value: [90, 10] }]),
      ),
    ).toMatch(/at or before/);
  });

  it('bounds an in-list and a search term', () => {
    const many = Array.from({ length: 60 }, () => 'ACTIVE');

    expect(
      detailsOf(() => parseFilters(FILTERS, [{ key: 'status', operator: 'in', value: many }])),
    ).toMatch(/between 1 and 50 values/);
    expect(
      detailsOf(() =>
        parseFilters(FILTERS, [{ key: 'name', operator: 'contains', value: 'x'.repeat(500) }]),
      ),
    ).toMatch(/at most 200 characters/);
  });

  it('translates validated filters into a where fragment', () => {
    const parsed = parseFilters(FILTERS, [
      { key: 'status', operator: 'in', value: ['ACTIVE', 'CLOSED'] },
      { key: 'total', operator: 'between', value: [10, 90] },
      { key: 'name', operator: 'contains', value: 'acme' },
    ]);

    expect(toPrismaWhere(parsed)).toEqual({
      status: { in: ['ACTIVE', 'CLOSED'] },
      total: { gte: 10, lte: 90 },
      name: { contains: 'acme', mode: 'insensitive' },
    });
  });

  it('parses the query-string encoding', () => {
    expect(
      parseFilterQuery({
        'filter[status]': 'eq:ACTIVE',
        'filter[total]': 'between:10,90',
        'filter[name]': 'acme',
        page: '2',
      }),
    ).toEqual([
      { key: 'status', operator: 'eq', value: 'ACTIVE' },
      { key: 'total', operator: 'between', value: ['10', '90'] },
      { key: 'name', operator: 'eq', value: 'acme' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// search

describe('search', () => {
  const definition = {
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'reference', label: 'Reference', prefixOnly: true },
      { key: 'nationalId', label: 'National ID', permission: 'customer.pii.read' },
    ],
  };

  it('requires every token to match somewhere', () => {
    /*
     * AND of ORs. The other way round needs every token in the same field, so a name in one
     * column and a city in another never match together.
     */
    const where = toSearchWhere(definition, 'dara phnom', allowAll) as {
      AND: Array<{ OR: unknown[] }>;
    };

    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]?.OR).toHaveLength(3);
  });

  it('omits a field the actor may not search', () => {
    const where = toSearchWhere(definition, 'dara', denyAll) as { AND: Array<{ OR: unknown[] }> };

    expect(where.AND[0]?.OR).toHaveLength(2);
  });

  it('uses startsWith for a reference column', () => {
    const where = toSearchWhere(
      { fields: [{ key: 'reference', label: 'Ref', prefixOnly: true }] },
      'ORD',
    ) as {
      AND: Array<{ OR: Array<Record<string, unknown>> }>;
    };

    expect(where.AND[0]?.OR[0]).toEqual({ reference: { startsWith: 'ORD', mode: 'insensitive' } });
  });

  it('filters nothing for a cleared box', () => {
    // A cleared search should show the whole list back, not an empty one.
    expect(toSearchWhere(definition, normalizeSearchTerm(''))).toEqual({});
    expect(toSearchWhere(definition, normalizeSearchTerm('a'))).toEqual({});
  });

  it('bounds the term and the token count', () => {
    expect(detailsOf(() => normalizeSearchTerm('x'.repeat(500)))).toMatch(/limited to 100/);
    expect(tokenize('aa bb cc dd ee ff gg hh')).toEqual(['aa', 'bb', 'cc', 'dd', 'ee', 'ff']);
  });

  it('drops a single-character token rather than matching most of the table with it', () => {
    expect(tokenize('a dara')).toEqual(['dara']);
  });

  it('escapes LIKE metacharacters for the raw-query path', () => {
    // Without it, searching for `100%` matches every row.
    expect(escapeLikePattern('100%_x')).toBe('100\\%\\_x');
  });
});

// ---------------------------------------------------------------------------
// dashboards and charts

describe('dashboards', () => {
  const dashboard: DashboardDefinition = {
    key: 'overview',
    title: 'Overview',
    widgets: [
      { key: 'revenue', title: 'Revenue', kind: 'metric', permission: 'report.revenue.read' },
      { key: 'orders', title: 'Orders', kind: 'metric' },
      { key: 'trend', title: 'Trend', kind: 'chart' },
    ],
  };

  it('filters widgets so a hidden number is never computed', () => {
    expect(visibleWidgets(dashboard, denyAll).map((widget) => widget.key)).toEqual([
      'orders',
      'trend',
    ]);
  });

  it('reads a rise in failed logins as bad and a rise in revenue as good', () => {
    /*
     * A dashboard that paints every increase green trains people to read rising fraud as
     * success.
     */
    expect(interpretTrend({ key: 'r', label: 'Revenue', value: '1', direction: 'up' })).toBe(
      'positive',
    );
    expect(
      interpretTrend({
        key: 'f',
        label: 'Failed logins',
        value: '1',
        direction: 'up',
        higherIsBetter: false,
      }),
    ).toBe('negative');
  });
});

describe('charts', () => {
  const spec: ChartSpec = {
    key: 'daily',
    title: 'Daily revenue',
    kind: 'line',
    fillGaps: true,
    series: [
      {
        key: 'revenue',
        label: 'Revenue',
        points: [
          { x: '2026-03-01', y: 100 },
          { x: '2026-03-03', y: 300 },
        ],
      },
    ],
  };

  it('fills a declared gap with zero', () => {
    const filled = fillSeriesGaps(spec, dailyRange(new Date('2026-03-01'), new Date('2026-03-03')));

    expect(filled.series[0]?.points).toEqual([
      { x: '2026-03-01', y: 100 },
      { x: '2026-03-02', y: 0 },
      { x: '2026-03-03', y: 300 },
    ]);
  });

  it('leaves gaps alone when the chart does not claim zero means nothing happened', () => {
    // "We sold nothing" and "we have no data" are different statements.
    const unfilled = fillSeriesGaps({ ...spec, fillGaps: false }, ['2026-03-01', '2026-03-02']);

    expect(unfilled.series[0]?.points).toHaveLength(2);
  });

  it('reports an empty chart', () => {
    expect(isEmpty({ ...spec, series: [{ key: 'a', label: 'A', points: [] }] })).toBe(true);
  });

  it('aggregates rows into a sorted series', () => {
    const series = toSeries(
      [
        { day: '2026-03-02', amount: 5 },
        { day: '2026-03-01', amount: 10 },
        { day: '2026-03-01', amount: 2 },
      ],
      { key: 'sales', label: 'Sales', x: (row) => row.day, y: (row) => row.amount },
    );

    expect(series.points).toEqual([
      { x: '2026-03-01', y: 12 },
      { x: '2026-03-02', y: 5 },
    ]);
  });

  it('bounds a runaway date range', () => {
    expect(dailyRange(new Date('2020-01-01'), new Date('2099-01-01')).length).toBeLessThanOrEqual(
      1200,
    );
  });
});

// ---------------------------------------------------------------------------
// uploads

describe('uploads', () => {
  const policy: UploadPolicy = {
    key: 'avatar',
    label: 'profile photo',
    accept: ['image/png', 'image/jpeg'],
    maxBytes: 1024,
    maxFiles: 1,
  };

  it('refuses a type outside the policy', () => {
    expect(
      detailsOf(() =>
        assertUploadAllowed(policy, {
          filename: 'x.svg',
          contentType: 'image/svg+xml',
          sizeBytes: 10,
        }),
      ),
    ).toMatch(/is not accepted here/);
  });

  it('refuses an empty file and an oversized one', () => {
    expect(
      detailsOf(() =>
        assertUploadAllowed(policy, { filename: 'a.png', contentType: 'image/png', sizeBytes: 0 }),
      ),
    ).toMatch(/empty file/);
    expect(
      detailsOf(() =>
        assertUploadAllowed(policy, {
          filename: 'a.png',
          contentType: 'image/png',
          sizeBytes: 99_999,
        }),
      ),
    ).toMatch(/the limit for profile photo is 1.0 KB/);
  });

  it('bounds the file count', () => {
    expect(detailsOf(() => assertFileCount(policy, 4))).toMatch(/Between 1 and 1 file/);
  });

  it('neutralizes a traversing filename', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..')).toBe('file');
    expect(safeFilename('a b c.png')).toBe('a_bc.png');
    expect(safeFilename('x'.repeat(500))).toHaveLength(120);
  });

  it('believes the bytes rather than the client', () => {
    /*
     * An HTML file named photo.jpg, served back from the same origin, is stored XSS. The
     * declared type is a claim.
     */
    const html = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    expect(sniffContentType(png)).toBe('image/png');
    expect(sniffContentType(html)).toBeNull();

    expect(
      detailsOf(() =>
        assertContentMatches({ filename: 'a.png', contentType: 'image/png', sizeBytes: 6 }, html),
      ),
    ).toMatch(/not a recognized format/);

    expect(() =>
      assertContentMatches({ filename: 'a.png', contentType: 'image/png', sizeBytes: 9 }, png),
    ).not.toThrow();
  });

  it('does not accept a bare RIFF container as WEBP', () => {
    const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);

    expect(sniffContentType(riff)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// notifications

describe('notifications', () => {
  const template = notificationTemplateSchema.parse({
    key: 'order.shipped',
    description: 'Sent when an order leaves the warehouse.',
    channels: ['inApp', 'email'],
    subject: 'Order {reference} is on its way',
    body: 'Hello {name}, order {reference} has shipped.',
    variables: ['reference', 'name'],
  });

  it('refuses a body carrying a secret or a balance', () => {
    /*
     * The body reaches logs, queues and the delivery provider's dashboard. That is four copies of
     * an OTP.
     */
    for (const body of ['Your OTP is {otp}.', 'Your balance is {balance}.']) {
      expect(() =>
        notificationTemplateSchema.parse({
          key: 'a.b',
          description: 'x',
          channels: ['sms'],
          subject: 'Hi',
          body,
          variables: ['otp', 'balance'],
        }),
      ).toThrow();
    }
  });

  it('refuses a placeholder nothing checks and a variable nothing uses', () => {
    const undeclared = () =>
      notificationTemplateSchema.parse({
        key: 'a.b',
        description: 'x',
        channels: ['email'],
        subject: 'Hi {name}',
        body: 'Body',
        variables: [],
      });

    const unused = () =>
      notificationTemplateSchema.parse({
        key: 'a.b',
        description: 'x',
        channels: ['email'],
        subject: 'Hi',
        body: 'Body',
        variables: ['name'],
      });

    expect(undeclared).toThrow();
    expect(unused).toThrow();
  });

  it('substitutes values', () => {
    expect(buildNotification(template, { reference: 'ORD-9', name: 'Dara' })).toMatchObject({
      subject: 'Order ORD-9 is on its way',
      body: 'Hello Dara, order ORD-9 has shipped.',
    });
  });

  it('throws rather than delivering a literal placeholder', () => {
    expect(detailsOf(() => buildNotification(template, { reference: 'ORD-9' }))).toMatch(
      /missing value\(s\) for: name/,
    );
  });

  it('ignores a mute on a notification that may not be silenced', () => {
    // A product where a password change can be muted is one where an attacker mutes it first.
    const security = notificationTemplateSchema.parse({
      key: 'security.password.changed',
      description: 'Sent when a password changes.',
      channels: ['email', 'push'],
      subject: 'Your password changed',
      body: 'Your password for {product} was changed.',
      variables: ['product'],
      optional: false,
    });

    expect(resolveChannels(security, ['email', 'push'])).toEqual(['email', 'push']);
    expect(resolveChannels(template, ['email'])).toEqual(['inApp']);
  });
});

// ---------------------------------------------------------------------------
// crud

const RESOURCE: ResourceDefinition = {
  key: 'orders',
  label: 'Orders',
  singular: 'Order',
  endpoint: '/orders',
  table: TABLE,
  filters: FILTERS,
  search: { fields: [{ key: 'reference', label: 'Reference', prefixOnly: true }] },
  permissions: {
    list: 'order.read',
    read: 'order.read',
    create: 'order.create',
    update: 'order.update',
  },
};

describe('crud', () => {
  it('assembles a query out of nothing the caller invented', () => {
    const query = buildListQuery(
      RESOURCE,
      {
        page: { page: 2, pageSize: 10 },
        sort: { key: 'total', direction: 'asc' },
        filters: [{ key: 'status', operator: 'eq', value: 'ACTIVE' }],
        search: 'ORD-9',
      },
      { can: allowAll, scope: { organizationId: 'org_a' } },
    );

    expect(query).toMatchObject({ orderBy: { total: 'asc' }, skip: 10, take: 10 });
    expect(query.where).toMatchObject({ status: 'ACTIVE', organizationId: 'org_a' });
  });

  it('applies the tenant scope last so a filter cannot displace it', () => {
    /*
     * The quietest failure available: a caller filtering the scope field and getting somebody
     * else's rows.
     */
    const query = buildListQuery(
      {
        ...RESOURCE,
        filters: [{ key: 'organizationId', label: 'Org', type: 'string', operators: ['eq'] }],
      },
      { filters: [{ key: 'organizationId', operator: 'eq', value: 'org_b' }] },
      { can: allowAll, scope: { organizationId: 'org_a' } },
    );

    expect(query.where.organizationId).toBe('org_a');
  });

  it('projects the response through the columns the actor may see', () => {
    const page = buildListResponse(
      RESOURCE,
      [{ reference: 'ORD-1', total: '10.00', margin: '2.00', createdAt: new Date() }],
      1,
      { page: 1, pageSize: 25 },
      denyAll,
    );

    expect(page.rows[0]).not.toHaveProperty('margin');
  });

  it('refuses an action the resource does not support', () => {
    expect(() => assertCan(RESOURCE, 'delete', allowAll)).toThrow(/does not support/);
  });

  it('refuses an action the actor may not take', () => {
    expect(() => assertCan(RESOURCE, 'create', permissionsFrom(['order.read']))).toThrow(
      /do not have permission/,
    );
    expect(() => assertCan(RESOURCE, 'create', permissionsFrom(['order.create']))).not.toThrow();
  });

  it('refuses to route an action with no permission declared', () => {
    // An unguarded write is not a decision anybody makes deliberately.
    expect(
      detailsOf(() =>
        assertCan({ ...RESOURCE, actions: ['list'], permissions: {} }, 'list', allowAll),
      ),
    ).toMatch(/declares no permission/);
  });

  it('namespaces the audit action under the resource', () => {
    expect(auditAction(RESOURCE, 'create')).toBe('orders.created');
    expect(auditAction(RESOURCE, 'read')).toBe('orders.viewed');
    expect(auditAction(RESOURCE, 'delete')).toBe('orders.deleted');
  });
});

// ---------------------------------------------------------------------------
// permissions

describe('permissions', () => {
  it('refuses a key that cannot be namespaced', () => {
    expect(detailsOf(() => definePermission('read', 'x'))).toMatch(/must be at least/);
  });

  it('splits a dotted key into resource and action', () => {
    expect(definePermission('merchant.store.read', 'View stores.')).toEqual({
      key: 'merchant.store.read',
      resource: 'merchant.store',
      action: 'read',
      description: 'View stores.',
    });
  });

  it('does not honour a wildcard', () => {
    /*
     * `merchant.*` grants a permission added next year to everyone who holds the wildcard today.
     * That is how a read-only role acquires a write.
     */
    expect(permissionsFrom(['merchant.*'])('merchant.delete')).toBe(false);
  });

  it('builds the four CRUD keys for a resource', () => {
    expect(Object.values(defineCrudPermissions('crm.lead', 'leads')).map((p) => p.key)).toEqual([
      'crm.lead.read',
      'crm.lead.create',
      'crm.lead.update',
      'crm.lead.delete',
    ]);
  });
});

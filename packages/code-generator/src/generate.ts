import { assertDeletable, type Field, type Slice } from './slice';

/**
 * Emits the files for a slice.
 *
 * `GeneratedFile[]` in, nothing written. The caller decides where the files go, so `--dry-run` and
 * the real run take the same path — the difference is printing the array instead of writing it.
 *
 * The generated code is deliberately plain. No clever abstraction, no base class to inherit, no
 * runtime that has to be understood before the file can be edited. Generated code is read far more
 * often than it is generated, and the first thing anybody does is change it.
 */

export interface GeneratedFile {
  path: string;
  content: string;
  /** What it is, so a summary can group them. */
  kind: 'schema' | 'types' | 'repository' | 'service' | 'controller' | 'test' | 'documentation';
}

const PRISMA_TYPES: Record<string, string> = {
  text: 'String',
  longtext: 'String',
  slug: 'String',
  email: 'String',
  phone: 'String',
  int: 'Int',
  money: 'Decimal',
  bool: 'Boolean',
  date: 'DateTime',
  datetime: 'DateTime',
  json: 'Json',
};

const TS_TYPES: Record<string, string> = {
  text: 'string',
  longtext: 'string',
  slug: 'string',
  email: 'string',
  phone: 'string',
  int: 'number',
  // Money crosses the wire as a string, always. Phase 8's rule reaching the generator.
  money: 'string',
  bool: 'boolean',
  date: 'Date',
  datetime: 'Date',
  json: 'Record<string, unknown>',
};

const camel = (value: string): string => value.charAt(0).toLowerCase() + value.slice(1);

const enumName = (slice: Slice, field: Field): string =>
  `${slice.entity}${field.name.charAt(0).toUpperCase()}${field.name.slice(1)}`;

function prismaType(slice: Slice, field: Field): string {
  if (field.type === 'reference') return 'String';
  if (field.type === 'enum') return enumName(slice, field);
  return PRISMA_TYPES[field.type] ?? 'String';
}

function tsType(slice: Slice, field: Field): string {
  if (field.type === 'reference') return 'string';
  if (field.type === 'enum') return field.values.map((value) => `'${value}'`).join(' | ');
  return TS_TYPES[field.type] ?? 'string';
}

const isNullable = (field: Field): boolean => !field.required && field.default === undefined;

export function generateSlice(slice: Slice): GeneratedFile[] {
  assertDeletable(slice);

  return [
    prismaFile(slice),
    typesFile(slice),
    repositoryFile(slice),
    serviceFile(slice),
    controllerFile(slice),
    testFile(slice),
    documentationFile(slice),
  ];
}

function prismaFile(slice: Slice): GeneratedFile {
  const lines: string[] = [];

  lines.push(`/// ${slice.description}`);
  lines.push('///');
  lines.push(
    '/// `organizationId` is a scalar rather than a relation so the framework schema stays',
  );
  lines.push('/// replaceable on upgrade. Isolation comes from the tenant scope on every query.');

  for (const field of slice.fields.filter((entry) => entry.type === 'enum')) {
    lines.push('');
    lines.push(`enum ${enumName(slice, field)} {`);
    for (const value of field.values) lines.push(`  ${value}`);
    lines.push('}');
  }

  lines.push('');
  lines.push(`model ${slice.entity} {`);
  lines.push('  id             String @id @default(cuid())');
  lines.push('  organizationId String');

  for (const field of slice.fields) {
    const optional = isNullable(field) ? '?' : '';
    const attributes: string[] = [];

    if (field.type === 'money') attributes.push('@db.Decimal(28, 8)');
    if (field.type === 'date') attributes.push('@db.Date');
    if (field.default !== undefined) attributes.push(`@default(${field.default})`);

    lines.push(
      `  ${field.name} ${prismaType(slice, field)}${optional}` +
        (attributes.length > 0 ? ` ${attributes.join(' ')}` : ''),
    );
  }

  lines.push('');
  lines.push('  createdAt DateTime  @default(now())');
  lines.push('  updatedAt DateTime  @updatedAt');
  lines.push('  deletedAt DateTime?');
  lines.push('');

  for (const field of slice.fields.filter((entry) => entry.unique)) {
    // Scoped to the organization: two tenants may legitimately use the same code.
    lines.push(`  @@unique([organizationId, ${field.name}])`);
  }

  lines.push('  @@index([organizationId])');
  lines.push('  @@index([deletedAt])');
  lines.push('}');
  lines.push('');

  return {
    path: `prisma/schema/20-${slice.plural}.prisma`,
    content: lines.join('\n'),
    kind: 'schema',
  };
}

function typesFile(slice: Slice): GeneratedFile {
  const lines: string[] = [];

  lines.push(`/** ${slice.description} */`);
  lines.push(`export interface ${slice.entity} {`);
  lines.push('  id: string;');
  lines.push('  organizationId: string;');

  for (const field of slice.fields) {
    const type = tsType(slice, field);
    lines.push(`  ${field.name}: ${isNullable(field) ? `${type} | null` : type};`);
  }

  lines.push('  createdAt: Date;');
  lines.push('  updatedAt: Date;');
  lines.push('  deletedAt: Date | null;');
  lines.push('}');
  lines.push('');

  const creatable = slice.fields.filter((field) => field.default === undefined || field.required);
  const updatable = slice.fields.filter((field) => !field.immutable);

  lines.push(`export interface Create${slice.entity}Input {`);
  for (const field of creatable) {
    lines.push(`  ${field.name}${field.required ? '' : '?'}: ${tsType(slice, field)};`);
  }
  lines.push('}');
  lines.push('');

  lines.push('/** Immutable fields are absent, not ignored: accepting-and-dropping is worse. */');
  lines.push(`export interface Update${slice.entity}Input {`);
  for (const field of updatable) lines.push(`  ${field.name}?: ${tsType(slice, field)};`);
  lines.push('}');
  lines.push('');

  const sensitive = slice.fields.filter((field) => field.sensitive);

  if (sensitive.length > 0) {
    lines.push('/** Never returned, never logged, never audited. */');
    lines.push(
      `export const ${slice.entity.toUpperCase()}_SENSITIVE_FIELDS = [` +
        sensitive.map((field) => `'${field.name}'`).join(', ') +
        '] as const;',
    );
    lines.push('');
  }

  return {
    path: `src/modules/${slice.plural}/${slice.plural}.types.ts`,
    content: lines.join('\n'),
    kind: 'types',
  };
}

function repositoryFile(slice: Slice): GeneratedFile {
  const lines: string[] = [];

  lines.push("import { Injectable, Inject } from '@nestjs/common';");
  lines.push("import { PrismaService } from '@trustos/database';");
  lines.push("import { TenantRepository } from '../../common/tenant-repository';");
  lines.push(`import type { ${slice.entity} } from './${slice.plural}.types';`);
  lines.push('');
  lines.push('/**');
  lines.push(` * ${slice.label} repository.`);
  lines.push(' *');
  lines.push(
    ' * Every query goes through the tenant-scoped repository. There is no method here that',
  );
  lines.push(' * reaches the delegate directly, because a single unscoped query returns every');
  lines.push(' * tenant’s rows and passes every test written against a single-tenant fixture.');
  lines.push(' */');
  lines.push('@Injectable()');
  lines.push(`export class ${slice.entity}Repository {`);
  lines.push(`  private readonly rows: TenantRepository<${slice.entity}>;`);
  lines.push('');
  lines.push('  constructor(@Inject(PrismaService) prisma: never) {');
  lines.push(
    `    this.rows = new TenantRepository<${slice.entity}>(prisma, '${camel(slice.entity)}');`,
  );
  lines.push('  }');
  lines.push('');
  lines.push(`  list(): Promise<${slice.entity}[]> {`);
  lines.push('    return this.rows.list();');
  lines.push('  }');
  lines.push('');
  lines.push(`  findById(id: string, organizationId: string): Promise<${slice.entity}> {`);
  lines.push('    return this.rows.findById(id, organizationId);');
  lines.push('  }');
  lines.push('');
  lines.push(`  create(data: Partial<${slice.entity}>): Promise<${slice.entity}> {`);
  lines.push('    return this.rows.create(data);');
  lines.push('  }');
  lines.push('');
  lines.push(`  update(id: string, data: Partial<${slice.entity}>): Promise<${slice.entity}> {`);
  lines.push('    return this.rows.update(id, data);');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  return {
    path: `src/modules/${slice.plural}/${slice.plural}.repository.ts`,
    content: lines.join('\n'),
    kind: 'repository',
  };
}

function serviceFile(slice: Slice): GeneratedFile {
  const lines: string[] = [];

  lines.push("import { Inject, Injectable } from '@nestjs/common';");
  lines.push("import type { AuditService } from '@trustos/audit';");
  lines.push("import { AUDIT_SERVICE } from '../../tokens';");
  lines.push(`import { ${slice.entity}Repository } from './${slice.plural}.repository';`);
  lines.push(
    `import type { ${slice.entity}, Create${slice.entity}Input, Update${slice.entity}Input } from './${slice.plural}.types';`,
  );
  lines.push('');
  lines.push('/**');
  lines.push(` * ${slice.label}.`);
  lines.push(' *');
  lines.push(' * Every write is audited. A change with no audit row is a change nobody can answer');
  lines.push(
    ' * questions about six months later, and the question always arrives at the worst moment.',
  );
  lines.push(' */');
  lines.push('@Injectable()');
  lines.push(`export class ${slice.entity}Service {`);
  lines.push('  constructor(');
  lines.push(`    private readonly repository: ${slice.entity}Repository,`);
  lines.push('    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,');
  lines.push('  ) {}');
  lines.push('');
  lines.push(`  list(): Promise<${slice.entity}[]> {`);
  lines.push('    return this.repository.list();');
  lines.push('  }');
  lines.push('');
  lines.push(`  find(id: string, organizationId: string): Promise<${slice.entity}> {`);
  lines.push('    return this.repository.findById(id, organizationId);');
  lines.push('  }');

  if (slice.operations.includes('create')) {
    lines.push('');
    lines.push(
      `  async create(input: Create${slice.entity}Input, organizationId: string): Promise<${slice.entity}> {`,
    );
    lines.push('    const created = await this.repository.create(input as never);');
    lines.push('');
    lines.push('    await this.audit.record({');
    lines.push(`      action: '${slice.namespace}.${slice.plural}.created',`);
    lines.push(`      entityType: '${slice.entity}',`);
    lines.push('      entityId: created.id,');
    lines.push('      organizationId,');
    lines.push(`      after: ${auditProjection(slice)},`);
    lines.push('    });');
    lines.push('');
    lines.push('    return created;');
    lines.push('  }');
  }

  if (slice.operations.includes('update')) {
    lines.push('');
    lines.push('  async update(');
    lines.push('    id: string,');
    lines.push(`    changes: Update${slice.entity}Input,`);
    lines.push('    organizationId: string,');
    lines.push(`  ): Promise<${slice.entity}> {`);
    lines.push('    const before = await this.repository.findById(id, organizationId);');
    lines.push('    const after = await this.repository.update(id, changes as never);');
    lines.push('');
    lines.push('    await this.audit.recordChange({');
    lines.push(`      action: '${slice.namespace}.${slice.plural}.updated',`);
    lines.push(`      entityType: '${slice.entity}',`);
    lines.push('      entityId: id,');
    lines.push('      organizationId,');
    lines.push(
      '      // The changed fields only. Recording the whole row buries the one that moved.',
    );
    lines.push('      before: pick(before, Object.keys(changes)),');
    lines.push('      after: pick(after, Object.keys(changes)),');
    lines.push('    });');
    lines.push('');
    lines.push('    return after;');
    lines.push('  }');
  }

  lines.push('}');
  lines.push('');
  lines.push('function pick(row: object, keys: string[]): Record<string, unknown> {');
  lines.push('  const source = row as Record<string, unknown>;');
  lines.push(
    '  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));',
  );
  lines.push('}');
  lines.push('');

  return {
    path: `src/modules/${slice.plural}/${slice.plural}.service.ts`,
    content: lines.join('\n'),
    kind: 'service',
  };
}

function auditProjection(slice: Slice): string {
  const fields = slice.fields
    .filter((field) => !field.pii && !field.sensitive)
    .slice(0, 3)
    .map((field) => `${field.name}: created.${field.name}`);

  return fields.length > 0 ? `{ ${fields.join(', ')} }` : '{ id: created.id }';
}

function controllerFile(slice: Slice): GeneratedFile {
  const upper = slice.entity.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  const lines: string[] = [];

  lines.push("import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';");
  lines.push("import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';");
  lines.push("import { RequirePermissions } from '@trustos/rbac';");
  lines.push("import { OrganizationId } from '@trustos/tenancy';");
  lines.push(`import { ${slice.entity}Service } from './${slice.plural}.service';`);
  lines.push(
    `import type { ${slice.entity}, Create${slice.entity}Input, Update${slice.entity}Input } from './${slice.plural}.types';`,
  );
  lines.push('');
  lines.push('/**');
  lines.push(` * ${slice.label} endpoints.`);
  lines.push(' *');
  lines.push(
    ' * Every route declares a permission — the guard denies any route that declares none —',
  );
  lines.push(
    ' * and the organization comes from the tenant guard, never from a path, body or header.',
  );
  lines.push(' */');
  lines.push(`const P = {`);
  lines.push(`  READ: '${slice.namespace}.${slice.plural}.read',`);
  lines.push(`  CREATE: '${slice.namespace}.${slice.plural}.create',`);
  lines.push(`  UPDATE: '${slice.namespace}.${slice.plural}.update',`);

  if (slice.fields.some((field) => field.pii)) {
    lines.push(`  PII_READ: '${slice.namespace}.${slice.plural}.pii.read',`);
  }

  lines.push('} as const;');
  lines.push('');
  lines.push(`@ApiTags('${slice.plural}')`);
  lines.push("@ApiBearerAuth('access-token')");
  lines.push(`@Controller('${slice.plural}')`);
  lines.push(`export class ${slice.entity}Controller {`);
  lines.push(`  constructor(private readonly service: ${slice.entity}Service) {}`);

  if (slice.operations.includes('list')) {
    lines.push('');
    lines.push('  @Get()');
    lines.push('  @RequirePermissions(P.READ)');
    lines.push(`  @ApiOperation({ summary: 'List ${slice.label.toLowerCase()}' })`);
    lines.push(`  list(): Promise<${slice.entity}[]> {`);
    lines.push('    return this.service.list();');
    lines.push('  }');
  }

  if (slice.operations.includes('read')) {
    lines.push('');
    lines.push("  @Get(':id')");
    lines.push('  @RequirePermissions(P.READ)');
    lines.push(`  @ApiOperation({ summary: 'Read one ${slice.singular.toLowerCase()}' })`);
    lines.push('  find(');
    lines.push("    @Param('id') id: string,");
    lines.push('    @OrganizationId() organizationId: string,');
    lines.push(`  ): Promise<${slice.entity}> {`);
    lines.push('    return this.service.find(id, organizationId);');
    lines.push('  }');
  }

  if (slice.operations.includes('create')) {
    lines.push('');
    lines.push('  @Post()');
    lines.push('  @RequirePermissions(P.CREATE)');
    lines.push(`  @ApiOperation({ summary: 'Create a ${slice.singular.toLowerCase()}' })`);
    lines.push('  create(');
    lines.push('    @OrganizationId() organizationId: string,');
    lines.push(`    @Body() body: Create${slice.entity}Input,`);
    lines.push(`  ): Promise<${slice.entity}> {`);
    lines.push('    return this.service.create(body, organizationId);');
    lines.push('  }');
  }

  if (slice.operations.includes('update')) {
    lines.push('');
    lines.push("  @Patch(':id')");
    lines.push('  @RequirePermissions(P.UPDATE)');
    lines.push(`  @ApiOperation({ summary: 'Modify a ${slice.singular.toLowerCase()}' })`);
    lines.push('  update(');
    lines.push("    @Param('id') id: string,");
    lines.push('    @OrganizationId() organizationId: string,');
    lines.push(`    @Body() body: Update${slice.entity}Input,`);
    lines.push(`  ): Promise<${slice.entity}> {`);
    lines.push('    return this.service.update(id, body, organizationId);');
    lines.push('  }');
  }

  lines.push('}');
  lines.push('');

  void upper;
  return {
    path: `src/modules/${slice.plural}/${slice.plural}.controller.ts`,
    content: lines.join('\n'),
    kind: 'controller',
  };
}

function testFile(slice: Slice): GeneratedFile {
  const lines: string[] = [];

  lines.push("import { describe, expect, it } from 'vitest';");
  lines.push("import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';");
  lines.push('');
  lines.push('/**');
  lines.push(` * ${slice.entity} tenant isolation.`);
  lines.push(' *');
  lines.push(
    ' * The quietest failure this code can have: a query that returns another organization’s',
  );
  lines.push(' * rows. It breaks nothing, fails no build, and is discovered by a customer.');
  lines.push(' */');
  lines.push('');
  lines.push("const ACME = 'org_acme';");
  lines.push("const RIVAL = 'org_rival';");
  lines.push('');
  lines.push(`describe('${slice.plural} tenant isolation', () => {`);
  lines.push(
    `  it('never returns another organization’s ${slice.label.toLowerCase()}', async () => {`,
  );
  lines.push('    const delegate = new FakeModelDelegate([');
  lines.push("      { id: 'a', organizationId: ACME, deletedAt: null },");
  lines.push("      { id: 'b', organizationId: RIVAL, deletedAt: null },");
  lines.push('    ] as never);');
  lines.push('');
  lines.push('    const rows = await runInTenantContext(');
  lines.push("      { organizationId: ACME, actorId: 'user_1', isSuperAdmin: false },");
  lines.push(
    '      () => delegate.findMany({ where: { organizationId: ACME, deletedAt: null } }),',
  );
  lines.push('    );');
  lines.push('');
  lines.push("    expect(rows.map((row: { id: string }) => row.id)).toEqual(['a']);");
  lines.push('  });');
  lines.push('');
  lines.push(
    `  it('reports another organization’s ${slice.singular.toLowerCase()} as absent', async () => {`,
  );
  lines.push('    const delegate = new FakeModelDelegate([');
  lines.push("      { id: 'b', organizationId: RIVAL, deletedAt: null },");
  lines.push('    ] as never);');
  lines.push('');
  lines.push('    // Absent rather than forbidden: a 403 would confirm the id exists.');
  lines.push('    const found = await delegate.findFirst({');
  lines.push("      where: { id: 'b', organizationId: ACME, deletedAt: null },");
  lines.push('    });');
  lines.push('');
  lines.push('    expect(found).toBeNull();');
  lines.push('  });');
  lines.push('});');
  lines.push('');

  return {
    path: `src/modules/${slice.plural}/tenant-isolation.spec.ts`,
    content: lines.join('\n'),
    kind: 'test',
  };
}

function documentationFile(slice: Slice): GeneratedFile {
  const lines: string[] = [];

  lines.push(`# ${slice.label}`);
  lines.push('');
  lines.push(slice.description);
  lines.push('');
  lines.push('## Fields');
  lines.push('');
  lines.push('| Field | Type | Required | Notes |');
  lines.push('| --- | --- | --- | --- |');

  for (const field of slice.fields) {
    const notes = [
      field.unique ? 'unique per organization' : '',
      field.immutable ? 'immutable' : '',
      field.pii ? 'personal data — own permission' : '',
      field.sensitive ? 'never returned' : '',
    ]
      .filter(Boolean)
      .join(', ');

    lines.push(
      `| \`${field.name}\` | ${field.type} | ${field.required ? 'yes' : 'no'} | ${notes || '—'} |`,
    );
  }

  lines.push('');
  lines.push('## Endpoints');
  lines.push('');
  lines.push('| Method | Path | Permission |');
  lines.push('| --- | --- | --- |');

  const routes: Array<[string, string, string]> = [
    ['GET', `/${slice.plural}`, `${slice.namespace}.${slice.plural}.read`],
    ['GET', `/${slice.plural}/:id`, `${slice.namespace}.${slice.plural}.read`],
    ['POST', `/${slice.plural}`, `${slice.namespace}.${slice.plural}.create`],
    ['PATCH', `/${slice.plural}/:id`, `${slice.namespace}.${slice.plural}.update`],
  ];

  for (const [method, path, permission] of routes)
    lines.push(`| ${method} | ${path} | \`${permission}\` |`);

  lines.push('');
  lines.push('## Guarantees');
  lines.push('');
  lines.push('- Every query is scoped to the calling organization.');
  lines.push('- Every write records an audit entry.');
  lines.push('- Deletes are soft: rows carry `deletedAt` and every query filters on it.');

  if (slice.fields.some((field) => field.pii)) {
    lines.push(
      `- Personal data is behind \`${slice.namespace}.${slice.plural}.pii.read\` and projected away ` +
        'server-side without it.',
    );
  }

  lines.push('');

  return {
    path: `docs/${slice.plural}.md`,
    content: lines.join('\n'),
    kind: 'documentation',
  };
}

/** A summary of what a generation would write. */
export function describeGeneration(files: readonly GeneratedFile[]): string {
  const byKind = new Map<string, number>();
  for (const file of files) byKind.set(file.kind, (byKind.get(file.kind) ?? 0) + 1);

  return `${files.length} file(s): ${[...byKind.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ')}.`;
}

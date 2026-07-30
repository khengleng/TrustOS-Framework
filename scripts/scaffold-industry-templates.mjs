#!/usr/bin/env node
/**
 * Generates the industry template file trees from `template-specs.mjs`.
 *
 * Read the header of that file for why the templates are generated rather than hand-written. The
 * short version: what differs per industry is the domain, and what must not differ is the tenant
 * scope, the audit trail, the permission wiring and the isolation test. Generating the second
 * category means there is one correct version of it instead of twenty-four copies that were
 * correct on the day they were written.
 *
 * Each template contributes files that are *additive* — its own Prisma fragment, its own domain
 * package module, its own NestJS folder — plus three **aggregators** it overrides:
 *
 *   packages/product-domain/src/index.ts        composes the chain's permissions
 *   apps/admin/src/lib/resources.ts             composes the chain's screens
 *   apps/api/src/modules/product/product.module.ts  imports the chain's Nest modules
 *
 * The aggregators are the only overridden files, and each one is a list of imports. That is what
 * lets `hospital` extend `clinic` without restating a single patient field: the child adds its
 * folder and re-lists the chain, and the parent's files come through the layer beneath untouched.
 *
 * Run it with `node scripts/scaffold-industry-templates.mjs`. It is idempotent.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_SPECS } from './template-specs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatesRoot = join(root, 'templates');

/** Templates that already exist by hand and are only *parents* here. */
const HAND_WRITTEN = new Map([
  [
    'merchant',
    {
      id: 'merchant',
      moduleName: 'MerchantDomainModule',
      domainConst: 'MERCHANT_PERMISSIONS',
      folder: 'merchant',
      resourcesFile: 'resources-merchant',
      domainFile: 'merchant',
      depth: 0,
    },
  ],
]);

const specById = new Map(TEMPLATE_SPECS.map((spec) => [spec.id, spec]));

// ---------------------------------------------------------------------------
// naming

const pascal = (value) =>
  value
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const camel = (value) => {
  const p = pascal(value);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

const kebab = (value) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();

/** `MerchantMember` -> `merchantMember`, the Prisma delegate name. */
const delegate = (entityName) => entityName.charAt(0).toLowerCase() + entityName.slice(1);

/** Plural URL segment for an entity: `Product` -> `products`, `Policy` -> `policies`. */
const plural = (entityName) => {
  const base = kebab(entityName);
  if (/(s|x|z|ch|sh)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
};

/** The chain of specs from the root parent down to this template. */
function chainOf(id) {
  const chain = [];
  let current = id;

  while (current) {
    const spec = specById.get(current) ?? HAND_WRITTEN.get(current);
    if (!spec) throw new Error(`Unknown template "${current}" in an extends chain.`);
    chain.unshift(spec);
    current = spec.extends;
  }

  return chain;
}

const depthOf = (id) => chainOf(id).length - 1;

/** Metadata a chain member exposes to its descendants' aggregators. */
function memberOf(spec) {
  if (HAND_WRITTEN.has(spec.id)) return HAND_WRITTEN.get(spec.id);

  return {
    id: spec.id,
    moduleName: `${pascal(spec.id)}DomainModule`,
    domainConst: `${spec.id.replace(/-/g, '_').toUpperCase()}_PERMISSIONS`,
    folder: spec.id,
    resourcesFile: `resources-${spec.id}`,
    domainFile: spec.id,
    depth: depthOf(spec.id),
  };
}

// ---------------------------------------------------------------------------
// field mapping

const PRISMA_TYPES = {
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

const TS_TYPES = {
  text: 'string',
  longtext: 'string',
  slug: 'string',
  email: 'string',
  phone: 'string',
  int: 'number',
  // A Decimal crosses the wire as a string. Never a number — Phase 8's rule, and the reason
  // `@db.Decimal` exists on the column in the first place.
  money: 'string',
  bool: 'boolean',
  date: 'Date',
  datetime: 'Date',
  json: 'Record<string, unknown>',
};

const isRef = (field) => field.type.startsWith('ref:');
const isEnum = (field) => field.type.startsWith('enum:');
const enumName = (field) => field.type.slice('enum:'.length);
const refTarget = (field) => field.type.slice('ref:'.length);

function prismaType(field) {
  if (isRef(field)) return 'String';
  if (isEnum(field)) return enumName(field);
  return PRISMA_TYPES[field.type] ?? 'String';
}

function tsType(field, spec) {
  if (isRef(field)) return 'string';
  if (isEnum(field)) {
    const values = enumValues(spec, enumName(field));
    return values.map((value) => `'${value}'`).join(' | ');
  }
  return TS_TYPES[field.type] ?? 'string';
}

function enumValues(spec, name) {
  for (const entity of spec.entities) {
    if (entity.enums?.[name]) return entity.enums[name];
  }
  // A child may reference an enum its parent declared; the union is resolved at the parent.
  for (const ancestor of chainOf(spec.id)) {
    for (const entity of ancestor.entities ?? []) {
      if (entity.enums?.[name]) return entity.enums[name];
    }
  }
  throw new Error(`Enum "${name}" is referenced in "${spec.id}" but declared nowhere in its chain.`);
}

// ---------------------------------------------------------------------------
// prisma

function prismaFile(spec) {
  const lines = [];

  lines.push('// =============================================================================');
  lines.push(`// ${spec.displayName} — product models`);
  lines.push('//');
  for (const line of wrap(spec.description, 74)) lines.push(`// ${line}`);
  lines.push('//');
  for (const line of wrap(
    'Out of scope, deliberately: ' + spec.outOfScope.join(', ') + '.',
    74,
  )) {
    lines.push(`// ${line}`);
  }
  lines.push('//');
  for (const line of wrap(
    '`organizationId` is a scalar rather than a Prisma relation so that 00-framework.prisma ' +
      'stays replaceable on upgrade — the same trade the framework makes for AuditLog. ' +
      'Isolation comes from the tenant scope applied to every query, and is proven by the ' +
      'isolation tests.',
    74,
  )) {
    lines.push(`// ${line}`);
  }
  lines.push('// =============================================================================');
  lines.push('');

  const seen = new Set();
  for (const entity of spec.entities) {
    for (const [name, values] of Object.entries(entity.enums ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      lines.push(`enum ${name} {`);
      for (const value of values) lines.push(`  ${value}`);
      lines.push('}');
      lines.push('');
    }
  }

  for (const entity of spec.entities) {
    for (const line of wrap(entity.description, 76)) lines.push(`/// ${line}`);
    lines.push(`model ${entity.name} {`);
    lines.push('  id             String @id @default(cuid())');
    lines.push('  organizationId String');

    for (const field of entity.fields) {
      /*
       * A field with a database default is never nullable. Prisma will happily accept
       * `Status? @default(ACTIVE)`, and the result is a column with three states — set, defaulted
       * and null — where the domain has two. Every consumer then has to decide what a null status
       * means, and they decide differently.
       */
      const optional = field.required || field.default !== undefined ? '' : '?';
      const attributes = [];

      if (field.type === 'money') attributes.push('@db.Decimal(28, 8)');
      if (field.type === 'date') attributes.push('@db.Date');
      if (field.default !== undefined) attributes.push(`@default(${field.default})`);

      const suffix = attributes.length > 0 ? ` ${attributes.join(' ')}` : '';
      lines.push(`  ${field.name} ${prismaType(field)}${optional}${suffix}`);
    }

    lines.push('');
    lines.push('  createdAt DateTime  @default(now())');
    lines.push('  updatedAt DateTime  @updatedAt');
    lines.push('  deletedAt DateTime?');
    lines.push('');

    for (const field of entity.fields) {
      if (field.unique) lines.push(`  @@unique([organizationId, ${field.name}])`);
    }

    const indexable = entity.fields.filter((field) => isRef(field) || field.filter).slice(0, 4);
    for (const field of indexable) {
      lines.push(`  @@index([organizationId, ${field.name}])`);
    }

    lines.push('  @@index([deletedAt])');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// product domain (permissions)

function permissionKeysFor(spec, entity) {
  const namespace = `${spec.id.replace(/-/g, '')}.${kebab(entity.name)}`;
  return {
    read: `${namespace}.read`,
    create: `${namespace}.create`,
    update: `${namespace}.update`,
    pii: `${namespace}.pii.read`,
  };
}

const hasPii = (entity) => entity.fields.some((field) => field.pii);

function domainFile(spec) {
  const constName = memberOf(spec).domainConst;
  const lines = [];

  lines.push('/**');
  lines.push(` * ${spec.displayName} — permission keys and domain types.`);
  lines.push(' *');
  for (const line of wrap(
    'Permission keys are a public contract: add keys freely, never rename one. A renamed key ' +
      'silently revokes access on every deployment that has not been migrated and grants it on ' +
      'none — the failure is invisible until somebody cannot do their job.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' *');
  for (const line of wrap(
    'Keys are namespaced under the template id so they can never collide with a framework key ' +
      'or with another template layered beneath this one.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('');
  lines.push("import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';");
  lines.push('');
  lines.push(`export const ${constName} = {`);

  for (const entity of spec.entities) {
    const keys = permissionKeysFor(spec, entity);
    const label = entity.label.toLowerCase();
    const upper = entity.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

    lines.push(`  ${upper}_READ: definePermission('${keys.read}', 'View ${label}.'),`);
    lines.push(`  ${upper}_CREATE: definePermission('${keys.create}', 'Create ${entity.singular.toLowerCase()}.'),`);
    lines.push(`  ${upper}_UPDATE: definePermission('${keys.update}', 'Modify ${entity.singular.toLowerCase()}.'),`);

    if (hasPii(entity)) {
      const piiFields = entity.fields.filter((field) => field.pii).map((field) => field.name);
      lines.push(
        `  ${upper}_PII_READ: definePermission(` +
          `'${keys.pii}', 'See personal data on ${label} (${piiFields.join(', ')}).'),`,
      );
    }
  }

  lines.push('} as const;');
  lines.push('');
  lines.push(`export const ${constName}_LIST: PermissionDefinition[] = Object.values(${constName});`);
  lines.push('');

  // Read-only set, used by the role mapping.
  lines.push('/**');
  lines.push(' * Which framework roles receive which permissions.');
  lines.push(' *');
  for (const line of wrap(
    'Least privilege, and the two rules that matter: `auditor` is read-only by definition and ' +
      'must never gain a write here, and personal data is granted separately from ordinary ' +
      'reads — an operator who can work a record usually has no business reading the ' +
      'identity behind it.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');

  const reads = spec.entities.map(
    (entity) => `${constName}.${upperOf(entity)}_READ.key`,
  );
  const writes = spec.entities.flatMap((entity) => [
    `${constName}.${upperOf(entity)}_CREATE.key`,
    `${constName}.${upperOf(entity)}_UPDATE.key`,
  ]);
  const piis = spec.entities
    .filter(hasPii)
    .map((entity) => `${constName}.${upperOf(entity)}_PII_READ.key`);

  lines.push(`const READ_ONLY = [`);
  for (const key of reads) lines.push(`  ${key},`);
  lines.push('];');
  lines.push('');
  lines.push(`const WRITE = [`);
  for (const key of writes) lines.push(`  ${key},`);
  lines.push('];');
  lines.push('');

  if (piis.length > 0) {
    lines.push('/** Personal data. Granted to nobody by default except the owner role. */');
    lines.push(`const PERSONAL_DATA = [`);
    for (const key of piis) lines.push(`  ${key},`);
    lines.push('];');
    lines.push('');
  }

  lines.push(`export const ${constName}_ROLES: Record<string, string[]> = {`);
  lines.push(`  organization_owner: ${constName}_LIST.map((permission) => permission.key),`);
  lines.push(
    `  administrator: [...READ_ONLY, ...WRITE${piis.length > 0 ? ', ...PERSONAL_DATA' : ''}],`,
  );
  lines.push('  operator: [...READ_ONLY, ...WRITE],');
  lines.push('  auditor: READ_ONLY,');
  lines.push('};');
  lines.push('');

  // Status unions, so a caller has a type rather than a string.
  const emitted = new Set();
  for (const entity of spec.entities) {
    for (const [name, values] of Object.entries(entity.enums ?? {})) {
      if (emitted.has(name)) continue;
      emitted.add(name);
      lines.push(
        `export type ${name} = ${values.map((value) => `'${value}'`).join(' | ')};`,
      );
      lines.push(
        `export const ${name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_VALUES: ${name}[] = [${values
          .map((value) => `'${value}'`)
          .join(', ')}];`,
      );
      lines.push('');
    }
  }

  return lines.join('\n');
}

const upperOf = (entity) => entity.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/** The aggregator: composes every permission set in the chain. */
function domainIndexFile(spec) {
  const chain = chainOf(spec.id).map(memberOf);
  const lines = [];

  lines.push('/**');
  lines.push(` * Product domain — ${spec.displayName}.`);
  lines.push(' *');
  if (chain.length > 1) {
    for (const line of wrap(
      `This template extends ${chain
        .slice(0, -1)
        .map((member) => member.id)
        .join(' -> ')}, so its catalog is the union of every layer's. Each layer keeps its own ` +
        'file and this one only joins them — which is why adding a permission to a parent ' +
        'reaches every child without anybody editing the child.',
      94,
    )) {
      lines.push(` * ${line}`);
    }
  } else {
    for (const line of wrap(
      'One layer today. If a template comes to extend this one, it will re-export this file ' +
        'alongside its own rather than copying anything out of it.',
      94,
    )) {
      lines.push(` * ${line}`);
    }
  }
  lines.push(' */');
  lines.push('');
  lines.push("import type { PermissionDefinition } from '@trustos/template-sdk';");

  for (const member of chain) {
    lines.push(
      `import { ${member.domainConst}_LIST, ${member.domainConst}_ROLES } from './${member.domainFile}';`,
    );
  }

  lines.push('');
  for (const member of chain) lines.push(`export * from './${member.domainFile}';`);
  lines.push('');
  lines.push('/** Every permission this application defines, seeded alongside the framework’s. */');
  lines.push('export const PRODUCT_PERMISSIONS: PermissionDefinition[] = [');
  for (const member of chain) lines.push(`  ...${member.domainConst}_LIST,`);
  lines.push('];');
  lines.push('');
  lines.push('/**');
  lines.push(' * Role-to-permission mapping, applied by the seed.');
  lines.push(' *');
  for (const line of wrap(
    'Merged per role rather than per layer, so a role defined by two layers ends up with both ' +
      'sets rather than whichever one was spread last.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = mergeRoles([');
  for (const member of chain) lines.push(`  ${member.domainConst}_ROLES,`);
  lines.push(']);');
  lines.push('');
  lines.push('function mergeRoles(layers: Array<Record<string, string[]>>): Record<string, string[]> {');
  lines.push('  const merged: Record<string, string[]> = {};');
  lines.push('');
  lines.push('  for (const layer of layers) {');
  lines.push('    for (const [role, permissions] of Object.entries(layer)) {');
  lines.push('      merged[role] = [...new Set([...(merged[role] ?? []), ...permissions])];');
  lines.push('    }');
  lines.push('  }');
  lines.push('');
  lines.push('  return merged;');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// admin resources

function columnFor(field, spec) {
  const parts = [`key: '${field.name}'`, `label: '${field.label}'`];

  if (field.type === 'money') parts.push("format: 'money'", "currencyKey: 'currency'");
  else if (field.type === 'datetime') parts.push("format: 'datetime'");
  else if (field.type === 'date') parts.push("format: 'date'");
  else if (field.type === 'int') parts.push("format: 'number'");
  else if (field.type === 'bool' || isEnum(field)) parts.push("format: 'badge'");
  else if (isRef(field)) parts.push("format: 'reference'");

  if (field.unique || field.filter) parts.push('sortable: true');
  if (field.pii) parts.push(`permission: '${permissionNamespace(spec)}.pii.read'`);

  return `{ ${parts.join(', ')} }`;
}

const permissionNamespace = (spec) => spec.id.replace(/-/g, '');

function resourcesFile(spec) {
  const lines = [];

  lines.push('/**');
  lines.push(` * ${spec.displayName} — console screens.`);
  lines.push(' *');
  for (const line of wrap(
    'One declaration per resource, read by the table, the filters, the search box and the ' +
      'permission checks. The recurring admin-console bug is a field added to the form and ' +
      'forgotten in the table; it cannot happen when there is one list.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' *');
  for (const line of wrap(
    'A column carrying personal data declares a permission, and the *API* projects it away — ' +
      'see visibleColumns in @trustos/template-sdk. A column hidden in the browser is still in ' +
      'the payload.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('');
  lines.push("import type { ResourceDefinition } from '@trustos/template-sdk';");
  lines.push(`import { ${memberOf(spec).domainConst} as P } from '{{packageName}}-product-domain';`);
  lines.push('');
  lines.push(`export const ${constNameFor(spec)}: ResourceDefinition[] = [`);

  for (const entity of spec.entities) {
    const upper = upperOf(entity);
    const key = plural(entity.name);
    const searchFields = entity.fields.filter((field) => field.search);
    const filterFields = entity.fields.filter((field) => field.filter);

    lines.push('  {');
    lines.push(`    key: '${key}',`);
    lines.push(`    label: '${entity.label}',`);
    lines.push(`    singular: '${entity.singular}',`);
    lines.push(`    endpoint: '/${key}',`);
    lines.push(`    description: ${JSON.stringify(firstSentence(entity.description))},`);
    lines.push('    table: {');
    lines.push(`      key: '${key}',`);
    lines.push(`      label: '${entity.label}',`);
    lines.push(`      endpoint: '/${key}',`);
    lines.push(`      emptyHint: 'Create one with POST /api/${key}.',`);
    lines.push(`      defaultSort: { key: 'createdAt', direction: 'desc' },`);
    lines.push('      columns: [');
    for (const field of entity.fields.slice(0, 6)) {
      lines.push(`        ${columnFor(field, spec)},`);
    }
    lines.push(`        { key: 'createdAt', label: 'Created', format: 'datetime', sortable: true },`);
    lines.push('      ],');
    lines.push('    },');

    if (filterFields.length > 0) {
      lines.push('    filters: [');
      for (const field of filterFields) {
        const type = isEnum(field)
          ? 'enum'
          : field.type === 'int'
            ? 'number'
            : field.type === 'bool'
              ? 'boolean'
              : field.type === 'date' || field.type === 'datetime'
                ? 'date'
                : 'string';
        const operators = isEnum(field)
          ? "['eq', 'in']"
          : type === 'date'
            ? "['gte', 'lte', 'between']"
            : type === 'number'
              ? "['eq', 'gte', 'lte', 'between']"
              : type === 'boolean'
                ? "['eq']"
                : "['eq', 'contains']";

        const options = isEnum(field)
          ? `, options: ${JSON.stringify(
              enumValues(spec, enumName(field)).map((value) => ({ value, label: titleCase(value) })),
            )}`
          : '';

        lines.push(
          `      { key: '${field.name}', label: '${field.label}', type: '${type}', operators: ${operators}${options} },`,
        );
      }
      lines.push('    ],');
    }

    if (searchFields.length > 0) {
      lines.push('    search: {');
      lines.push('      fields: [');
      for (const field of searchFields) {
        const prefix = field.prefix ? ', prefixOnly: true' : '';
        const permission = field.pii
          ? `, permission: '${permissionNamespace(spec)}.pii.read'`
          : '';
        lines.push(
          `        { key: '${field.name}', label: '${field.label}'${prefix}${permission} },`,
        );
      }
      lines.push('      ],');
      lines.push('    },');
    }

    lines.push('    permissions: {');
    lines.push(`      list: P.${upper}_READ.key,`);
    lines.push(`      read: P.${upper}_READ.key,`);
    lines.push(`      create: P.${upper}_CREATE.key,`);
    lines.push(`      update: P.${upper}_UPDATE.key,`);
    lines.push('    },');
    lines.push('  },');
  }

  lines.push('];');
  lines.push('');

  return lines.join('\n');
}

const constNameFor = (spec) =>
  `${spec.id.replace(/-/g, '_').toUpperCase()}_RESOURCES`;

function resourcesIndexFile(spec) {
  const chain = chainOf(spec.id);
  const lines = [];

  lines.push('/**');
  lines.push(' * Every console screen, in menu order.');
  lines.push(' *');
  if (chain.length > 1) {
    for (const line of wrap(
      `Parent layers first: ${chain
        .map((member) => member.id)
        .join(' -> ')}. A child that wanted to reorder or hide a parent screen would filter this ` +
        'array, never edit the parent file.',
      94,
    )) {
      lines.push(` * ${line}`);
    }
  } else {
    for (const line of wrap(
      'One generic page renders every entry, so adding a screen is a line in the resource file ' +
        'rather than another near-identical page component.',
      94,
    )) {
      lines.push(` * ${line}`);
    }
  }
  lines.push(' */');
  lines.push('');
  lines.push("import type { ResourceDefinition } from '@trustos/template-sdk';");

  for (const member of chain) {
    const meta = memberOf(member);
    if (HAND_WRITTEN.has(member.id)) {
      lines.push(`import { RESOURCES as ${constNameFor({ id: member.id })} } from './${meta.resourcesFile}';`);
    } else {
      lines.push(`import { ${constNameFor(member)} } from './${meta.resourcesFile}';`);
    }
  }

  lines.push('');
  lines.push('export const RESOURCES: ResourceDefinition[] = [');
  for (const member of chain) lines.push(`  ...${constNameFor(member)},`);
  lines.push('];');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// API: service, controller, module

function rowInterface(spec, entity) {
  const lines = [];

  lines.push(`export interface ${entity.name}Row {`);
  lines.push('  id: string;');
  lines.push('  organizationId: string;');

  for (const field of entity.fields) {
    const type = tsType(field, spec);
    const nullable = !field.required && field.default === undefined;
    lines.push(`  ${field.name}: ${nullable ? `${type} | null` : type};`);
  }

  lines.push('  createdAt: Date;');
  lines.push('  updatedAt: Date;');
  lines.push('  deletedAt: Date | null;');
  lines.push('}');

  return lines.join('\n');
}

function serviceFile(spec) {
  const name = `${pascal(spec.id)}Service`;
  const lines = [];

  lines.push("import { Inject, Injectable } from '@nestjs/common';");
  lines.push("import type { AuditService } from '@trustos/audit';");
  lines.push("import { PrismaService } from '@trustos/database';");
  lines.push("import { ApiError } from '@trustos/errors';");
  lines.push("import type { AppPrismaService } from '../../../core/prisma.service';");
  lines.push("import { AUDIT_SERVICE } from '../../../tokens';");
  lines.push("import { TenantRepository } from '../../../common/tenant-repository';");
  lines.push('');
  lines.push('/**');
  lines.push(` * ${spec.displayName} domain service.`);
  lines.push(' *');
  for (const line of wrap(
    'Every read and write goes through a tenant-scoped repository, and every parent reference is ' +
      'verified through one before a child is created. Without that second check a caller could ' +
      'attach a record to a parent in another organization by supplying its id — the row would ' +
      'be stamped with the caller’s organization, so no isolation test would fail, and the data ' +
      'would be wrong in a way that is hard to unpick later.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' *');
  for (const line of wrap(
    'Writes are audited. A financial or personal-data change with no audit row is a change ' +
      'nobody can answer questions about six months later.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('');

  for (const entity of spec.entities) {
    lines.push(rowInterface(spec, entity));
    lines.push('');
  }

  lines.push('@Injectable()');
  lines.push(`export class ${name} {`);

  for (const entity of spec.entities) {
    lines.push(`  private readonly ${camel(plural(entity.name))}: TenantRepository<${entity.name}Row>;`);
  }

  lines.push('');
  lines.push('  constructor(');
  lines.push('    @Inject(PrismaService) prisma: AppPrismaService,');
  lines.push('    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,');
  lines.push('  ) {');

  for (const entity of spec.entities) {
    lines.push(
      `    this.${camel(plural(entity.name))} = new TenantRepository<${entity.name}Row>(prisma, '${delegate(entity.name)}');`,
    );
  }

  lines.push('  }');

  for (const entity of spec.entities) {
    const repo = camel(plural(entity.name));
    const single = pascal(entity.name);
    const parents = entity.fields.filter((field) => isRef(field) && specHasEntity(spec, refTarget(field)));

    lines.push('');
    lines.push(`  // --- ${entity.label.toLowerCase()} ${'-'.repeat(Math.max(0, 60 - entity.label.length))}`);
    lines.push('');
    lines.push(`  list${plural(single).split('-').map(pascal).join('')}(): Promise<${entity.name}Row[]> {`);
    lines.push(`    return this.${repo}.list();`);
    lines.push('  }');
    lines.push('');
    lines.push(`  find${single}(id: string, organizationId: string): Promise<${entity.name}Row> {`);
    lines.push(`    return this.${repo}.findById(id, organizationId);`);
    lines.push('  }');
    lines.push('');

    // Fields a caller may supply. A defaulted field is optional; the database fills it.
    const createFields = entity.fields.filter((field) => !isGenerated(field));
    lines.push(`  async create${single}(`);
    lines.push('    input: {');
    for (const field of createFields) {
      lines.push(`      ${field.name}${field.required ? '' : '?'}: ${tsType(field, spec)};`);
    }
    lines.push('    },');
    lines.push('    organizationId: string,');
    lines.push(`  ): Promise<${entity.name}Row> {`);

    /*
     * Every parent reference is verified through the tenant-scoped repository before the child is
     * written. Without it a caller could attach a record to a parent in another organization by
     * supplying its id — the row would be stamped with the caller's organization, so no isolation
     * test would fail, and the data would be wrong in a way that is hard to unpick later.
     *
     * An *optional* reference is only checked when supplied. Checking it unconditionally would
     * make every optional parent mandatory in practice.
     */
    for (const parent of parents) {
      const repository = camel(plural(refTarget(parent)));

      if (parent.required) {
        lines.push(`    await this.${repository}.findById(input.${parent.name}, organizationId);`);
      } else {
        lines.push(`    if (input.${parent.name} !== undefined) {`);
        lines.push(`      await this.${repository}.findById(input.${parent.name}, organizationId);`);
        lines.push('    }');
      }
    }
    if (parents.length > 0) {
      lines.push('');
    }

    lines.push(`    const created = await this.${repo}.create({`);
    for (const field of createFields) {
      const fallback = field.required || field.default !== undefined ? '' : ' ?? null';
      lines.push(`      ${field.name}: input.${field.name}${fallback},`);
    }
    lines.push('    });');
    lines.push('');
    lines.push('    await this.audit.record({');
    lines.push(`      action: '${permissionNamespace(spec)}.${kebab(entity.name)}.created',`);
    lines.push(`      entityType: '${entity.name}',`);
    lines.push('      entityId: created.id,');
    lines.push('      organizationId,');
    lines.push(`      after: ${auditProjection(entity)},`);
    lines.push('    });');
    lines.push('');
    lines.push('    return created;');
    lines.push('  }');

    const updatable = entity.fields.filter((field) => !field.immutable);

    if (updatable.length > 0) {
      lines.push('');
      lines.push(`  async update${single}(`);
      lines.push('    id: string,');
      lines.push('    changes: {');
      for (const field of updatable) {
        lines.push(`      ${field.name}?: ${tsType(field, spec)};`);
      }
      lines.push('    },');
      lines.push('    organizationId: string,');
      lines.push(`  ): Promise<${entity.name}Row> {`);
      lines.push(`    const existing = await this.${repo}.findById(id, organizationId);`);
      lines.push('');
      lines.push('    if (Object.keys(changes).length === 0) {');
      lines.push('      /*');
      lines.push('       * Refused rather than accepted as a no-op. An empty PATCH is almost always a');
      lines.push('       * client that dropped its body, and returning 200 tells it everything worked.');
      lines.push('       */');
      lines.push('      throw ApiError.validation(');
      lines.push("        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],");
      lines.push("        'Nothing to update.',");
      lines.push('      );');
      lines.push('    }');
      lines.push('');
      lines.push(`    const updated = await this.${repo}.update(id, changes);`);
      lines.push('');
      lines.push('    await this.audit.recordChange({');
      lines.push(`      action: '${permissionNamespace(spec)}.${kebab(entity.name)}.updated',`);
      lines.push(`      entityType: '${entity.name}',`);
      lines.push('      entityId: id,');
      lines.push('      organizationId,');
      lines.push('      before: pick(existing, Object.keys(changes)),');
      lines.push('      after: pick(updated, Object.keys(changes)),');
      lines.push('    });');
      lines.push('');
      lines.push('    return updated;');
      lines.push('  }');
    }
  }

  lines.push('}');
  lines.push('');
  lines.push('/**');
  lines.push(' * The changed fields only, for the audit trail.');
  lines.push(' *');
  for (const line of wrap(
    'Recording the whole row before and after makes every audit entry look like a total rewrite ' +
      'and buries the one field that actually moved.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('function pick(row: object, keys: string[]): Record<string, unknown> {');
  lines.push('  /*');
  lines.push('   * `object` rather than `Record<string, unknown>`: an interface with declared fields');
  lines.push('   * has no index signature, so the constrained generic would reject every row type');
  lines.push('   * this service defines. The cast is contained to this one line.');
  lines.push('   */');
  lines.push('  const source = row as Record<string, unknown>;');
  lines.push('');
  lines.push('  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

const specHasEntity = (spec, name) => spec.entities.some((entity) => entity.name === name);

/** Fields the database owns. Nothing generated is part of a create input. */
const isGenerated = () => false;

function auditProjection(entity) {
  const fields = entity.fields
    .filter((field) => !field.pii && !field.sensitive)
    .slice(0, 3)
    .map((field) => `${field.name}: created.${field.name}`);

  if (fields.length === 0) return '{ id: created.id }';
  return `{ ${fields.join(', ')} }`;
}

/** The zod expression validating one field on a create or update body. */
function zodFor(field, spec) {
  if (isRef(field)) return "z.string().trim().min(1).max(64)";
  if (isEnum(field)) {
    return `z.enum([${enumValues(spec, enumName(field))
      .map((value) => `'${value}'`)
      .join(', ')}])`;
  }

  switch (field.type) {
    case 'longtext':
      return 'z.string().trim().min(1).max(4000)';
    case 'slug':
      return "z.string().trim().toLowerCase().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)";
    case 'email':
      return 'z.string().trim().toLowerCase().email().max(254)';
    case 'phone':
      return "z.string().trim().min(6).max(24).regex(/^[+()\\-. \\d]+$/)";
    case 'int':
      return 'z.coerce.number().int()';
    case 'money':
      /*
       * A string, always. A monetary value that becomes a JavaScript number on the way through a
       * browser has already lost precision before any validation runs — Phase 8's rule, reaching
       * the request boundary.
       */
      return "z.string().trim().regex(/^-?\\d{1,15}(\\.\\d{1,8})?$/, 'Must be a decimal amount.')";
    case 'bool':
      return 'z.coerce.boolean()';
    case 'date':
    case 'datetime':
      return 'z.coerce.date()';
    case 'json':
      return 'z.record(z.unknown())';
    default:
      return 'z.string().trim().min(1).max(255)';
  }
}

function controllerFile(spec) {
  const service = `${pascal(spec.id)}Service`;
  const constName = memberOf(spec).domainConst;
  const lines = [];

  lines.push(
    "import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';",
  );
  lines.push("import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';");
  lines.push("import { RequirePermissions } from '@trustos/rbac';");
  lines.push("import { OrganizationId } from '@trustos/tenancy';");
  lines.push("import { z } from '@trustos/validation';");
  lines.push("import { ZodValidationPipe } from '@trustos/validation/nest';");
  lines.push(`import { ${constName} as P } from '{{packageName}}-product-domain';`);
  lines.push('import {');
  lines.push(`  ${service},`);
  for (const entity of spec.entities) lines.push(`  type ${entity.name}Row,`);
  lines.push(`} from './${spec.id}.service';`);
  lines.push('');
  lines.push('/**');
  lines.push(` * ${spec.displayName} endpoints.`);
  lines.push(' *');
  for (const line of wrap(
    'Every route declares a permission — `PermissionsGuard` denies any route that declares none — ' +
      'and the key is the same constant the admin console reads to decide whether to show the ' +
      'screen. A guard and a menu reading different lists disagree, and the disagreement is always ' +
      'in the direction of showing somebody a screen that then refuses them.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' *');
  for (const line of wrap(
    'The organization always comes from `@OrganizationId()`, which reads what the tenant guard ' +
      'derived from the access token. It is never read from a path, a body or a header — a ' +
      'tenant id a caller can supply is not a tenant boundary.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('');

  // Body schemas, one pair per entity. Declared before the controllers so `z.infer` can name them.
  for (const entity of spec.entities) {
    const creatable = entity.fields;
    const updatable = entity.fields.filter((field) => !field.immutable);

    lines.push(`const create${entity.name}Schema = z.object({`);
    for (const field of creatable) {
      const optional = field.required ? '' : '.optional()';
      lines.push(`  ${field.name}: ${zodFor(field, spec)}${optional},`);
    }
    lines.push('});');
    lines.push('');

    if (updatable.length > 0) {
      lines.push(`const update${entity.name}Schema = z`);
      lines.push('  .object({');
      for (const field of updatable) {
        lines.push(`    ${field.name}: ${zodFor(field, spec)}.optional(),`);
      }
      lines.push('  })');
      lines.push('  /*');
      lines.push('   * Refused rather than accepted as a no-op. An empty PATCH is almost always a');
      lines.push('   * client that dropped its body, and a 200 tells it everything worked.');
      lines.push('   */');
      lines.push("  .refine((body) => Object.keys(body).length > 0, 'No fields to update.');");
      lines.push('');
    }
  }

  for (const entity of spec.entities) {
    const upper = upperOf(entity);
    const key = plural(entity.name);
    const single = pascal(entity.name);
    const listMethod = `list${plural(single).split('-').map(pascal).join('')}`;
    const updatable = entity.fields.filter((field) => !field.immutable);

    lines.push(`@ApiTags('${key}')`);
    lines.push("@ApiBearerAuth('access-token')");
    lines.push(`@Controller('${key}')`);
    lines.push(`export class ${single}Controller {`);
    lines.push(`  constructor(private readonly product: ${service}) {}`);
    lines.push('');
    lines.push('  @Get()');
    lines.push(`  @RequirePermissions(P.${upper}_READ.key)`);
    lines.push(`  @ApiOperation({ summary: 'List ${entity.label.toLowerCase()}' })`);
    lines.push(`  list(): Promise<${entity.name}Row[]> {`);
    lines.push(`    return this.product.${listMethod}();`);
    lines.push('  }');
    lines.push('');
    lines.push("  @Get(':id')");
    lines.push(`  @RequirePermissions(P.${upper}_READ.key)`);
    lines.push(`  @ApiOperation({ summary: 'Read one ${entity.singular.toLowerCase()}' })`);
    lines.push('  find(');
    lines.push("    @Param('id') id: string,");
    lines.push('    @OrganizationId() organizationId: string,');
    lines.push(`  ): Promise<${entity.name}Row> {`);
    lines.push(`    return this.product.find${single}(id, organizationId);`);
    lines.push('  }');
    lines.push('');
    lines.push('  @Post()');
    lines.push(`  @RequirePermissions(P.${upper}_CREATE.key)`);
    lines.push(`  @ApiOperation({ summary: 'Create a ${entity.singular.toLowerCase()}' })`);
    lines.push('  create(');
    lines.push('    @OrganizationId() organizationId: string,');
    lines.push(
      `    @Body(new ZodValidationPipe(create${entity.name}Schema))`,
    );
    lines.push(`    body: z.infer<typeof create${entity.name}Schema>,`);
    lines.push(`  ): Promise<${entity.name}Row> {`);
    lines.push(`    return this.product.create${single}(body, organizationId);`);
    lines.push('  }');

    if (updatable.length > 0) {
      lines.push('');
      lines.push("  @Patch(':id')");
      lines.push(`  @RequirePermissions(P.${upper}_UPDATE.key)`);
      lines.push(`  @ApiOperation({ summary: 'Modify a ${entity.singular.toLowerCase()}' })`);
      lines.push('  update(');
      lines.push("    @Param('id') id: string,");
      lines.push('    @OrganizationId() organizationId: string,');
      lines.push(
        `    @Body(new ZodValidationPipe(update${entity.name}Schema))`,
      );
      lines.push(`    body: z.infer<typeof update${entity.name}Schema>,`);
      lines.push(`  ): Promise<${entity.name}Row> {`);
      lines.push(`    return this.product.update${single}(id, body, organizationId);`);
      lines.push('  }');
    }

    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

function moduleFile(spec) {
  const service = `${pascal(spec.id)}Service`;
  const controllers = spec.entities.map((entity) => `${pascal(entity.name)}Controller`);
  const lines = [];

  lines.push("import { Module } from '@nestjs/common';");
  lines.push('import {');
  for (const controller of controllers) lines.push(`  ${controller},`);
  lines.push(`} from './${spec.id}.controller';`);
  lines.push(`import { ${service} } from './${spec.id}.service';`);
  lines.push('');
  lines.push('/**');
  lines.push(` * ${spec.displayName} domain module.`);
  lines.push(' *');
  for (const line of wrap(
    'One module per layer in the template chain. `product.module.ts` above this folder is the ' +
      'aggregator AppModule imports by a fixed name — a template extending this one adds its own ' +
      'folder beside it and lists both there, rather than editing anything in here.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('@Module({');
  lines.push('  controllers: [');
  for (const controller of controllers) lines.push(`    ${controller},`);
  lines.push('  ],');
  lines.push(`  providers: [${service}],`);
  lines.push(`  exports: [${service}],`);
  lines.push('})');
  lines.push(`export class ${pascal(spec.id)}DomainModule {}`);
  lines.push('');

  return lines.join('\n');
}

function productModuleFile(spec) {
  const chain = chainOf(spec.id).map(memberOf);
  const lines = [];

  lines.push("import { Module } from '@nestjs/common';");
  for (const member of chain) {
    lines.push(`import { ${member.moduleName} } from './${member.folder}/${member.folder}.module';`);
  }
  lines.push('');
  lines.push('/**');
  lines.push(' * The product module `AppModule` imports.');
  lines.push(' *');
  for (const line of wrap(
    chain.length > 1
      ? `An aggregator over the template chain (${chain
          .map((member) => member.id)
          .join(' -> ')}). It exists so the composition root has one fixed name to import, and so ` +
          'a layer can be added without anybody editing app.module.ts.'
      : 'An aggregator with one layer today. It exists so the composition root has one fixed name ' +
          'to import, and so a template extending this one can add a layer without editing ' +
          'app.module.ts.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('@Module({');
  lines.push('  imports: [');
  for (const member of chain) lines.push(`    ${member.moduleName},`);
  lines.push('  ],');
  lines.push('  exports: [');
  for (const member of chain) lines.push(`    ${member.moduleName},`);
  lines.push('  ],');
  lines.push('})');
  lines.push('export class ProductModule {}');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// isolation test

function isolationSpecFile(spec) {
  const service = `${pascal(spec.id)}Service`;
  const entity = spec.entities[0];
  const single = pascal(entity.name);
  const listMethod = `list${plural(single).split('-').map(pascal).join('')}`;
  const delegates = [...new Set(spec.entities.map((e) => delegate(e.name)))];

  /** A plausible value for a field, so the seeded rows are the shape the service expects. */
  const sample = (field, seed) => {
    if (isRef(field)) return `'${camel(refTarget(field))}_${seed}'`;
    if (isEnum(field)) return `'${enumValues(spec, enumName(field))[0]}'`;

    switch (field.type) {
      case 'int':
        return '1';
      case 'money':
        return "'10.00'";
      case 'bool':
        return 'false';
      case 'date':
      case 'datetime':
        return "new Date('2026-03-01T09:00:00.000Z')";
      case 'json':
        return '{}';
      case 'email':
        return `'${seed}@example.test'`;
      case 'phone':
        return "'012345678'";
      case 'slug':
        return `'${kebab(entity.name)}-${seed}'`;
      default:
        return `'${seed}'`;
    }
  };

  const rowFor = (seed, org) => {
    const parts = [`      id: '${seed}'`, `      organizationId: ${org}`];
    for (const field of entity.fields) parts.push(`      ${field.name}: ${sample(field, seed)}`);
    return `    {\n${parts.join(',\n')},\n      ...timestamps,\n    },`;
  };

  const creatable = entity.fields.filter((field) => field.required);
  const parents = entity.fields.filter(
    (field) => isRef(field) && field.required && specHasEntity(spec, refTarget(field)),
  );

  const lines = [];

  lines.push("import { beforeEach, describe, expect, it } from 'vitest';");
  lines.push("import { AuditService, InMemoryAuditSink } from '@trustos/audit';");
  lines.push("import type { ApiError } from '@trustos/errors';");
  lines.push("import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';");
  lines.push(`import { ${service} } from './${spec.id}.service';`);
  lines.push('');
  lines.push('/**');
  lines.push(' * Tenant isolation.');
  lines.push(' *');
  for (const line of wrap(
    'The quietest failure a generated application can have: a query that returns another ' +
      'organization’s rows. It breaks nothing, fails no build, and is discovered by a customer.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' *');
  for (const line of wrap(
    'The fake delegate and the tenant context come from `@trustos/tenancy` rather than being ' +
      'rebuilt here. A hand-rolled fake that ignored the scope it was passed would make this ' +
      'suite pass against a broken repository, which is worse than having no suite.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('');
  lines.push("const ACME = 'org_acme';");
  lines.push("const RIVAL = 'org_rival';");
  lines.push('');
  lines.push('const timestamps = {');
  lines.push("  createdAt: new Date('2026-01-01T00:00:00.000Z'),");
  lines.push("  updatedAt: new Date('2026-01-01T00:00:00.000Z'),");
  lines.push('  deletedAt: null,');
  lines.push('};');
  lines.push('');
  lines.push(`function buildService(): { service: ${service}; sink: InMemoryAuditSink } {`);
  lines.push('  const prisma = {');

  for (const name of delegates) {
    if (name === delegate(entity.name)) {
      lines.push(`    ${name}: new FakeModelDelegate([`);
      lines.push(rowFor('acme', 'ACME'));
      lines.push(rowFor('rival', 'RIVAL'));
      lines.push('    ]),');
    } else {
      lines.push(`    ${name}: new FakeModelDelegate([]),`);
    }
  }

  lines.push('  } as never;');
  lines.push('');
  lines.push('  const sink = new InMemoryAuditSink();');
  lines.push(`  return { service: new ${service}(prisma, new AuditService({ sink })), sink };`);
  lines.push('}');
  lines.push('');
  lines.push('const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>');
  lines.push("  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);");
  lines.push('');
  lines.push('const asRival = <T>(fn: () => Promise<T>): Promise<T> =>');
  lines.push("  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);");
  lines.push('');
  lines.push(`describe('${spec.id} tenant isolation', () => {`);
  lines.push(`  let service: ${service};`);
  lines.push('  let sink: InMemoryAuditSink;');
  lines.push('');
  lines.push('  beforeEach(() => {');
  lines.push('    ({ service, sink } = buildService());');
  lines.push('  });');
  lines.push('');
  lines.push(`  it('lists only the calling organization’s ${entity.label.toLowerCase()}', async () => {`);
  lines.push(`    expect((await asAcme(() => service.${listMethod}())).map((row) => row.id)).toEqual([`);
  lines.push("      'acme',");
  lines.push('    ]);');
  lines.push(`    expect((await asRival(() => service.${listMethod}())).map((row) => row.id)).toEqual([`);
  lines.push("      'rival',");
  lines.push('    ]);');
  lines.push('  });');
  lines.push('');
  lines.push(`  it('reports another organization’s ${entity.singular.toLowerCase()} as not_found', async () => {`);
  lines.push('    try {');
  lines.push(`      await asAcme(() => service.find${single}('rival', ACME));`);
  lines.push("      expect.unreachable('should have thrown');");
  lines.push('    } catch (error) {');
  lines.push('      // not_found rather than forbidden: a 403 would confirm the id exists.');
  lines.push("      expect((error as ApiError).code).toBe('not_found');");
  lines.push('    }');
  lines.push('  });');

  if (parents.length === 0) {
    lines.push('');
    lines.push(`  it('stamps a new ${entity.singular.toLowerCase()} with the calling organization', async () => {`);
    lines.push(`    const created = await asAcme(() =>`);
    lines.push(`      service.create${single}(`);
    lines.push('        {');
    for (const field of creatable) lines.push(`          ${field.name}: ${sample(field, 'new')},`);
    lines.push('        } as never,');
    lines.push('        ACME,');
    lines.push('      ),');
    lines.push('    );');
    lines.push('');
    lines.push('    expect(created.organizationId).toBe(ACME);');
    lines.push('  });');
    lines.push('');
    lines.push(`  it('records an audit entry for the write', async () => {`);
    lines.push('    /*');
    lines.push('     * A change with no audit row is a change nobody can answer questions about six');
    lines.push('     * months later, and the answer is always needed at the worst moment.');
    lines.push('     */');
    lines.push(`    await asAcme(() =>`);
    lines.push(`      service.create${single}(`);
    lines.push('        {');
    for (const field of creatable) lines.push(`          ${field.name}: ${sample(field, 'audited')},`);
    lines.push('        } as never,');
    lines.push('        ACME,');
    lines.push('      ),');
    lines.push('    );');
    lines.push('');
    lines.push('    expect(sink.records.map((record) => record.action)).toContain(');
    lines.push(`      '${permissionNamespace(spec)}.${kebab(entity.name)}.created',`);
    lines.push('    );');
    lines.push('  });');
  } else {
    lines.push('');
    lines.push(`  it('refuses a parent belonging to another organization', async () => {`);
    lines.push('    /*');
    lines.push('     * Without this check a caller could attach a record to a parent in another');
    lines.push('     * organization by supplying its id. The row would be stamped with the caller’s');
    lines.push('     * organization, so no isolation assertion would fail, and the data would be');
    lines.push('     * wrong in a way that is hard to unpick later.');
    lines.push('     */');
    lines.push('    await expect(');
    lines.push(`      asAcme(() =>`);
    lines.push(`        service.create${single}(`);
    lines.push('          {');
    for (const field of creatable) lines.push(`            ${field.name}: ${sample(field, 'new')},`);
    lines.push('          } as never,');
    lines.push('          ACME,');
    lines.push('        ),');
    lines.push('      ),');
    lines.push('    ).rejects.toThrow();');
    lines.push('  });');
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// shared types

function sharedTypesFile(spec) {
  const lines = [];

  lines.push('/**');
  lines.push(` * Shared types — ${spec.displayName}.`);
  lines.push(' *');
  for (const line of wrap(
    'The shapes the API returns and the admin consumes. One definition, imported by both, so a ' +
      'renamed field is a compile error rather than an empty column.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' *');
  for (const line of wrap(
    'Runtime-free by design: no imports, no side effects, nothing that could pull a server-only ' +
      'module into a browser bundle. The admin application imports this package directly, so ' +
      'anything reachable from here reaches the client.',
    94,
  )) {
    lines.push(` * ${line}`);
  }
  lines.push(' */');
  lines.push('');
  lines.push('/** ISO-8601 timestamp as it crosses the API boundary. */');
  lines.push('export type IsoDateTime = string;');
  lines.push('');
  lines.push('/** Fields every tenant-owned entity exposes. */');
  lines.push('export interface TenantOwnedSummary {');
  lines.push('  id: string;');
  lines.push('  organizationId: string;');
  lines.push('  createdAt: IsoDateTime;');
  lines.push('  updatedAt: IsoDateTime;');
  lines.push('}');
  lines.push('');

  for (const entity of spec.entities) {
    for (const line of wrap(entity.description, 94)) lines.push(`/** ${line} */`);
    lines.push(`export interface ${entity.name} {`);
    lines.push('  id: string;');
    for (const field of entity.fields) {
      const type = tsType(field, spec);
      const nullable = !field.required && field.default === undefined;
      lines.push(`  ${field.name}: ${nullable ? `${type} | null` : type};`);
    }
    lines.push('  createdAt: IsoDateTime;');
    lines.push('  updatedAt: IsoDateTime;');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// helpers

function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }

  if (line.length > 0) lines.push(line);
  return lines;
}

const firstSentence = (text) => {
  const match = /^(.*?\.)(\s|$)/s.exec(String(text).replace(/\s+/g, ' '));
  return match ? match[1] : String(text).replace(/\s+/g, ' ');
};

const titleCase = (value) =>
  value
    .split('_')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

// ---------------------------------------------------------------------------
// main

async function main() {
  let written = 0;

  for (const spec of TEMPLATE_SPECS) {
    const root = join(templatesRoot, spec.id);

    // Regenerate cleanly: a renamed entity would otherwise leave its old file behind, and a
    // stale file in a template is a file that gets generated into somebody's project.
    if (existsSync(join(root, 'files'))) await rm(join(root, 'files'), { recursive: true });

    const depth = depthOf(spec.id);
    const files = join(root, 'files');

    await write(
      join(root, 'template.json'),
      `${JSON.stringify({ id: spec.id, conditionalPaths: [] }, null, 2)}\n`,
    );

    await write(
      join(files, 'prisma/schema', `${10 + depth}-${spec.id}.prisma`),
      prismaFile(spec),
    );

    await write(join(files, 'packages/product-domain/src', `${spec.id}.ts`), domainFile(spec));
    await write(join(files, 'packages/product-domain/src/index.ts'), domainIndexFile(spec));
    await write(join(files, 'packages/shared-types/src/index.ts'), sharedTypesFile(spec));

    /*
     * `.hbs`, because the resource list imports the product-domain package by its generated
     * name. A plain `.ts` would be copied verbatim and ship a literal `{{packageName}}` into
     * somebody's project.
     */
    await write(
      join(files, 'apps/admin/src/lib', `resources-${spec.id}.ts.hbs`),
      resourcesFile(spec),
    );
    await write(join(files, 'apps/admin/src/lib/resources.ts'), resourcesIndexFile(spec));

    const moduleRoot = join(files, 'apps/api/src/modules/product', spec.id);
    await write(join(moduleRoot, `${spec.id}.service.ts`), serviceFile(spec));
    await write(join(moduleRoot, `${spec.id}.controller.ts.hbs`), controllerFile(spec));
    await write(join(moduleRoot, `${spec.id}.module.ts`), moduleFile(spec));
    await write(join(moduleRoot, 'tenant-isolation.spec.ts'), isolationSpecFile(spec));
    await write(
      join(files, 'apps/api/src/modules/product/product.module.ts'),
      productModuleFile(spec),
    );

    written += 10;
    process.stdout.write(
      `${spec.id.padEnd(20)} ${spec.entities.length} entities` +
        `${spec.extends ? `  extends ${spec.extends}` : ''}\n`,
    );
  }

  // The merchant layer gains the two aggregators it now needs as a parent.
  await write(
    join(templatesRoot, 'merchant/files/packages/product-domain/src/index.ts'),
    domainIndexFile({ id: 'merchant', displayName: 'TrustOS Merchant', entities: [] }),
  );
  await write(
    join(templatesRoot, 'merchant/files/apps/admin/src/lib/resources.ts'),
    resourcesIndexFile({ id: 'merchant', displayName: 'TrustOS Merchant', entities: [] }),
  );
  await write(
    join(templatesRoot, 'merchant/files/apps/api/src/modules/product/product.module.ts'),
    productModuleFile({ id: 'merchant', entities: [] }),
  );

  process.stdout.write(`\n${TEMPLATE_SPECS.length} templates, ~${written + 3} files.\n`);
}

await main();

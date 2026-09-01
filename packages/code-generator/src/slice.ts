import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * The CRUD slice declaration.
 *
 * One entity in, a working vertical slice out: Prisma model, DTOs, repository, service,
 * controller, tests and documentation. This is the same idea as the Phase 9 template scaffolder,
 * generalized to a single entity a developer adds to a project that already exists.
 *
 * Two properties are non-negotiable, and they are the reason a generator is safer than copying an
 * existing file:
 *
 * **Everything is tenant-scoped.** There is no flag to turn it off. A generator that could emit
 * an unscoped repository would eventually emit one, and the resulting endpoint returns every
 * tenant's rows while passing every test written against a single-tenant fixture.
 *
 * **Every write is audited and every route carries a permission.** Both derived from the
 * declaration, so neither can be forgotten. The most common defect in hand-written CRUD is the
 * fourth endpoint — the one added a month later — that has neither.
 *
 * The generator emits *files as data*. It writes nothing. The caller decides where they go, which
 * is what makes `--dry-run` the same code path as the real run.
 */

export const FIELD_TYPES = [
  'text',
  'longtext',
  'slug',
  'email',
  'phone',
  'int',
  'money',
  'bool',
  'date',
  'datetime',
  'json',
  'enum',
  'reference',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export const fieldSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'lowerCamelCase.'),
    label: z.string().min(1).max(80),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    unique: z.boolean().default(false),
    immutable: z.boolean().default(false),
    /** `enum` only. */
    values: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
    /** `reference` only: the entity referred to. */
    references: z.string().max(60).optional(),
    /** Personal data: gets its own permission and is projected away without it. */
    pii: z.boolean().default(false),
    /** Never returned, never logged, never audited. */
    sensitive: z.boolean().default(false),
    default: z.string().max(80).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === 'enum' && field.values.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'An enum field needs values. Validating against nothing accepts everything.',
      });
    }

    if (field.type === 'reference' && !field.references) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['references'],
        message: 'A reference field must say what it refers to.',
      });
    }
  });

export type Field = z.infer<typeof fieldSchema>;

export const sliceSchema = z
  .object({
    /** PascalCase entity name. */
    entity: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'PascalCase.'),
    /** Plural URL segment, kebab-case. */
    plural: z.string().regex(/^[a-z][a-z0-9-]*$/, 'kebab-case plural.'),
    label: z.string().min(1).max(80),
    singular: z.string().min(1).max(80),
    description: z.string().min(1).max(300),
    /** Permission namespace, e.g. `crm`. Keys become `<namespace>.<entity>.<action>`. */
    namespace: z.string().regex(/^[a-z][a-z0-9]*$/, 'lowercase.'),
    fields: z.array(fieldSchema).min(1),
    /** Which operations to generate. Delete is off by default — see `assertDeletable`. */
    operations: z
      .array(z.enum(['list', 'read', 'create', 'update', 'delete']))
      .default(['list', 'read', 'create', 'update']),
    /** Package name of the host project, for import specifiers. */
    packageName: z.string().min(1).max(80).default('app'),
  })
  .strict()
  .superRefine((slice, ctx) => {
    const names = slice.fields.map((field) => field.name);

    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields'],
        message: 'Duplicate field name.',
      });
    }

    for (const reserved of ['id', 'organizationId', 'createdAt', 'updatedAt', 'deletedAt']) {
      if (names.includes(reserved)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields'],
          message: `"${reserved}" is generated on every entity; declaring it again shadows the one that works.`,
        });
      }
    }

    if (slice.fields.every((field) => !field.required)) {
      /*
       * An entity where nothing is required is an entity where an empty POST creates a row. Not
       * always wrong, but wrong often enough that it should be a decision rather than an
       * oversight.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields'],
        message:
          'No field is required, so an empty request would create a row. Mark at least one field ' +
          'required.',
      });
    }
  });

export type Slice = z.infer<typeof sliceSchema>;

export function parseSlice(raw: unknown): Slice {
  return sliceSchema.parse(raw);
}

/**
 * Refuses to generate a hard delete.
 *
 * Every generated entity carries `deletedAt` and every query filters on it, so "delete" means
 * soft delete. A generator that emitted a `DELETE` removing the row would remove the audit
 * trail's subject along with it, and the audit entry recording the deletion would point at
 * nothing.
 */
export function assertDeletable(slice: Slice): void {
  if (!slice.operations.includes('delete')) return;

  if (slice.fields.some((field) => field.sensitive)) {
    throw ApiError.validation(
      [
        {
          path: 'operations',
          message:
            `${slice.entity} has sensitive fields and a delete operation. Generated deletes are ` +
            'soft, so the sensitive data would remain in the table. Either drop the delete or ' +
            'handle erasure explicitly.',
          code: 'unsafe_delete',
        },
      ],
      'Unsafe delete.',
    );
  }
}

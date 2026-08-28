import { z } from 'zod';
import { emailSchema, idSchema, slugSchema } from '@trustos/validation';

/**
 * Forms, and the validation derived from them.
 *
 * One declaration produces both the form and the schema that guards the endpoint behind it. The
 * alternative — a form in the admin and a DTO in the API — is two descriptions of the same rule
 * that agree on the day they are written and diverge on the first change. The symptom is always
 * the same: a field the UI accepts and the API rejects, reported as "the save button doesn't
 * work".
 *
 * Deriving the schema *from* the form rather than the other way round is deliberate. A schema
 * knows a field is a string of at most 120 characters; it does not know the field is a phone
 * number, that it belongs in the "Contact" group, or what the help text says. Going in this
 * direction keeps everything in one place; going the other way needs a second file to hold what
 * was lost.
 *
 * The generated schema is the *floor*, not the ceiling — cross-field rules (an end date after a
 * start date) still belong in a `superRefine` the template writes. `buildFormSchema` returns a
 * `ZodObject` precisely so it can be extended.
 */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'number'
  | 'integer'
  | 'money'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multiselect'
  | 'reference'
  | 'slug'
  | 'json';

export interface SelectOption {
  value: string;
  label: string;
  /** Shown but not selectable — keeps a retired option readable on historical records. */
  disabled?: boolean;
}

export interface FormField {
  name: string;
  label: string;
  type: FieldType;
  /**
   * Whether a value must be supplied.
   *
   * Optional by default. A field that is required by accident blocks a save with a message
   * nobody wrote, and the shape of a domain is usually "a few things we must have and many we
   * would like".
   */
  required?: boolean;
  help?: string;
  placeholder?: string;
  /** Text/textarea length bounds, and number bounds. */
  min?: number;
  max?: number;
  /** `select` and `multiselect` only. */
  options?: SelectOption[];
  /** `reference` only: the resource key this field points at. */
  resource?: string;
  /** Cannot be edited after creation. Rendered read-only; stripped from the update schema. */
  immutable?: boolean;
  /** Grouping label, for a form long enough to need sections. */
  group?: string;
  defaultValue?: string | number | boolean;
  /**
   * Never returned by the API and never logged.
   *
   * The SDK does not encrypt anything — it marks the field so the table, the export and the
   * audit trail can all agree to leave it out. One flag read by three consumers beats three
   * lists that drift.
   */
  sensitive?: boolean;
}

export interface FormDefinition {
  key: string;
  title: string;
  description?: string;
  fields: FormField[];
  /** Permission required to submit. The API must check the same key. */
  permission?: string;
}

/** The zod type for one field, before required/optional is applied. */
function baseSchemaFor(field: FormField): z.ZodTypeAny {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return z
        .string()
        .trim()
        .min(field.min ?? 1)
        .max(field.max ?? (field.type === 'textarea' ? 4000 : 255));

    case 'email':
      return emailSchema;

    case 'phone':
      /*
       * Deliberately permissive: digits, spaces and the punctuation phone numbers are written
       * with, 6 to 24 characters. A strict E.164 rule rejects every number a Cambodian user
       * actually types, and a template that cannot store its customers' phone numbers is not a
       * template anyone keeps.
       */
      return z
        .string()
        .trim()
        .min(6)
        .max(24)
        .regex(/^[+()\-. \d]+$/, 'May contain digits, spaces and + ( ) - . only.');

    case 'number':
      return z.coerce
        .number()
        .min(field.min ?? Number.MIN_SAFE_INTEGER)
        .max(field.max ?? Number.MAX_SAFE_INTEGER);

    case 'integer':
      return z.coerce
        .number()
        .int()
        .min(field.min ?? Number.MIN_SAFE_INTEGER)
        .max(field.max ?? Number.MAX_SAFE_INTEGER);

    case 'money':
      /*
       * A string, always.
       *
       * Phase 8's rule reaching the form layer: a monetary value that becomes a JavaScript
       * number on the way through a browser has already lost precision before any validation
       * runs. `@trustos/financial-core` parses this string into an exact decimal.
       */
      return z
        .string()
        .trim()
        .regex(/^-?\d{1,15}(\.\d{1,8})?$/, 'Must be a decimal amount such as 1250.00.');

    case 'boolean':
      return z.coerce.boolean();

    case 'date':
    case 'datetime':
      return z.coerce.date();

    case 'select':
      return optionSchema(field);

    case 'multiselect':
      return z.array(optionSchema(field)).max(field.max ?? 50);

    case 'reference':
      return idSchema;

    case 'slug':
      return slugSchema;

    case 'json':
      return z.record(z.unknown());
  }
}

function optionSchema(field: FormField): z.ZodTypeAny {
  const values = (field.options ?? []).map((option) => option.value);

  if (values.length === 0) {
    throw new Error(
      `Field "${field.name}" is a ${field.type} with no options. An empty select renders as a ` +
        'control the user cannot satisfy, and validating against nothing accepts everything.',
    );
  }

  return z.enum(values as [string, ...string[]]);
}

/**
 * The schema for creating a record through this form.
 *
 * `.strict()` so an unexpected key is an error rather than a silently dropped field — the
 * failure mode that check exists for is a renamed field where the client keeps sending the old
 * name and the value quietly stops being saved.
 */
export function buildFormSchema(form: FormDefinition): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};

  for (const field of form.fields) {
    const base = baseSchemaFor(field);

    shape[field.name] = field.required
      ? base
      : field.defaultValue !== undefined
        ? base.optional().default(field.defaultValue)
        : base.optional();
  }

  return z.object(shape).strict();
}

/**
 * The schema for updating an existing record.
 *
 * Every field optional (a PATCH sends what changed), and immutable fields removed entirely
 * rather than ignored. Accepting-and-ignoring is worse than refusing: the caller believes the
 * change was applied.
 */
export function buildUpdateSchema(form: FormDefinition): z.ZodObject<z.ZodRawShape> {
  const editable = form.fields.filter((field) => !field.immutable);

  if (editable.length === 0) {
    throw new Error(
      `Form "${form.key}" has no editable fields, so there is nothing to update. Drop the update ` +
        'endpoint rather than shipping one that can only ever be a no-op.',
    );
  }

  const shape: z.ZodRawShape = {};
  for (const field of editable) shape[field.name] = baseSchemaFor(field).optional();

  return z.object(shape).strict();
}

/** Fields in declaration order, grouped. Ungrouped fields come first under an empty label. */
export function groupFields(form: FormDefinition): Array<{ group: string; fields: FormField[] }> {
  const groups = new Map<string, FormField[]>();

  for (const field of form.fields) {
    const key = field.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), field]);
  }

  return [...groups.entries()].map(([group, fields]) => ({ group, fields }));
}

/** Strips every field marked `sensitive`. Applied before returning, logging or exporting a row. */
export function redactSensitive<T extends Record<string, unknown>>(
  form: FormDefinition,
  row: T,
): Partial<T> {
  const sensitive = new Set(
    form.fields.filter((field) => field.sensitive).map((field) => field.name),
  );

  if (sensitive.size === 0) return row;

  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !sensitive.has(key)),
  ) as Partial<T>;
}

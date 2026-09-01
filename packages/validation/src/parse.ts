import { ApiError, type ValidationDetail } from '@trustsystem/errors';
import { z } from 'zod';

/**
 * Translates a ZodError into the framework's field-error shape.
 *
 * Paths are joined with dots (`address.city`, `items.0.sku`) so a form can
 * match a detail to an input without parsing an array.
 */
export function toValidationDetails(error: z.ZodError): ValidationDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Parses `input` or throws `ApiError('validation_error')`.
 *
 * This is the only sanctioned way to get from untrusted input to a typed
 * value. Product code must not hand-roll validation or trust a cast.
 */
export function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
  message?: string,
): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw ApiError.validation(toValidationDetails(result.error), message);
}

/** Non-throwing variant for call sites that branch on validity. */
export function tryParse<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): { ok: true; data: z.infer<TSchema> } | { ok: false; details: ValidationDetail[] } {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, details: toValidationDetails(result.error) };
}

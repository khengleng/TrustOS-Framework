import { z } from 'zod';

/**
 * Shared primitives. Product schemas should compose these rather than
 * redefining "what a valid email looks like" per module.
 */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Must be a valid email address.');

/**
 * Password policy.
 *
 * Length is the dominant factor in resistance to offline cracking, so the
 * floor is 12 rather than 8. Composition rules are kept mild on purpose —
 * they push users toward predictable substitutions when made stricter.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  // bcrypt silently truncates beyond 72 bytes; the cap keeps that surprise out
  // of reach and bounds the hashing cost of a hostile request.
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`)
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value), {
    message: 'Password must contain both uppercase and lowercase letters.',
  })
  .refine((value) => /\d/.test(value), { message: 'Password must contain at least one digit.' });

/** Prisma generates CUIDs; accept any opaque, reasonably sized identifier. */
export const idSchema = z.string().trim().min(1).max(64);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Must be lowercase alphanumeric words separated by hyphens.',
  );

export const displayNameSchema = z.string().trim().min(1).max(120);

export const organizationNameSchema = z.string().trim().min(2).max(120);

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Converts an arbitrary name into a URL-safe slug. */
export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      // strip combining diacritics left behind by NFKD
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
  );
}

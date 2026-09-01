import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isApiError, type ApiError } from '@trustsystem/errors';
import { parseOrThrow, tryParse } from './parse';
import { emailSchema, passwordSchema, paginationQuerySchema, slugify } from './schemas';

describe('parseOrThrow', () => {
  it('returns the parsed value, not the raw input', () => {
    const schema = z.object({ email: emailSchema });
    expect(parseOrThrow(schema, { email: '  Ada@Example.COM ' })).toEqual({
      email: 'ada@example.com',
    });
  });

  it('strips unknown keys so callers cannot smuggle fields into a write', () => {
    const schema = z.object({ name: z.string() });
    const parsed = parseOrThrow(schema, { name: 'Acme', organizationId: 'org_other' });
    expect(parsed).toEqual({ name: 'Acme' });
    expect('organizationId' in parsed).toBe(false);
  });

  it('throws a validation_error carrying dotted field paths', () => {
    const schema = z.object({ address: z.object({ city: z.string() }) });
    try {
      parseOrThrow(schema, { address: {} });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      const apiError = error as ApiError;
      expect(apiError.code).toBe('validation_error');
      expect(apiError.status).toBe(422);
      expect(apiError.details?.[0]?.path).toBe('address.city');
    }
  });
});

describe('tryParse', () => {
  it('reports failure without throwing', () => {
    const result = tryParse(z.string().email(), 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.details).toHaveLength(1);
  });
});

describe('passwordSchema', () => {
  it.each([
    ['Short1aaaa', 'shorter than 12 characters'],
    ['alllowercase123', 'no uppercase'],
    ['NoDigitsHereAtAll', 'no digit'],
  ])('rejects %s (%s)', (candidate) => {
    expect(passwordSchema.safeParse(candidate).success).toBe(false);
  });

  it('accepts a compliant password', () => {
    expect(passwordSchema.safeParse('CorrectHorse7Battery').success).toBe(true);
  });

  it('rejects passwords past the bcrypt-safe ceiling', () => {
    expect(passwordSchema.safeParse(`Aa1${'x'.repeat(200)}`).success).toBe(false);
  });
});

describe('paginationQuerySchema', () => {
  it('coerces query strings and applies defaults', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '10' })).toEqual({
      page: 3,
      pageSize: 10,
    });
  });

  it('caps page size so a caller cannot request the whole table', () => {
    expect(paginationQuerySchema.safeParse({ pageSize: '100000' }).success).toBe(false);
  });
});

describe('slugify', () => {
  it('produces URL-safe slugs', () => {
    expect(slugify('Wing Bank  (Cambodia) Plc.')).toBe('wing-bank-cambodia-plc');
    expect(slugify('Café Münchén')).toBe('cafe-munchen');
  });
});

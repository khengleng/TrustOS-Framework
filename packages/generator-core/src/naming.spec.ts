import { describe, expect, it } from 'vitest';
import {
  RESERVED_NAMES,
  assertSafeValue,
  assertValidApplicationName,
  assertValidDisplayText,
  assertValidPackageName,
  assertValidPort,
  parseRoleList,
} from './naming';
import type { GeneratorError } from './errors';

describe('assertValidApplicationName', () => {
  it('accepts lowercase, hyphenated names', () => {
    expect(assertValidApplicationName('merchant-portal')).toBe('merchant-portal');
    expect(assertValidApplicationName('  paykh  ')).toBe('paykh');
    expect(assertValidApplicationName('app2')).toBe('app2');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['Merchant', 'uppercase'],
    ['my_app', 'underscore'],
    ['my app', 'space'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['double--hyphen', 'consecutive hyphens'],
    ['../escape', 'traversal'],
    ['/absolute', 'absolute'],
    ['a/b', 'separator'],
    ['app.name', 'dot'],
  ])('rejects %s (%s)', (candidate) => {
    expect(() => assertValidApplicationName(candidate)).toThrow();
  });

  it('rejects a name longer than 64 characters', () => {
    expect(() => assertValidApplicationName('a'.repeat(65))).toThrowError(/64 characters/);
  });

  it('rejects reserved names that would break the file system or resolution', () => {
    for (const reserved of ['dist', 'src', 'con', 'nul', 'lpt1', 'trustos']) {
      expect(() => assertValidApplicationName(reserved)).toThrowError(/reserved/);
    }
  });

  it('rejects node_modules — via the charset rule, which fires first', () => {
    // Worth pinning: the underscore makes it fail as a malformed name rather
    // than as a reserved one. Either way it cannot be created.
    expect(() => assertValidApplicationName('node_modules')).toThrowError(
      /Invalid application name/,
    );
  });

  it('lists a hint on the traversal case, since it is the likely typo', () => {
    try {
      assertValidApplicationName('../evil');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GeneratorError).hint).toContain('lowercase letters');
    }
  });
});

describe('assertValidPackageName', () => {
  it('accepts plain and scoped names', () => {
    expect(assertValidPackageName('my-product')).toBe('my-product');
    expect(assertValidPackageName('@acme/merchant')).toBe('@acme/merchant');
    expect(assertValidPackageName('a.b-c_d')).toBe('a.b-c_d');
  });

  it.each([
    ['', 'empty'],
    ['MyProduct', 'uppercase'],
    ['.hidden', 'leading dot'],
    ['_private', 'leading underscore'],
    ['@scope', 'scope with no name'],
    ['@/name', 'empty scope'],
    ['has space', 'space'],
    ['../evil', 'traversal'],
  ])('rejects %s (%s)', (candidate) => {
    expect(() => assertValidPackageName(candidate)).toThrow();
  });

  it('rejects a reserved unscoped name even inside a scope', () => {
    expect(() => assertValidPackageName('@acme/node_modules')).toThrowError(/reserved/);
  });

  it('rejects a name past the npm length limit', () => {
    expect(() => assertValidPackageName('a'.repeat(215))).toThrowError(/214/);
  });
});

describe('assertSafeValue', () => {
  it('accepts ordinary text, including punctuation and non-ASCII', () => {
    expect(() => assertSafeValue('displayName', 'Wing Bank (Cambodia) Plc.')).not.toThrow();
    expect(() => assertSafeValue('displayName', 'ធនាគារវីង')).not.toThrow();
    expect(() => assertSafeValue('displayName', "O'Brien & Sons")).not.toThrow();
  });

  it('rejects values that could break out of a generated string literal', () => {
    // These land inside TypeScript and JSON files verbatim.
    expect(() => assertSafeValue('displayName', 'evil`code`')).toThrowError(/backticks/);
    expect(() => assertSafeValue('displayName', 'x${process.exit()}')).toThrowError(
      /template-literal/,
    );
  });

  it('rejects values that would be re-interpreted by the template engine', () => {
    expect(() => assertSafeValue('displayName', '{{constructor}}')).toThrowError(/Handlebars/);
  });

  it('rejects script tags and control characters', () => {
    expect(() => assertSafeValue('displayName', '<script>alert(1)</script>')).toThrowError(
      /script tags/,
    );
    expect(() => assertSafeValue('displayName', 'line\u0007break')).toThrowError(
      /control characters/,
    );
  });

  it('ignores non-string values', () => {
    expect(() => assertSafeValue('port', 3000)).not.toThrow();
    expect(() => assertSafeValue('flag', true)).not.toThrow();
  });
});

describe('assertValidDisplayText', () => {
  it('trims and enforces a maximum', () => {
    expect(assertValidDisplayText('Name', '  Acme  ')).toBe('Acme');
    expect(() => assertValidDisplayText('Name', '')).toThrowError(/required/);
    expect(() => assertValidDisplayText('Name', 'a'.repeat(201))).toThrowError(/200 characters/);
  });

  it('applies the safe-value rules too', () => {
    expect(() => assertValidDisplayText('Name', 'a`b')).toThrowError(/backticks/);
  });
});

describe('assertValidPort', () => {
  it('accepts a valid port and rejects everything else', () => {
    expect(assertValidPort(3000)).toBe(3000);
    expect(assertValidPort(1)).toBe(1);
    expect(assertValidPort(65535)).toBe(65535);

    for (const invalid of [0, -1, 65536, 3000.5, Number.NaN]) {
      expect(() => assertValidPort(invalid)).toThrowError(/Invalid port/);
    }
  });
});

describe('parseRoleList', () => {
  it('splits, trims and de-duplicates', () => {
    expect(parseRoleList('owner, admin ,owner')).toEqual(['owner', 'admin']);
  });

  it('rejects an empty list', () => {
    expect(() => parseRoleList('  ,  ')).toThrowError(/At least one role/);
  });

  it.each(['Admin', '1admin', 'admin-role', 'admin role'])('rejects the role name %s', (role) => {
    expect(() => parseRoleList(role)).toThrowError(/Invalid role name/);
  });

  it('accepts snake_case role names', () => {
    expect(parseRoleList('store_manager,branch_lead')).toEqual(['store_manager', 'branch_lead']);
  });
});

describe('RESERVED_NAMES', () => {
  it('covers the Windows device names that cannot be created or deleted', () => {
    for (const device of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt1']) {
      expect(RESERVED_NAMES.has(device)).toBe(true);
    }
  });
});

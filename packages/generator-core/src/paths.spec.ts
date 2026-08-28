import { describe, expect, it } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { isInside, resolveWithin, toPosixPath } from './paths';
import type { GeneratorError } from './errors';

/**
 * Path containment tests.
 *
 * This is the generator's single most important invariant: no write ever lands
 * outside the project directory. Everything here is a negative test, because
 * the failure mode is writing somewhere you did not intend.
 */

const ROOT = resolve('/tmp/trustos-project');

describe('resolveWithin', () => {
  it('resolves an ordinary relative path inside the root', () => {
    expect(resolveWithin(ROOT, 'apps/api/src/main.ts')).toBe(
      join(ROOT, 'apps', 'api', 'src', 'main.ts'),
    );
  });

  it('allows traversal that stays inside the root', () => {
    // `a/../b` is fine: it normalizes to `b`, still contained.
    expect(resolveWithin(ROOT, 'apps/../packages/x.ts')).toBe(join(ROOT, 'packages', 'x.ts'));
  });

  it.each([
    ['../escape.ts', 'one level up'],
    ['../../etc/passwd', 'two levels up'],
    ['apps/../../escape.ts', 'up through a subdirectory'],
    ['a/b/c/../../../../escape.ts', 'deep traversal'],
    ['./../../escape.ts', 'leading dot then traversal'],
  ])('refuses %s (%s)', (candidate) => {
    expect(() => resolveWithin(ROOT, candidate)).toThrowError(/outside the project directory/);
  });

  it('refuses an absolute path', () => {
    expect(() => resolveWithin(ROOT, '/etc/passwd')).toThrowError(/absolute path/);
  });

  it('refuses a drive-qualified path', () => {
    expect(() => resolveWithin(ROOT, 'C:/Windows/System32/x')).toThrowError(/drive-qualified/);
  });

  it('refuses a path containing a null byte', () => {
    expect(() => resolveWithin(ROOT, 'apps/api\u0000.ts')).toThrowError(/null byte/);
  });

  it('reports unsafe_path as the error code, so the CLI can phrase it', () => {
    try {
      resolveWithin(ROOT, '../escape.ts');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GeneratorError).code).toBe('unsafe_path');
    }
  });
});

describe('isInside', () => {
  it('accepts the root itself and anything below it', () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
    expect(isInside(ROOT, join(ROOT, 'a', 'b'))).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    // The reason the check compares path segments rather than string prefixes:
    // "/tmp/trustos-project-evil" starts with "/tmp/trustos-project".
    expect(isInside(ROOT, `${ROOT}-evil`)).toBe(false);
    expect(isInside(ROOT, `${ROOT}-evil/file.ts`)).toBe(false);
  });

  it('rejects a parent and an unrelated path', () => {
    expect(isInside(ROOT, resolve(ROOT, '..'))).toBe(false);
    expect(isInside(ROOT, '/etc')).toBe(false);
  });
});

describe('toPosixPath', () => {
  it('normalizes separators so paths sort and compare identically everywhere', () => {
    expect(toPosixPath(['apps', 'api', 'main.ts'].join(sep))).toBe('apps/api/main.ts');
  });
});

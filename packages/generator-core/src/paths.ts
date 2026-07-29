import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { GeneratorError } from './errors';

/**
 * File-system containment.
 *
 * The single invariant of the generator: **no write ever lands outside the
 * project directory**. Everything else — dry-run, rollback, determinism — is a
 * convenience. This is the part that must not have a hole.
 *
 * The check is done on the *resolved* path rather than by pattern-matching the
 * input, because there is no reliable way to enumerate the strings that mean
 * "go up a level" across platforms. `a/../../b`, `a/b/../../../c` and an
 * absolute path all normalize to something outside the root, and the resolved
 * comparison catches all of them without needing to recognise any of them.
 */

/**
 * Resolves `relativePath` inside `root`, or throws.
 *
 * Rejects absolute paths, traversal, and null bytes. Returns an absolute path
 * guaranteed to be at or below `root`.
 */
export function resolveWithin(root: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new GeneratorError('unsafe_path', 'Path contains a null byte.');
  }

  if (isAbsolute(relativePath)) {
    throw new GeneratorError(
      'unsafe_path',
      `Refusing absolute path "${relativePath}".`,
      'Template paths must be relative to the project root.',
    );
  }

  // Windows drive-relative ("C:foo") and UNC-ish inputs normalize
  // unpredictably; reject the colon outright rather than reason about it.
  if (/^[a-zA-Z]:/.test(relativePath)) {
    throw new GeneratorError('unsafe_path', `Refusing drive-qualified path "${relativePath}".`);
  }

  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, normalize(relativePath));

  if (!isInside(absoluteRoot, candidate)) {
    throw new GeneratorError(
      'unsafe_path',
      `Refusing to write outside the project directory: "${relativePath}".`,
      'This is almost always a malformed template path.',
    );
  }

  return candidate;
}

/**
 * True when `candidate` is `root` itself or below it.
 *
 * Compares path segments rather than string prefixes: `/tmp/app-evil` starts
 * with `/tmp/app` as a string but is not inside it.
 */
export function isInside(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);

  if (absoluteRoot === absoluteCandidate) return true;

  const rel = relative(absoluteRoot, absoluteCandidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Normalizes a template-relative path to POSIX separators.
 *
 * Template trees are authored on macOS and Linux and generated on Windows too;
 * comparing and sorting paths is only deterministic in one separator style.
 */
export function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

export function fromPosixPath(value: string): string {
  return value.split('/').join(sep);
}

/** Joins POSIX-style template path segments. */
export function joinPosix(...segments: string[]): string {
  return toPosixPath(join(...segments));
}

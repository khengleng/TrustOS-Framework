import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { ApiError } from '@trustos/errors';

/**
 * Storage keys and filesystem containment.
 *
 * This is the sharpest edge in the module system: a storage key comes from a
 * caller, and the local provider turns it into a filesystem path. Two separate
 * controls apply, and neither is sufficient alone.
 *
 *   1. **Key shape.** A key is validated against a deliberately narrow grammar
 *      before it is used for anything. Rejecting `..`, absolute paths, null
 *      bytes and control characters up front means the dangerous strings never
 *      reach path handling.
 *
 *   2. **Resolved containment.** Even a key that passed validation is resolved
 *      and re-checked against the storage root, because there is no reliable way
 *      to enumerate every string that means "go up a level" across platforms.
 *      The resolved comparison catches all of them without recognising any.
 *
 * On top of both, every key is namespaced by organization, so a key that somehow
 * escaped its intended prefix would still be inside another tenant's namespace
 * rather than in a shared one — and `assertKeyBelongsTo` refuses that too.
 */

/**
 * Key grammar: segments of letters, digits, dot, underscore and hyphen,
 * separated by single forward slashes.
 *
 * A leading dot is rejected, which stops both `..` and dotfiles. No spaces, no
 * backslashes, no colons, no encoded characters — a caller that needs a display
 * name stores it as metadata, not as a path.
 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_KEY_LENGTH = 512;

export function isValidKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (key.includes('\0')) return false;
  // Escapes rather than literal bytes, so the intent survives an editor that
  // normalizes whitespace.
  // eslint-disable-next-line no-control-regex -- a control character in a path is never legitimate
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  if (isAbsolute(key) || key.startsWith('/') || key.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(key)) return false;

  const segments = key.split('/');
  return segments.every((segment) => KEY_SEGMENT.test(segment));
}

export function assertValidKey(key: string): string {
  if (isValidKey(key)) return key;

  throw ApiError.validation(
    [{ path: 'key', message: 'Not a valid storage key.' }],
    'The storage key is not valid.',
  );
}

/** `org/<organizationId>/` — the namespace every key of a tenant sits under. */
export function organizationPrefix(organizationId: string): string {
  assertValidKey(organizationId);
  return `org/${organizationId}/`;
}

/**
 * Builds the full key for one organization.
 *
 * Callers supply the part after the prefix; the prefix is added here so a caller
 * cannot choose which tenant namespace it writes into.
 */
export function tenantKey(organizationId: string, key: string): string {
  return `${organizationPrefix(organizationId)}${assertValidKey(key)}`;
}

/**
 * Refuses a key that is not inside the organization namespace.
 *
 * Reported as `not_found` rather than `forbidden`: a 403 on another tenant's key
 * confirms it exists, which turns the storage API into an enumeration oracle —
 * the same reasoning the framework applies to row lookups.
 */
export function assertKeyBelongsTo(organizationId: string, fullKey: string): string {
  const prefix = organizationPrefix(organizationId);
  if (assertValidKey(fullKey).startsWith(prefix)) return fullKey;

  throw ApiError.notFound(undefined, {
    reason: 'cross_tenant_storage_key_blocked',
    expectedPrefix: prefix,
  });
}

/**
 * Resolves `key` under `root`, or throws.
 *
 * The second control described in the header. Kept separate from key validation
 * so that a provider using a different key source still cannot escape.
 */
export function resolveWithinRoot(root: string, key: string): string {
  assertValidKey(key);

  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, normalize(key));

  if (!isInside(absoluteRoot, candidate)) {
    throw ApiError.internal('Refusing to touch a path outside the storage root.');
  }
  return candidate;
}

/**
 * True when `candidate` is `root` or below it.
 *
 * Compares path segments rather than string prefixes: `/data/store-evil` starts
 * with `/data/store` as a string but is not inside it.
 */
export function isInside(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);

  if (absoluteRoot === absoluteCandidate) return true;

  const rel = relative(absoluteRoot, absoluteCandidate);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

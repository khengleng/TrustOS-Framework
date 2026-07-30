import { ApiError } from '@trustos/errors';

/**
 * Scopes.
 *
 * `resource:action`, deliberately coarse. A scope is not a permission: permissions
 * describe what an organization's members may do and are managed by roles, while a
 * scope narrows what one *credential* may do with them. Both are checked, and a
 * read-scoped key held by an owner still cannot write.
 *
 * The example set below is generic on purpose. `payments:write` is an illustration,
 * not a payments feature — this phase is about the mechanism, and a product defines
 * its own resources. What the framework fixes is the *shape*, so a scanner, a
 * console and an authorization policy can reason about any of them.
 */

/**
 * Example scopes.
 *
 * Every resource has `read` and `write`; a resource that needs a third verb gets a
 * named one, as `webhooks:manage` does. Two verbs cover almost everything, and a
 * scope vocabulary that grows a verb per endpoint stops being reviewable.
 */
export const EXAMPLE_SCOPES = [
  'payments:read',
  'payments:write',
  'merchants:read',
  'merchants:write',
  'reports:read',
  'webhooks:manage',
] as const;

export type ExampleScope = (typeof EXAMPLE_SCOPES)[number];

/** `resource:action`, lowercase, with `*` permitted as the action. */
const SCOPE_PATTERN = /^[a-z][a-z0-9-]{1,40}:(read|write|manage|\*)$/;

export function isValidScope(scope: string): boolean {
  return scope === '*' || SCOPE_PATTERN.test(scope);
}

/**
 * Validates a requested scope list against what the framework accepts.
 *
 * `*` is rejected here even though `scopeMatches` understands it. A wildcard scope
 * is a key with no restriction at all, and if it is ever wanted it should be a
 * deliberate exception at a call site rather than something a caller can ask for
 * through the API.
 */
export function assertValidScopes(scopes: string[], allowed?: readonly string[]): string[] {
  const problems: Array<{ path: string; message: string }> = [];

  if (scopes.length === 0) {
    // A key with no scopes could do nothing, so asking for one is a mistake worth
    // naming rather than a key worth creating.
    problems.push({ path: 'scopes', message: 'At least one scope is required.' });
  }

  const seen = new Set<string>();
  for (const scope of scopes) {
    if (scope === '*') {
      problems.push({
        path: 'scopes',
        message: 'The wildcard scope cannot be requested. Name the scopes the key needs.',
      });
      continue;
    }
    if (!isValidScope(scope)) {
      problems.push({ path: 'scopes', message: `"${scope}" is not a valid scope.` });
      continue;
    }
    if (allowed && !allowed.includes(scope)) {
      problems.push({
        path: 'scopes',
        message: `"${scope}" is not a scope this application offers.`,
      });
      continue;
    }
    if (seen.has(scope)) continue;
    seen.add(scope);
  }

  if (problems.length > 0) {
    throw ApiError.validation(problems, 'The requested scopes are not valid.');
  }

  return [...seen].sort();
}

/**
 * Whether a held scope list satisfies a requirement.
 *
 * Two implications, both to stop a configuration burden being solved by granting
 * everything:
 *
 *   `resource:*`      covers every action on that resource
 *   `resource:write`  covers `resource:read`
 *
 * The second is worth stating: a credential that may change something can
 * necessarily observe it, and requiring both on every key means every key
 * eventually gets a wildcard.
 */
export function scopeSatisfies(held: readonly string[], required: string): boolean {
  const [neededResource, neededAction] = required.split(':');

  return held.some((grant) => {
    if (grant === '*' || grant === required) return true;

    const [grantResource, grantAction] = grant.split(':');
    if (grantResource !== neededResource) return false;

    if (grantAction === '*') return true;
    return grantAction === 'write' && neededAction === 'read';
  });
}

/** Whether every requirement is satisfied. */
export function scopesSatisfyAll(held: readonly string[], required: readonly string[]): boolean {
  return required.every((requirement) => scopeSatisfies(held, requirement));
}

/**
 * Throws unless the credential's scopes cover the requirement.
 *
 * The error names the required scope, which is safe and useful: a scope is part of
 * the documented API surface, and an integrator who cannot see which one they are
 * missing has to guess. That is different from a permission, where the same
 * disclosure would map out an internal model.
 */
export function assertScope(held: readonly string[], required: string): void {
  if (scopeSatisfies(held, required)) return;

  throw ApiError.forbidden(`This credential does not have the "${required}" scope.`, {
    reason: 'scope_not_granted',
    requiredScope: required,
    // The held scopes go to the log, not the response: the set a credential holds
    // is not something a caller who is missing one needs to be told.
    heldScopes: held,
  });
}

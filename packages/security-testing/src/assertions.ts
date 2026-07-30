import { isSecretFieldName } from '@trustos/security-policy';

/**
 * Assertions a security suite needs, expressed so a failure says what went wrong.
 *
 * The redaction assertions matter most. "No secret is logged" is a claim every project
 * makes and few test, because testing it means knowing what a secret looks like — and
 * the thing that actually leaks is never the field somebody thought about. So these
 * search a serialized structure for *values* that were handed in, which catches a
 * secret that reached a field nobody added to a redaction list.
 */

export interface LeakFinding {
  path: string;
  value: string;
}

/**
 * Finds a literal value anywhere in a structure.
 *
 * By value, not by field name, and that is the point: a redaction list covers the
 * fields somebody remembered, and this covers the ones they did not. A token that ends
 * up in `context.detail` is found even though `detail` is not a secret-looking name.
 */
export function findLeakedValues(subject: unknown, secrets: string[]): LeakFinding[] {
  const serialized = JSON.stringify(subject) ?? '';
  const findings: LeakFinding[] = [];

  for (const secret of secrets) {
    // Short values would match by coincidence — a two-character password would be
    // "found" in any text — so anything under eight characters is skipped, and the
    // caller is expected to use realistic values.
    if (secret.length < 8) continue;
    if (serialized.includes(secret)) findings.push({ path: '(serialized)', value: secret });
  }

  return findings;
}

/** Throws with a readable message when a secret value appears. */
export function assertNoLeakedValues(subject: unknown, secrets: string[], label = 'value'): void {
  const findings = findLeakedValues(subject, secrets);
  if (findings.length === 0) return;

  throw new Error(
    `${label} contains ${findings.length} secret value(s) that must have been redacted. ` +
      'Redact at the point the context is built, not at the sink.',
  );
}

/**
 * Finds fields whose *name* says they hold a secret and whose value is not redacted.
 *
 * The complement of the check above: that one catches a known value in an unexpected
 * place, this catches an unexpected value in a known place.
 */
export function findUnredactedSecretFields(subject: unknown): string[] {
  const findings: string[] = [];

  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      // The same judgement the redactor makes, including its allow-list of
      // identifiers derived from a secret — otherwise this would flag `sessionId`.
      const looksSecret = isSecretFieldName(key);

      if (looksSecret && typeof entry === 'string' && entry !== '[redacted]' && entry !== '') {
        findings.push(childPath);
        continue;
      }
      walk(entry, childPath, depth + 1);
    }
  };

  walk(subject, '', 0);
  return findings;
}

export function assertSecretFieldsRedacted(subject: unknown, label = 'value'): void {
  const findings = findUnredactedSecretFields(subject);
  if (findings.length === 0) return;

  throw new Error(
    `${label} has ${findings.length} secret-named field(s) carrying a value: ${findings.join(', ')}.`,
  );
}

/**
 * The categories a security suite is expected to cover.
 *
 * Not a decoration: `docs/security-testing.md` lists these, CI asserts that a test
 * exists for each, and a category with no test is a gap somebody can see.
 */
export const SECURITY_TEST_CATEGORIES = [
  'invalid token rejected',
  'expired token rejected',
  'wrong issuer rejected',
  'wrong audience rejected',
  'modified token rejected',
  'unsigned token rejected',
  'revoked session rejected',
  'refresh token reuse detected',
  'mfa required route enforced',
  'api key hashing',
  'api key expiration',
  'api key revocation',
  'api key scope enforcement',
  'service account authorization',
  'cross tenant access rejected',
  'role escalation rejected',
  'inactive member rejected',
  'rate limiting',
  'csrf protection',
  'secure cors',
  'sensitive field log redaction',
] as const;

export type SecurityTestCategory = (typeof SECURITY_TEST_CATEGORIES)[number];

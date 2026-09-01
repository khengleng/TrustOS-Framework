import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * The three data-access classes.
 *
 * This file is the reason the Governance Tool is safe to give to operations, support and finance.
 * An internal application builder is, structurally, a way to run queries against production —
 * and the way that goes wrong is never dramatic. Somebody builds a console that reads a table
 * directly because the API was slow, it works, and eighteen months later the console is writing
 * to that table because reading it was already allowed.
 *
 * So access is classified, and the classification is enforced rather than documented:
 *
 * **Class A — approved read-only.** Analytics replicas, reporting databases, read-only views,
 * aggregates and reference data, reached with dedicated read-only credentials. Fast, cheap, and
 * incapable of changing anything.
 *
 * **Class B — API only.** Anything authoritative: payments, wallets, the ledger, settlement,
 * reconciliation resolution, loans, customer records, product configuration, workflow decisions,
 * role changes, security configuration, API keys. These go through TrustOS APIs so that the
 * authorization, the workflow, the maker-checker and the audit trail all run. A direct write
 * here skips all four, and nothing errors.
 *
 * **Class C — forbidden.** Passwords, hashes, tokens, refresh tokens, encryption keys, API
 * secrets, provider credentials, private keys. Not "restricted": there is no permission that
 * grants them, no reveal that surfaces them and no export that includes them. A class that could
 * be unlocked is a class somebody unlocks during an incident.
 */

export const ACCESS_CLASSES = ['read_only', 'api_only', 'forbidden'] as const;
export type AccessClass = (typeof ACCESS_CLASSES)[number];

export const ACCESS_CLASS_DESCRIPTIONS: Record<AccessClass, string> = {
  read_only:
    'Class A. An approved read-only source — a replica, a view, an aggregate — reached with ' +
    'credentials that cannot write.',
  api_only:
    'Class B. Authoritative data. Reads may be direct where approved; every mutation goes ' +
    'through a TrustOS API so authorization, workflow, maker-checker and audit all run.',
  forbidden:
    'Class C. Never exposed, under any permission, in any environment, to anybody. There is no ' +
    'code path that returns it.',
};

/**
 * Operations an internal application may declare.
 *
 * `read`, `aggregate` and `search` are reads. `create`, `update`, `delete` and `execute` are
 * mutations, and every one of them is refused outside Class B — not because Class A is
 * read-only by policy, but because its credentials cannot write.
 */
export const RESOURCE_OPERATIONS = [
  'read',
  'search',
  'aggregate',
  'create',
  'update',
  'delete',
  'execute',
] as const;

export type ResourceOperation = (typeof RESOURCE_OPERATIONS)[number];

const MUTATIONS: ReadonlySet<ResourceOperation> = new Set([
  'create',
  'update',
  'delete',
  'execute',
]);

export function isMutation(operation: ResourceOperation): boolean {
  return MUTATIONS.has(operation);
}

/**
 * Field names that are never returned, whatever a resource declares.
 *
 * A deny list rather than an allow list, which is usually the wrong shape — and is the right one
 * here, because it is the *last* line rather than the first. The resource registry already says
 * which columns a resource exposes; this catches the one somebody adds to that list at 3am, and
 * the one that arrives because a view was widened upstream.
 *
 * Matching is on the normalized field name — lower-cased, with separators removed — so
 * `password_hash`, `passwordHash` and `PASSWORD-HASH` are the same field.
 */
export const FORBIDDEN_FIELD_PATTERNS: readonly string[] = [
  'password',
  'passwordhash',
  'passwd',
  'secret',
  'token',
  'refreshtoken',
  'accesstoken',
  'apikey',
  'apisecret',
  'clientsecret',
  'privatekey',
  'encryptionkey',
  'signingkey',
  'salt',
  'otpseed',
  'mfasecret',
  'credential',
  'keyhash',
];

function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether a field name is Class C.
 *
 * Substring matching on the normalized name. That over-matches — a column called
 * `token_bucket_refill` is not a credential — and over-matching is the correct failure direction
 * here: the cost of a false positive is a resource declaration that has to name an exception,
 * reviewed by a person; the cost of a false negative is a refresh token in a CSV.
 */
export function isForbiddenField(field: string): boolean {
  const normalized = normalizeFieldName(field);
  return FORBIDDEN_FIELD_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Every forbidden field in a set of column names.
 *
 * `reviewedExceptions` is the escape, and it is deliberately narrow: an exact field name, listed
 * on the declaration, visible in review. It exists because the matcher over-matches on purpose —
 * `inputTokens` on an AI usage report is a count, not a credential — and the alternative to an
 * exception list is loosening the matcher, which is how a real credential gets through.
 *
 * An exception names one field. There is no wildcard and no "disable this check", because both
 * would be used once during an incident and never removed.
 */
export function forbiddenFields(
  fields: readonly string[],
  reviewedExceptions: readonly string[] = [],
): string[] {
  const excepted = new Set(reviewedExceptions.map(normalizeFieldName));
  return fields.filter(
    (field) => isForbiddenField(field) && !excepted.has(normalizeFieldName(field)),
  );
}

export const accessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    accessClass: z.enum(ACCESS_CLASSES),
    operation: z.enum(RESOURCE_OPERATIONS),
    resourceId: z.string(),
    /** Machine-readable. Appears in the security event and in the client's error. */
    reason: z.string(),
  })
  .strict();

export type AccessDecision = z.infer<typeof accessDecisionSchema>;

/**
 * Decides whether an operation is permitted for an access class.
 *
 * Pure, so the table can be read and tested without a registry, and so the enforcement points
 * cannot each decide something slightly different.
 */
export function decideAccess(input: {
  resourceId: string;
  accessClass: AccessClass;
  operation: ResourceOperation;
  /** Operations the resource itself permits. A registry entry narrows the class; it never widens it. */
  permittedOperations: readonly ResourceOperation[];
}): AccessDecision {
  const base = {
    accessClass: input.accessClass,
    operation: input.operation,
    resourceId: input.resourceId,
  };

  if (input.accessClass === 'forbidden') {
    return {
      ...base,
      allowed: false,
      reason:
        'This resource is Class C. There is no permission that grants it, no reveal that ' +
        'surfaces it and no export that includes it.',
    };
  }

  if (!input.permittedOperations.includes(input.operation)) {
    return {
      ...base,
      allowed: false,
      reason: `The resource declares ${input.permittedOperations.join(', ') || 'no operations'}.`,
    };
  }

  if (input.accessClass === 'read_only' && isMutation(input.operation)) {
    return {
      ...base,
      allowed: false,
      reason:
        'This is a Class A read-only source. Its credentials cannot write, so a mutation here ' +
        'would fail at the database — and if it did not, it would be a write that skipped ' +
        'authorization, workflow, maker-checker and audit.',
    };
  }

  return { ...base, allowed: true, reason: 'Permitted.' };
}

/** Turns a refusal into the error a caller sees. */
export function accessRefused(decision: AccessDecision): ApiError {
  return new ApiError('forbidden', {
    message: `Refused: ${decision.reason}`,
    context: {
      governanceAccessClass: decision.accessClass,
      operation: decision.operation,
      resourceId: decision.resourceId,
    },
  });
}

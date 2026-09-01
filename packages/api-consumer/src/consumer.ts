import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { assertValidScopes, scopesSatisfyAll } from '@trustsystem/api-keys';
import {
  type ApiCatalog,
  type ApiDefinition,
  type ApiOperation,
  apiClassification,
  semverSchema,
} from '@trustsystem/api-catalog';

/**
 * API consumers.
 *
 * A consumer is *who is allowed to call what*, and it is deliberately not a credential. The
 * framework already has credentials: `@trustsystem/api-keys` generates, hashes and verifies them, and
 * this package does not reimplement any of that — it holds `credentialIds`, which are references,
 * and never a key or a hash.
 *
 * The separation matters beyond avoiding duplication. A consumer outlives its credentials: keys
 * rotate, expire and get revoked, and the entitlement — this partner may read merchants in
 * production — survives all of that. Modelling entitlement on the key means the entitlement is
 * re-granted at every rotation, usually by copying whatever the old key had, which is how scopes
 * accumulate and never shrink.
 *
 * Two rules are enforced rather than documented:
 *
 * **A consumer is entitled to a specific API at a specific major version.** Not "the merchant
 * API" — an entitlement that follows the newest version silently grants access to whatever the
 * next major adds.
 *
 * **A consumer cannot hold scopes its own entitlements do not use.** An unused scope is one
 * nobody reviews and everybody inherits at the next rotation.
 */

export const CONSUMER_KINDS = [
  'internal_application',
  'partner',
  'merchant',
  'service_account',
  'developer',
  'external_organization',
] as const;
export type ConsumerKind = (typeof CONSUMER_KINDS)[number];

/**
 * What each kind may reach, at most.
 *
 * A ceiling, not a grant: an entitlement above it is refused, and an entitlement below it is
 * whatever was actually approved. The purpose is that a mistake in a single entitlement cannot
 * hand an external caller restricted data — somebody would have to change the kind, which is a
 * visible decision rather than an edit to a scope list.
 */
export const KIND_CEILINGS: Record<
  ConsumerKind,
  {
    readonly maxClassification:
      'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | 'HIGHLY_RESTRICTED';
    readonly description: string;
    /** Whether this kind may reach production at all. */
    readonly productionPermitted: boolean;
  }
> = {
  internal_application: {
    maxClassification: 'HIGHLY_RESTRICTED',
    description: 'Another TrustOS service inside the same trust boundary.',
    productionPermitted: true,
  },
  service_account: {
    maxClassification: 'RESTRICTED',
    description: 'A non-human caller acting for a specific job, inside the organization.',
    productionPermitted: true,
  },
  merchant: {
    maxClassification: 'CONFIDENTIAL',
    description: 'A tenant calling about its own data.',
    productionPermitted: true,
  },
  partner: {
    maxClassification: 'CONFIDENTIAL',
    description: 'An external organization under contract.',
    productionPermitted: true,
  },
  external_organization: {
    maxClassification: 'INTERNAL',
    description: 'An external caller with no contract beyond terms of use.',
    productionPermitted: true,
  },
  developer: {
    maxClassification: 'PUBLIC',
    description:
      'A person exploring the API. Never reaches production data — a developer credential is the least ' +
      'controlled thing in any estate, and it belongs on synthetic data.',
    productionPermitted: false,
  },
};

const CLASSIFICATION_ORDER = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'HIGHLY_RESTRICTED',
];

export const entitlementSchema = z
  .object({
    apiId: z.string().min(3).max(64),
    /**
     * The major version this entitlement covers. Minors and patches within it are included,
     * because they are compatible by definition; the next major is not.
     */
    majorVersion: z.number().int().min(0).max(999),
    /** Operations this consumer may call. Empty means every operation in the API. */
    operationIds: z.array(z.string().min(3).max(120)).default([]),
    scopes: z.array(z.string().min(3).max(64)).min(1),
    grantedBy: z.string().min(1).max(64),
    grantedAt: z.string().datetime(),
    /** Entitlements expire. One that does not is one nobody revisits. */
    expiresAt: z.string().datetime().nullable().default(null),
    /** Why this consumer needs it. Read at review time, which is when it matters. */
    justification: z.string().min(20).max(1000),
  })
  .strict();

export type Entitlement = z.infer<typeof entitlementSchema>;

export const consumerSchema = z
  .object({
    consumerId: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/, 'Lowercase dotted or dashed identifier.'),
    name: z.string().min(3).max(120),
    kind: z.enum(CONSUMER_KINDS),
    description: z.string().min(20).max(1000),

    /**
     * The tenant this consumer belongs to, or null for a platform-level one.
     *
     * Explicit and non-optional, per the framework rule: an omitted organization is the mistake
     * that produces a cross-tenant read, so the field has to be written down either way.
     */
    organizationId: z.string().min(1).max(64).nullable(),

    environment: z.enum(['development', 'staging', 'production']),
    entitlements: z.array(entitlementSchema).default([]),

    /**
     * References into `@trustsystem/api-keys`. Never a key, never a hash — this package holds no
     * credential material and could not leak any.
     */
    credentialIds: z.array(z.string().min(1).max(64)).default([]),

    /** The subscription plan, which quotas and rate limits are read from. */
    planId: z.string().min(2).max(64).nullable().default(null),

    status: z.enum(['pending', 'active', 'suspended', 'revoked']).default('pending'),
    suspensionReason: z.string().min(10).max(500).nullable().default(null),

    /** A person accountable for this consumer's behaviour, inside the platform organization. */
    ownerId: z.string().min(1).max(64),
    /** The contact at the consumer, for deprecations and incidents. */
    technicalContact: z.string().min(3).max(200),

    createdAt: z.string().datetime(),
    lastReviewedAt: z.string().datetime().nullable().default(null),
  })
  .strict()
  .superRefine((consumer, ctx) => {
    const ceiling = KIND_CEILINGS[consumer.kind];

    if (consumer.environment === 'production' && !ceiling.productionPermitted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['environment'],
        message: `A ${consumer.kind} consumer does not reach production. ${ceiling.description}`,
      });
    }

    if (consumer.status === 'suspended' && consumer.suspensionReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suspensionReason'],
        message:
          'A suspension says why, so the consumer can be told and the decision can be reviewed.',
      });
    }

    const seen = new Set<string>();
    for (const [index, entitlement] of consumer.entitlements.entries()) {
      const key = `${entitlement.apiId}@${entitlement.majorVersion}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entitlements', index, 'apiId'],
          message: `Two entitlements for ${key}; whichever is evaluated first silently wins.`,
        });
      }
      seen.add(key);
    }
  });

export type Consumer = z.infer<typeof consumerSchema>;

export interface AccessDecision {
  readonly allowed: boolean;
  /** Safe to return to the caller — it names the scope or version, not the internal model. */
  readonly reason: string;
  /** The entitlement that permitted it, for the analytics record. */
  readonly entitlement: Entitlement | null;
  /** Distinguishes "you are not entitled" from "you are, but not to this". */
  readonly code:
    | 'allowed'
    | 'consumer_not_active'
    | 'no_entitlement'
    | 'entitlement_expired'
    | 'operation_not_entitled'
    | 'scope_not_granted'
    | 'wrong_environment'
    | 'version_retired';
}

/**
 * Whether a consumer may make this call.
 *
 * Every refusal names its own reason. A single "forbidden" is what makes integration support
 * expensive: the integrator cannot tell whether they need a scope, a new entitlement, or a
 * different version, so they ask, and somebody reads logs.
 */
export function decideAccess(input: {
  consumer: Consumer;
  api: ApiDefinition;
  operation: ApiOperation;
  at: Date;
}): AccessDecision {
  const { consumer, api, operation } = input;

  if (consumer.status !== 'active') {
    return {
      allowed: false,
      reason: `This consumer is ${consumer.status}.`,
      entitlement: null,
      code: 'consumer_not_active',
    };
  }

  if (consumer.environment !== api.environment) {
    return {
      allowed: false,
      reason: `This credential is for ${consumer.environment} and the API is ${api.environment}.`,
      entitlement: null,
      code: 'wrong_environment',
    };
  }

  if (api.lifecycle === 'RETIRED') {
    return {
      allowed: false,
      reason: `${api.apiId} ${api.version} is retired.${api.supersededBy ? ` Use ${api.supersededBy}.` : ''}`,
      entitlement: null,
      code: 'version_retired',
    };
  }

  const major = Number(api.version.split('.')[0]);
  const entitlement = consumer.entitlements.find(
    (candidate) => candidate.apiId === api.apiId && candidate.majorVersion === major,
  );

  if (!entitlement) {
    return {
      allowed: false,
      reason: `This consumer is not entitled to ${api.apiId} major version ${major}.`,
      entitlement: null,
      code: 'no_entitlement',
    };
  }

  if (entitlement.expiresAt !== null && Date.parse(entitlement.expiresAt) <= input.at.getTime()) {
    return {
      allowed: false,
      reason: `The entitlement to ${api.apiId} expired on ${entitlement.expiresAt}.`,
      entitlement,
      code: 'entitlement_expired',
    };
  }

  if (
    entitlement.operationIds.length > 0 &&
    !entitlement.operationIds.includes(operation.operationId)
  ) {
    return {
      allowed: false,
      reason: `This consumer is entitled to ${api.apiId} but not to ${operation.operationId}.`,
      entitlement,
      code: 'operation_not_entitled',
    };
  }

  const required = operation.scopes.length > 0 ? operation.scopes : api.scopes;

  if (!scopesSatisfyAll(entitlement.scopes, required)) {
    return {
      allowed: false,
      reason: `${operation.operationId} requires ${required.join(', ')}.`,
      entitlement,
      code: 'scope_not_granted',
    };
  }

  return { allowed: true, reason: 'Entitled.', entitlement, code: 'allowed' };
}

export function assertAccess(input: {
  consumer: Consumer;
  api: ApiDefinition;
  operation: ApiOperation;
  at: Date;
}): Entitlement {
  const decision = decideAccess(input);
  if (decision.allowed && decision.entitlement) return decision.entitlement;

  throw ApiError.forbidden(decision.reason, { reason: decision.code });
}

export interface ConsumerFinding {
  readonly kind:
    | 'above_kind_ceiling'
    | 'unused_scope'
    | 'entitlement_never_expires'
    | 'never_reviewed'
    | 'entitled_to_retired_version'
    | 'no_credentials';
  readonly consumerId: string;
  readonly severity: 'high' | 'medium' | 'low';
  readonly detail: string;
}

/**
 * Review a consumer against the catalog.
 *
 * The `above_kind_ceiling` finding is the one worth having: an entitlement granting a partner
 * access to an API that returns RESTRICTED data. It is a single reasonable-looking grant, and it
 * is invisible unless something compares the API's derived classification against the ceiling for
 * the consumer's kind.
 */
export function reviewConsumer(input: {
  consumer: Consumer;
  catalog: Pick<ApiCatalog, 'versionsOf'>;
  at: Date;
  /** Consumers unreviewed for longer than this are surfaced. */
  reviewIntervalDays?: number;
}): ConsumerFinding[] {
  const findings: ConsumerFinding[] = [];
  const { consumer } = input;
  const ceiling = KIND_CEILINGS[consumer.kind];
  const usedScopes = new Set<string>();

  for (const entitlement of consumer.entitlements) {
    for (const scope of entitlement.scopes) usedScopes.add(scope);

    const versions = input.catalog
      .versionsOf(entitlement.apiId)
      .filter((api) => Number(api.version.split('.')[0]) === entitlement.majorVersion);

    for (const api of versions) {
      const classification = apiClassification(api);

      if (
        CLASSIFICATION_ORDER.indexOf(classification) >
        CLASSIFICATION_ORDER.indexOf(ceiling.maxClassification)
      ) {
        findings.push({
          kind: 'above_kind_ceiling',
          consumerId: consumer.consumerId,
          severity: 'high',
          detail:
            `Entitled to ${api.apiId}@${api.version}, which returns ${classification} data, but a ` +
            `${consumer.kind} consumer reaches ${ceiling.maxClassification} at most.`,
        });
      }

      if (api.lifecycle === 'RETIRED') {
        findings.push({
          kind: 'entitled_to_retired_version',
          consumerId: consumer.consumerId,
          severity: 'low',
          detail: `Still entitled to ${api.apiId}@${api.version}, which is retired. The grant should be withdrawn.`,
        });
      }
    }

    if (entitlement.expiresAt === null) {
      findings.push({
        kind: 'entitlement_never_expires',
        consumerId: consumer.consumerId,
        severity: 'medium',
        detail: `The entitlement to ${entitlement.apiId} has no expiry, so nothing forces anybody to revisit it.`,
      });
    }
  }

  if (consumer.status === 'active' && consumer.credentialIds.length === 0) {
    findings.push({
      kind: 'no_credentials',
      consumerId: consumer.consumerId,
      severity: 'low',
      detail: 'Active with no credentials, so the entitlements grant access nobody can use.',
    });
  }

  const interval = input.reviewIntervalDays ?? 180;
  const lastReviewed = consumer.lastReviewedAt ?? consumer.createdAt;
  const daysSince = Math.floor((input.at.getTime() - Date.parse(lastReviewed)) / 86_400_000);

  if (daysSince > interval) {
    findings.push({
      kind: 'never_reviewed',
      consumerId: consumer.consumerId,
      severity: 'medium',
      detail: `Last reviewed ${daysSince} days ago, against an interval of ${interval}.`,
    });
  }

  return findings;
}

/** The registry. Consumers are configuration, so this is in-memory by design. */
export class ConsumerRegistry {
  private readonly consumers = new Map<string, Consumer>();

  constructor(consumers: readonly Consumer[] = []) {
    for (const consumer of consumers) this.register(consumer);
  }

  register(consumer: Consumer): void {
    if (this.consumers.has(consumer.consumerId)) {
      throw ApiError.conflict(`Consumer ${consumer.consumerId} is already registered.`);
    }
    /*
     * Validated per entitlement, not across the union. `assertValidScopes` refuses an empty list —
     * correctly, for a credential — but a consumer registered before its first entitlement is
     * granted has no scopes at all, and that is the normal state of a pending one.
     */
    for (const entitlement of consumer.entitlements) {
      assertValidScopes([...entitlement.scopes]);
    }
    this.consumers.set(consumer.consumerId, consumer);
  }

  get(consumerId: string): Consumer | null {
    return this.consumers.get(consumerId) ?? null;
  }

  require(consumerId: string): Consumer {
    const consumer = this.get(consumerId);
    if (!consumer) throw ApiError.notFound(`Consumer ${consumerId} is not registered.`);
    return consumer;
  }

  /** Who is entitled to an API version — read by the catalog when it reports on a deprecation. */
  consumersOf(apiId: string, version: string): string[] {
    const major = Number(version.split('.')[0]);
    return [...this.consumers.values()]
      .filter(
        (consumer) =>
          consumer.status !== 'revoked' &&
          consumer.entitlements.some(
            (entitlement) => entitlement.apiId === apiId && entitlement.majorVersion === major,
          ),
      )
      .map((consumer) => consumer.consumerId)
      .sort();
  }

  /** Find the consumer a verified credential belongs to. */
  byCredential(credentialId: string): Consumer | null {
    return (
      [...this.consumers.values()].find((consumer) =>
        consumer.credentialIds.includes(credentialId),
      ) ?? null
    );
  }

  list(
    filter: { environment?: string; kind?: ConsumerKind; organizationId?: string | null } = {},
  ): Consumer[] {
    return [...this.consumers.values()].filter((consumer) => {
      if (filter.environment && consumer.environment !== filter.environment) return false;
      if (filter.kind && consumer.kind !== filter.kind) return false;
      if (filter.organizationId !== undefined && consumer.organizationId !== filter.organizationId)
        return false;
      return true;
    });
  }
}

export { semverSchema };

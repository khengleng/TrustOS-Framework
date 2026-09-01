import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { DATA_CLASSIFICATION_LEVELS, classificationRank } from '@trustsystem/data-classification';

/**
 * The API catalog.
 *
 * The problem it solves is not documentation — a repository full of OpenAPI files documents an
 * estate perfectly well. It is that nobody can answer three questions about a running platform:
 * which APIs exist, who is allowed to call each one, and what happens to those callers if one is
 * withdrawn. Every organization can answer them about the APIs somebody remembers.
 *
 * So the catalog is deliberately a *governance* record, and its rules are the ones that keep it
 * from becoming a stale inventory:
 *
 * **An API cannot be published without a named business owner and a named technical owner.** Not
 * a team address — the point is that when a deprecation needs deciding there is somebody to
 * decide it, and when a consumer asks for an exception there is somebody to refuse.
 *
 * **A deprecated API keeps its consumers visible.** Deprecation is a promise made to specific
 * callers, and the deprecation date means nothing unless you can see who has not moved yet.
 *
 * **Classification is inherited upward, never downward.** An endpoint returning
 * HIGHLY_RESTRICTED fields makes the API HIGHLY_RESTRICTED, whatever the API document says. An
 * API classified below what it actually returns is the mechanism by which a restricted field
 * reaches a public integration.
 */

export const API_LIFECYCLE_STATES = [
  'DRAFT',
  'REVIEW',
  'APPROVED',
  'PUBLISHED',
  'DEPRECATED',
  'RETIRED',
] as const;
export type ApiLifecycleState = (typeof API_LIFECYCLE_STATES)[number];

/**
 * Permitted lifecycle transitions.
 *
 * Two properties are deliberate. `PUBLISHED` cannot go back to `DRAFT`: once consumers exist,
 * changing the contract is a new version, not an edit. And `RETIRED` is terminal — un-retiring an
 * API means consumers were told it was gone and then it was not, which is worse than a new
 * version at the same path.
 */
const LIFECYCLE_TRANSITIONS: Record<ApiLifecycleState, readonly ApiLifecycleState[]> = {
  DRAFT: ['REVIEW', 'RETIRED'],
  REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED: ['PUBLISHED', 'REVIEW'],
  PUBLISHED: ['DEPRECATED'],
  DEPRECATED: ['RETIRED', 'PUBLISHED'],
  RETIRED: [],
};

export const AUTHENTICATION_MODES = [
  'api_key',
  'oauth2_client_credentials',
  'oauth2_authorization_code',
  'service_account_jwt',
  'session',
  'none',
] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

export const apiIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/, 'Lowercase dotted or dashed identifier.');

/** Semantic version, majors only in the URL. */
export const semverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'A semantic version: major.minor.patch.');

export const apiOperationSchema = z
  .object({
    operationId: z.string().min(3).max(120),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    /** Path with `:param` segments, e.g. `/api/merchants/:merchantId/wallets`. */
    path: z.string().min(1).max(300).startsWith('/'),
    summary: z.string().min(10).max(300),
    /** Scopes a credential must hold. Empty means the API's own scopes apply. */
    scopes: z.array(z.string().min(3).max(64)).default([]),
    /**
     * The most sensitive thing this operation can return. The API's classification is the highest
     * across its operations, so an operation cannot quietly be more sensitive than its API.
     */
    classification: z.enum(DATA_CLASSIFICATION_LEVELS),
    /** Whether repeating the call with the same key is safe — read by the retry posture. */
    idempotent: z.boolean(),
    deprecated: z.boolean().default(false),
  })
  .strict();

export type ApiOperation = z.infer<typeof apiOperationSchema>;

export const apiDefinitionSchema = z
  .object({
    apiId: apiIdSchema,
    name: z.string().min(3).max(120),
    description: z.string().min(20).max(2000),
    version: semverSchema,
    domain: z.string().min(2).max(64),
    environment: z.enum(['development', 'staging', 'production']),
    lifecycle: z.enum(API_LIFECYCLE_STATES).default('DRAFT'),

    /**
     * Two owners, both required to publish.
     *
     * The business owner decides whether a consumer gets an exception; the technical owner decides
     * whether a change is safe. Collapsing them into one field means one of those decisions gets
     * made by whoever is nearest.
     */
    businessOwnerId: z.string().min(1).max(64),
    technicalOwnerId: z.string().min(1).max(64),

    authentication: z.enum(AUTHENTICATION_MODES),
    /** Default scopes, when an operation does not name its own. */
    scopes: z.array(z.string().min(3).max(64)).default([]),
    operations: z.array(apiOperationSchema).min(1),

    /** The OpenAPI document, or a reference to it. The catalog does not parse it. */
    openApiRef: z.string().min(3).max(500).nullable().default(null),

    /** The service that implements it, so an incident can name the APIs it affects. */
    serviceId: z.string().min(3).max(64).nullable().default(null),
    /** The objective consumers may rely on, if any. */
    sloId: z.string().min(3).max(64).nullable().default(null),

    /** Set when the API is deprecated; the date after which calls will fail. */
    retirementDate: z.string().datetime().nullable().default(null),
    /** Which API replaces it. A deprecation with no successor is a withdrawal, and says so. */
    supersededBy: apiIdSchema.nullable().default(null),

    /** Governance approval, required to publish into production. */
    approvedBy: z.string().min(1).max(64).nullable().default(null),
    approvedAt: z.string().datetime().nullable().default(null),

    organizationId: z.string().min(1).max(64).nullable().default(null),
    registeredAt: z.string().datetime(),
  })
  .strict()
  .superRefine((api, ctx) => {
    if (
      api.authentication === 'none' &&
      api.operations.some((op) => classificationRank(op.classification) > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authentication'],
        message:
          'An unauthenticated API returning anything above PUBLIC is an open endpoint over internal data.',
      });
    }

    const seen = new Set<string>();
    for (const [index, operation] of api.operations.entries()) {
      const key = `${operation.method} ${operation.path}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operations', index, 'path'],
          message: `${key} is declared twice; the router would resolve one of them and nobody would know which.`,
        });
      }
      seen.add(key);

      if (
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method) === false &&
        !operation.idempotent
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operations', index, 'idempotent'],
          message: `${operation.method} is idempotent by definition; declaring otherwise misleads the retry posture.`,
        });
      }
    }

    if (api.lifecycle === 'DEPRECATED' && api.retirementDate === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retirementDate'],
        message:
          'A deprecation with no retirement date is an announcement nobody has to act on. State when calls stop working.',
      });
    }

    if (api.supersededBy === api.apiId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message: 'An API does not supersede itself.',
      });
    }
  });

export type ApiDefinition = z.infer<typeof apiDefinitionSchema>;

/**
 * The classification of an API: the highest across its operations.
 *
 * Derived rather than declared, which is the point. A declared classification is a claim somebody
 * made once; this one cannot be lower than what the API actually returns.
 */
export function apiClassification(api: ApiDefinition): (typeof DATA_CLASSIFICATION_LEVELS)[number] {
  return api.operations.reduce(
    (highest, operation) =>
      classificationRank(operation.classification) > classificationRank(highest)
        ? operation.classification
        : highest,
    'PUBLIC' as (typeof DATA_CLASSIFICATION_LEVELS)[number],
  );
}

export interface CatalogFinding {
  readonly kind:
    | 'published_without_approval'
    | 'deprecated_with_active_consumers'
    | 'retired_but_called'
    | 'no_objective'
    | 'unowned_after_departure'
    | 'undocumented';
  readonly apiId: string;
  readonly severity: 'high' | 'medium' | 'low';
  readonly detail: string;
}

export class ApiCatalog {
  private readonly apis = new Map<string, ApiDefinition>();

  constructor(apis: readonly ApiDefinition[] = []) {
    for (const api of apis) this.register(api);
  }

  private static key(apiId: string, version: string): string {
    return `${apiId}@${version}`;
  }

  register(api: ApiDefinition): void {
    const key = ApiCatalog.key(api.apiId, api.version);
    if (this.apis.has(key)) {
      throw ApiError.conflict(`${key} is already in the catalog.`);
    }
    this.apis.set(key, api);
  }

  get(apiId: string, version: string): ApiDefinition | null {
    return this.apis.get(ApiCatalog.key(apiId, version)) ?? null;
  }

  require(apiId: string, version: string): ApiDefinition {
    const api = this.get(apiId, version);
    if (!api) throw ApiError.notFound(`${apiId}@${version} is not in the catalog.`);
    return api;
  }

  /** Every version of an API, newest first. */
  versionsOf(apiId: string): ApiDefinition[] {
    return [...this.apis.values()]
      .filter((api) => api.apiId === apiId)
      .sort((left, right) => compareSemver(right.version, left.version));
  }

  /** The version a caller reaches when it does not pin one: the newest published. */
  current(apiId: string): ApiDefinition | null {
    return this.versionsOf(apiId).find((api) => api.lifecycle === 'PUBLISHED') ?? null;
  }

  list(
    filter: {
      lifecycle?: ApiLifecycleState;
      environment?: string;
      domain?: string;
      organizationId?: string | null;
    } = {},
  ): ApiDefinition[] {
    return [...this.apis.values()].filter((api) => {
      if (filter.lifecycle && api.lifecycle !== filter.lifecycle) return false;
      if (filter.environment && api.environment !== filter.environment) return false;
      if (filter.domain && api.domain !== filter.domain) return false;
      if (filter.organizationId !== undefined && api.organizationId !== filter.organizationId)
        return false;
      return true;
    });
  }

  /**
   * Move an API through its lifecycle.
   *
   * Publishing into production requires a named approver who is neither owner. An owner approving
   * their own publication is the same self-approval the framework refuses everywhere else, and an
   * API going live is exactly as consequential as the changes maker-checker protects.
   */
  transition(input: {
    apiId: string;
    version: string;
    to: ApiLifecycleState;
    actorId: string;
    reason: string;
    retirementDate?: string;
    supersededBy?: string;
  }): ApiDefinition {
    const api = this.require(input.apiId, input.version);

    if (!LIFECYCLE_TRANSITIONS[api.lifecycle].includes(input.to)) {
      throw ApiError.conflict(`An API does not move from ${api.lifecycle} to ${input.to}.`, {
        permitted: LIFECYCLE_TRANSITIONS[api.lifecycle],
      });
    }

    if (input.to === 'PUBLISHED' && api.environment === 'production') {
      if (input.actorId === api.businessOwnerId || input.actorId === api.technicalOwnerId) {
        throw ApiError.forbidden(
          'An owner does not approve their own publication into production. Publishing an API is as consequential as any change maker-checker protects.',
        );
      }
    }

    const next = apiDefinitionSchema.parse({
      ...api,
      lifecycle: input.to,
      retirementDate: input.retirementDate ?? api.retirementDate,
      supersededBy: input.supersededBy ?? api.supersededBy,
      approvedBy: input.to === 'PUBLISHED' ? input.actorId : api.approvedBy,
      approvedAt:
        input.to === 'PUBLISHED' ? (api.approvedAt ?? new Date(0).toISOString()) : api.approvedAt,
    });

    this.apis.set(ApiCatalog.key(api.apiId, api.version), next);
    return next;
  }

  /**
   * Resolve a request to a declared operation.
   *
   * Segment by segment, with `:param` matching exactly one concrete segment. Normalizing both
   * sides and comparing strings is how `/api/merchants/../admin` matches something it should not.
   */
  findOperation(api: ApiDefinition, method: string, path: string): ApiOperation | null {
    const requested =
      path
        .split('?')[0]
        ?.split('/')
        .filter((segment) => segment.length > 0) ?? [];

    if (requested.some((segment) => segment === '..' || segment === '.')) return null;

    for (const operation of api.operations) {
      if (operation.method !== method.toUpperCase()) continue;

      const declared = operation.path.split('/').filter((segment) => segment.length > 0);
      if (declared.length !== requested.length) continue;

      const matches = declared.every((segment, index) => {
        const actual = requested[index] as string;
        if (segment.startsWith(':')) return actual.length > 0;
        return segment === actual;
      });

      if (matches) return operation;
    }

    return null;
  }

  /**
   * Findings across the catalog.
   *
   * `consumersOf` is supplied by the caller rather than held here, so the catalog does not have to
   * know about the consumer package. The relationship it reports on — a deprecation with callers
   * who have not moved — is the one that makes a retirement date real.
   */
  analyse(
    input: { consumersOf?: (apiId: string, version: string) => readonly string[] } = {},
  ): CatalogFinding[] {
    const findings: CatalogFinding[] = [];

    for (const api of this.apis.values()) {
      if (
        api.lifecycle === 'PUBLISHED' &&
        api.environment === 'production' &&
        api.approvedBy === null
      ) {
        findings.push({
          kind: 'published_without_approval',
          apiId: api.apiId,
          severity: 'high',
          detail: `${api.apiId}@${api.version} is live in production with no recorded governance approval.`,
        });
      }

      if (api.lifecycle === 'DEPRECATED') {
        const consumers = input.consumersOf?.(api.apiId, api.version) ?? [];
        if (consumers.length > 0) {
          findings.push({
            kind: 'deprecated_with_active_consumers',
            apiId: api.apiId,
            severity: 'high',
            detail:
              `${api.apiId}@${api.version} retires on ${api.retirementDate} and ${consumers.length} consumer(s) ` +
              `have not moved: ${consumers.join(', ')}.`,
          });
        }
      }

      if (api.lifecycle === 'RETIRED') {
        const consumers = input.consumersOf?.(api.apiId, api.version) ?? [];
        if (consumers.length > 0) {
          findings.push({
            kind: 'retired_but_called',
            apiId: api.apiId,
            severity: 'high',
            detail: `${api.apiId}@${api.version} is retired but ${consumers.length} consumer(s) are still entitled to call it.`,
          });
        }
      }

      if (api.lifecycle === 'PUBLISHED' && api.environment === 'production' && api.sloId === null) {
        findings.push({
          kind: 'no_objective',
          apiId: api.apiId,
          severity: 'low',
          detail:
            'Published in production with no objective, so consumers have nothing to rely on.',
        });
      }

      if (api.lifecycle === 'PUBLISHED' && api.openApiRef === null) {
        findings.push({
          kind: 'undocumented',
          apiId: api.apiId,
          severity: 'medium',
          detail:
            'Published with no OpenAPI reference, so the portal has nothing to show a consumer.',
        });
      }
    }

    return findings;
  }
}

export function compareSemver(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0, leftPatch = 0] = left.split('.').map(Number);
  const [rightMajor = 0, rightMinor = 0, rightPatch = 0] = right.split('.').map(Number);

  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  if (leftMinor !== rightMinor) return leftMinor - rightMinor;
  return leftPatch - rightPatch;
}

/** An API cannot be published without both owners and, in production, an approver. */
export function assertPublishable(api: ApiDefinition): void {
  const problems: string[] = [];

  if (api.openApiRef === null)
    problems.push('It has no OpenAPI document, so no consumer can integrate against it.');
  if (api.serviceId === null)
    problems.push('It names no implementing service, so an incident cannot state its impact.');
  if (api.environment === 'production' && api.approvedBy === null) {
    problems.push('Production publication requires recorded governance approval.');
  }

  if (problems.length > 0) {
    throw ApiError.conflict(`${api.apiId}@${api.version} is not ready to publish.`, { problems });
  }
}

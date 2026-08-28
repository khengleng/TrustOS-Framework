import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import {
  ACCESS_CLASSES,
  DATA_CLASSIFICATIONS,
  ENVIRONMENTS,
  RESOURCE_OPERATIONS,
  STANDARD_RESOURCE_IDS,
  decideAccess,
  forbiddenFields,
  type AccessClass,
  type AccessDecision,
  type Environment,
  type ResourceOperation,
} from '@trustos/governance-tool-core';

/**
 * The approved resource registry.
 *
 * Section 10 of the specification asks for a registry of what an internal application may reach.
 * The reason it is a registry rather than a configuration file is the question it has to answer
 * during an incident: **which internal tools can see this data, and who approved that?**
 *
 * Every entry carries an access class, an owner, permitted operations, the groups allowed to use
 * it, and a review date. Production entries carry an approval; a draft entry is unusable in
 * production, and that is checked rather than assumed.
 *
 * Three refusals are worth stating before the schema:
 *
 * **A resource may not expose a Class C field.** The declaration lists its columns, and a
 * credential-shaped one is refused at registration — before anybody builds a console against it.
 *
 * **A Class A resource may not declare a mutation.** Its credentials cannot write; declaring an
 * update would be declaring an operation that fails at the database, or worse, one that does not.
 *
 * **A production resource needs an approver who is not the registrant.** Registering and
 * approving your own production data source is the whole control, collapsed.
 */

export const RESOURCE_TYPES = [
  'trustos_api',
  'reporting_database',
  'analytics_database',
  'workflow_api',
  'ai_gateway',
  'financial_product_api',
  'monitoring_api',
  'document_api',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const resourceRegistrationSchema = z
  .object({
    resourceId: z
      .string()
      .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'namespace.name, lower snake case.'),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(400),
    type: z.enum(RESOURCE_TYPES),
    environment: z.enum(ENVIRONMENTS),

    owner: z.string().min(1).max(80),
    businessOwner: z.string().min(1).max(80),
    technicalOwner: z.string().min(1).max(80),

    dataClassification: z.enum(DATA_CLASSIFICATIONS),
    accessClass: z.enum(ACCESS_CLASSES),

    /**
     * A reference to the credential, never the credential.
     *
     * The deployment's secret store resolves it. Nothing in this registry has a field a secret
     * could be pasted into, and nothing should gain one.
     */
    credentialRef: z.string().min(1).max(200),

    /** Internal roles allowed to reach it at all. Empty means nobody, never everybody. */
    allowedGroups: z.array(z.string().min(1).max(60)).max(40),
    permittedOperations: z.array(z.enum(RESOURCE_OPERATIONS)).min(1),
    /** Columns this resource exposes. Checked for Class C fields at registration. */
    exposedFields: z.array(z.string().min(1).max(80)).max(300).default([]),
    /** Field names that look like a credential and are not, named individually. */
    fieldExceptions: z.array(z.string().min(1).max(80)).max(20).default([]),

    approvalStatus: z.enum(['draft', 'approved', 'revoked']),
    approvedBy: z.string().min(1).max(80).nullable(),
    lastReviewDate: z.string().datetime().nullable(),
    nextReviewDate: z.string().datetime(),
  })
  .strict()
  .superRefine((resource, ctx) => {
    const forbidden = forbiddenFields(resource.exposedFields, resource.fieldExceptions);

    if (forbidden.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exposedFields'],
        message:
          `This resource exposes ${forbidden.join(', ')}, which is Class C. There is no ` +
          'permission that grants it. If one of these is a false positive — a count, not a ' +
          'credential — name it in fieldExceptions so the exception is visible in review.',
      });
    }

    if (resource.accessClass === 'read_only') {
      const mutations = resource.permittedOperations.filter((operation) =>
        ['create', 'update', 'delete', 'execute'].includes(operation),
      );

      if (mutations.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permittedOperations'],
          message:
            `A Class A read-only resource declares ${mutations.join(', ')}. Its credentials ` +
            'cannot write — and if they can, it is not Class A.',
        });
      }
    }

    if (resource.accessClass === 'forbidden' && resource.exposedFields.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exposedFields'],
        message: 'A Class C resource exposes nothing. Listing fields on one is a contradiction.',
      });
    }

    if (
      resource.environment === 'prod' &&
      resource.approvalStatus === 'approved' &&
      resource.approvedBy === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedBy'],
        message: 'An approved production resource records who approved it.',
      });
    }

    if (
      resource.environment === 'prod' &&
      resource.approvedBy !== null &&
      resource.approvedBy === resource.owner
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedBy'],
        message:
          'The registrant approved their own production resource. That is the control, collapsed.',
      });
    }
  });

export type ResourceRegistration = z.infer<typeof resourceRegistrationSchema>;

/**
 * The registry.
 *
 * Scoped by environment as well as by id: `reporting.transactions` in DEV and in PROD are two
 * entries with two credential references, and conflating them is how a console promoted to
 * production keeps reading the development replica — or, in the direction that matters, how a
 * development console reaches production data.
 */
export class ResourceRegistry {
  private readonly resources = new Map<string, ResourceRegistration>();

  constructor(registrations: readonly ResourceRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(input: unknown): ResourceRegistration {
    const resource = resourceRegistrationSchema.parse(input);
    const key = keyOf(resource.environment, resource.resourceId);

    if (this.resources.has(key)) {
      throw new ApiError('conflict', {
        message: `Resource ${resource.resourceId} is already registered for ${resource.environment}.`,
        context: { resourceId: resource.resourceId, environment: resource.environment },
      });
    }

    this.resources.set(key, resource);
    return resource;
  }

  find(environment: Environment, resourceId: string): ResourceRegistration | undefined {
    return this.resources.get(keyOf(environment, resourceId));
  }

  require(environment: Environment, resourceId: string): ResourceRegistration {
    const resource = this.find(environment, resourceId);

    if (!resource) {
      throw new ApiError('forbidden', {
        message:
          `No approved resource "${resourceId}" in ${environment}. An internal application may ` +
          'only reach registered resources — an unregistered one is a data source nobody ' +
          'classified and nobody approved.',
        context: { resourceId, environment },
      });
    }

    return resource;
  }

  list(environment: Environment): ResourceRegistration[] {
    return [...this.resources.values()]
      .filter((resource) => resource.environment === environment)
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  }

  /**
   * Decides whether an actor may perform an operation on a resource.
   *
   * Four checks, in the order whose refusal reveals least: does the resource exist, is it usable
   * in this environment, may this actor's groups reach it at all, and does the access class
   * permit the operation.
   */
  decide(input: {
    environment: Environment;
    resourceId: string;
    operation: ResourceOperation;
    actorGroups: readonly string[];
  }): AccessDecision {
    const resource = this.find(input.environment, input.resourceId);

    if (!resource) {
      return {
        allowed: false,
        accessClass: 'forbidden',
        operation: input.operation,
        resourceId: input.resourceId,
        reason: `No approved resource "${input.resourceId}" in ${input.environment}.`,
      };
    }

    if (resource.approvalStatus !== 'approved') {
      return {
        allowed: false,
        accessClass: resource.accessClass,
        operation: input.operation,
        resourceId: input.resourceId,
        reason: `This resource is ${resource.approvalStatus}. Only an approved resource may be reached.`,
      };
    }

    const permitted = input.actorGroups.some((group) => resource.allowedGroups.includes(group));

    if (!permitted) {
      return {
        allowed: false,
        accessClass: resource.accessClass,
        operation: input.operation,
        resourceId: input.resourceId,
        reason: 'No group you hold is allowed to reach this resource.',
      };
    }

    return decideAccess({
      resourceId: input.resourceId,
      accessClass: resource.accessClass,
      operation: input.operation,
      permittedOperations: resource.permittedOperations,
    });
  }

  /** Resources whose review date has passed. What a governance review opens with. */
  overdueReviews(environment: Environment, asOf: Date): ResourceRegistration[] {
    return this.list(environment).filter((resource) => new Date(resource.nextReviewDate) < asOf);
  }

  size(): number {
    return this.resources.size;
  }
}

function keyOf(environment: Environment, resourceId: string): string {
  return `${environment}|${resourceId}`;
}

/**
 * The classification of the standard resources the console templates reference.
 *
 * Shared with `@trustos/governance-tool-core`'s `STANDARD_RESOURCE_IDS`, so the consoles and the
 * registry cannot disagree about what `trustos.wallet` is. It is a **classification**, not a
 * registration: a deployment still registers each one with its own owner, credential reference
 * and allowed groups, because those are facts about a deployment rather than about TrustOS.
 */
export const STANDARD_RESOURCE_CLASSES: Readonly<Record<string, AccessClass>> = {
  [STANDARD_RESOURCE_IDS.REPORTING_TRANSACTIONS]: 'read_only',
  [STANDARD_RESOURCE_IDS.REPORTING_SETTLEMENTS]: 'read_only',
  [STANDARD_RESOURCE_IDS.REPORTING_MERCHANTS]: 'read_only',
  [STANDARD_RESOURCE_IDS.REPORTING_CUSTOMERS]: 'read_only',
  [STANDARD_RESOURCE_IDS.REPORTING_EXCEPTIONS]: 'read_only',
  [STANDARD_RESOURCE_IDS.REPORTING_AI_USAGE]: 'read_only',
  [STANDARD_RESOURCE_IDS.REFERENCE_DATA]: 'read_only',

  [STANDARD_RESOURCE_IDS.API_WALLET]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_LEDGER]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_SETTLEMENT]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_RECONCILIATION]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_WORKFLOW]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_CASE]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_CUSTOMER]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_MERCHANT]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_PRODUCT]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_IDENTITY]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_RBAC]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_API_KEYS]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_AI]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_HEALTH]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_AUDIT]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_SECURITY_EVENTS]: 'api_only',

  /*
   * Phase 13. Every enterprise governance surface is `api_only`, with no read-only variant.
   *
   * There is a reporting replica of most operational data, and reading a transaction list from one
   * is correct. There is no equivalent for a policy version, a service tier or a DR plan: those
   * are the rules the platform enforces, and reading them from a replica means reading a rule
   * without the check that the version found is the one in force.
   */
  [STANDARD_RESOURCE_IDS.API_DATA_CATALOG]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_DATA_LINEAGE]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_POLICY]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_POLICY_DECISIONS]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_SRE_SERVICE]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_SRE_SLO]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_SRE_INCIDENT]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_API_CATALOG]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_API_CONSUMER]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_BACKUP]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_DR_PLAN]: 'api_only',
  [STANDARD_RESOURCE_IDS.API_CONTINUITY]: 'api_only',
};

export function classifyStandardResource(resourceId: string): AccessClass | null {
  return STANDARD_RESOURCE_CLASSES[resourceId] ?? null;
}

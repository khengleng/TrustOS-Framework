import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import {
  accessRefused,
  forbiddenFields,
  isMutation,
  type AccessDecision,
  type Environment,
  type ResourceOperation,
} from '@trustos/governance-tool-core';
import type { ResourceRegistry } from '@trustos/governance-resource-policy';

/**
 * Enforcing the three access classes.
 *
 * `@trustos/governance-tool-core` declares the classes and `@trustos/governance-resource-policy`
 * classifies each resource. This package is the **choke point**: every read and every write an
 * internal application performs goes through `DataAccessGuard`, and there is no second path.
 *
 * That matters more than the checks themselves. A guard that covers most call sites is a guard
 * with a bypass, and the bypass is always the one somebody added in a hurry. So the guard's
 * methods are the only ones the runtime has: it cannot issue a query, only ask the guard to.
 *
 * Four things happen on every call, in this order:
 *
 *   1. **Resolve the resource** in this environment. Unregistered is refused.
 *   2. **Decide access** — approval status, the actor's groups, the class, the operation.
 *   3. **Project the fields.** A read returns only columns the resource declares *and* the
 *      request asked for. A column that arrived because a view was widened upstream is dropped
 *      rather than returned.
 *   4. **Bound the rows.** Always. An unbounded read is an outage an internal user triggers by
 *      clicking a button.
 *
 * And one thing that never happens: a mutation outside Class B. Not "is discouraged" — the guard
 * has no method that would perform one, and `assertApiOnlyMutation` is what a caller gets if they
 * try to route one through the read path.
 */

export const MAX_ROWS_CEILING = 10_000;

export interface DataAccessContext {
  environment: Environment;
  organizationId: string;
  actorId: string;
  /** Internal roles, resolved server-side. Never from a token claim. */
  actorGroups: readonly string[];
  /** The internal application making the request. Recorded on every audit entry. */
  appId: string;
  correlationId: string;
}

export interface ReadRequest {
  resourceId: string;
  operation: Extract<ResourceOperation, 'read' | 'search' | 'aggregate'>;
  /** Columns asked for. Intersected with what the resource declares. */
  fields: readonly string[];
  maxRows: number;
  parameters?: Readonly<Record<string, string | number | boolean>>;
}

export interface ReadPlan {
  resourceId: string;
  operation: ReadRequest['operation'];
  /** What will actually be returned, after projection. */
  fields: string[];
  /** Columns the request asked for and will not get, with the reason. */
  droppedFields: Array<{ field: string; reason: string }>;
  maxRows: number;
  credentialRef: string;
  decision: AccessDecision;
}

export interface MutationRequest {
  resourceId: string;
  operation: Extract<ResourceOperation, 'create' | 'update' | 'delete' | 'execute'>;
  /** The gateway path the mutation is routed through. */
  apiPath: string;
  reason?: string;
}

export interface MutationPlan {
  resourceId: string;
  operation: MutationRequest['operation'];
  apiPath: string;
  decision: AccessDecision;
}

/**
 * The guard.
 *
 * Produces **plans** rather than performing operations. The runtime takes a plan and executes it;
 * a deployment's own executor takes the same plan. Splitting them means the decision is testable
 * without a database and, more usefully, means the decision and the execution cannot drift —
 * there is nothing to drift from, because the executor has no inputs the plan does not carry.
 */
export class DataAccessGuard {
  constructor(private readonly registry: ResourceRegistry) {}

  planRead(context: DataAccessContext, request: ReadRequest): ReadPlan {
    const decision = this.registry.decide({
      environment: context.environment,
      resourceId: request.resourceId,
      operation: request.operation,
      actorGroups: context.actorGroups,
    });

    if (!decision.allowed) throw accessRefused(decision);

    const resource = this.registry.require(context.environment, request.resourceId);

    const declared = new Set(resource.exposedFields);
    const fields: string[] = [];
    const droppedFields: Array<{ field: string; reason: string }> = [];

    for (const field of request.fields) {
      if (!declared.has(field)) {
        /*
         * Dropped rather than refused.
         *
         * A column that arrived because a view was widened upstream, or a field a console asked
         * for and the resource never declared, should not return data — and should not break the
         * page either. Dropping it and saying so is what surfaces the drift without an outage.
         */
        droppedFields.push({
          field,
          reason: 'The resource does not declare this column.',
        });
        continue;
      }

      fields.push(field);
    }

    /*
     * The last line, applied to what the resource itself declared.
     *
     * Registration already refuses a credential-shaped column, so this should never fire. It is
     * here because "should never fire" and "does not fire" differ by one upstream schema change,
     * and this is the cheapest place to notice.
     */
    const forbidden = forbiddenFields(fields, resource.fieldExceptions);

    if (forbidden.length > 0) {
      throw new ApiError('forbidden', {
        message:
          `The resource "${request.resourceId}" would return ${forbidden.join(', ')}, which is ` +
          'Class C. This should have been refused at registration; the declaration has drifted.',
        context: { resourceId: request.resourceId, fields: forbidden.join(',') },
      });
    }

    return {
      resourceId: request.resourceId,
      operation: request.operation,
      fields,
      droppedFields,
      maxRows: Math.min(Math.max(request.maxRows, 1), MAX_ROWS_CEILING),
      credentialRef: resource.credentialRef,
      decision,
    };
  }

  /**
   * Plans a mutation.
   *
   * Refuses anything that is not Class B, and refuses anything not routed through the gateway.
   * The second check is the one that matters: a mutation with a direct path is a mutation that
   * skips authorization, workflow, maker-checker and audit, and it would look exactly like a
   * working feature.
   */
  planMutation(context: DataAccessContext, request: MutationRequest): MutationPlan {
    if (!isMutation(request.operation)) {
      throw new ApiError('validation_error', {
        message: `"${request.operation}" is a read. Use planRead.`,
      });
    }

    const decision = this.registry.decide({
      environment: context.environment,
      resourceId: request.resourceId,
      operation: request.operation,
      actorGroups: context.actorGroups,
    });

    if (!decision.allowed) throw accessRefused(decision);

    assertApiOnlyMutation(decision, request.apiPath);

    return {
      resourceId: request.resourceId,
      operation: request.operation,
      apiPath: request.apiPath,
      decision,
    };
  }
}

/**
 * Refuses a mutation that is not Class B, or is not routed through the gateway.
 *
 * Exported separately so a deployment's own executor can call it directly. Two enforcement points
 * for one rule, deliberately: the guard covers the runtime, and this covers the code somebody
 * writes next year that does not go through the runtime.
 */
export function assertApiOnlyMutation(decision: AccessDecision, apiPath: string): void {
  if (decision.accessClass !== 'api_only') {
    throw new ApiError('forbidden', {
      message:
        `A mutation on a Class ${decision.accessClass === 'read_only' ? 'A' : 'C'} resource is ` +
        'refused. Authoritative data is changed through a TrustOS API, so that authorization, ' +
        'workflow, maker-checker and audit all run — a direct write skips all four, and nothing ' +
        'errors.',
      context: { resourceId: decision.resourceId, accessClass: decision.accessClass },
    });
  }

  if (!apiPath.startsWith('/internal/v1/')) {
    throw new ApiError('forbidden', {
      message:
        `"${apiPath}" is not a gateway path. Every mutation goes through /internal/v1, where ` +
        'identity, tenancy, authorization, correlation and audit enrichment are applied.',
      context: { resourceId: decision.resourceId, apiPath },
    });
  }
}

/**
 * A description of what an application is allowed to reach, for review.
 *
 * The screen a security reviewer opens when asked to approve a console: every resource it names,
 * its class, and whether the app mutates it. Computed from the definition rather than described
 * by its author.
 */
export const accessSummarySchema = z
  .object({
    appId: z.string(),
    environment: z.string(),
    reads: z.array(z.object({ resourceId: z.string(), accessClass: z.string() }).strict()),
    mutations: z.array(
      z.object({ resourceId: z.string(), operation: z.string(), apiPath: z.string() }).strict(),
    ),
    unregistered: z.array(z.string()),
  })
  .strict();

export type AccessSummary = z.infer<typeof accessSummarySchema>;

export function summarizeAccess(input: {
  appId: string;
  environment: Environment;
  registry: ResourceRegistry;
  dataSources: ReadonlyArray<{ resourceId: string; operation: ResourceOperation }>;
  actions: ReadonlyArray<{ resourceId: string; operation: ResourceOperation; apiPath: string }>;
}): AccessSummary {
  const unregistered = new Set<string>();

  const classOf = (resourceId: string): string => {
    const resource = input.registry.find(input.environment, resourceId);
    if (!resource) {
      unregistered.add(resourceId);
      return 'unregistered';
    }
    return resource.accessClass;
  };

  const reads = input.dataSources
    .filter((source) => !isMutation(source.operation))
    .map((source) => ({ resourceId: source.resourceId, accessClass: classOf(source.resourceId) }));

  const mutations = input.actions
    .filter((action) => isMutation(action.operation))
    .map((action) => ({
      resourceId: action.resourceId,
      operation: action.operation,
      apiPath: action.apiPath,
    }));

  // Touch the class for every mutated resource too, so an unregistered one is reported.
  for (const mutation of mutations) classOf(mutation.resourceId);

  return accessSummarySchema.parse({
    appId: input.appId,
    environment: input.environment,
    reads,
    mutations,
    unregistered: [...unregistered].sort(),
  });
}

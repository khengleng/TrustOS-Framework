import { ApiError } from '@trustsystem/errors';
import type { WorkflowActor } from '@trustsystem/workflow-core';
import type { AssignmentStrategy, WorkflowAssignmentSpec } from '@trustsystem/workflow-definition';

/**
 * Assignment.
 *
 * Turning "this step is for a manager" into a task somebody can find. Four strategies
 * are implemented and five are declarable through a resolver — the split is in
 * `BUILT_IN_ASSIGNMENT_STRATEGIES` and a definition naming an unimplemented one
 * without a registered resolver fails validation, so the failure happens at
 * publication rather than at the first instance.
 *
 * Two properties matter more than the strategies themselves:
 *
 *   * **Assignment never widens access.** It decides whose queue a task appears in.
 *     Whether the actor may *act* is a separate question answered by the permission
 *     and the approval model — so a task wrongly assigned is a task in the wrong
 *     list, not an authorization bypass.
 *   * **Assignment respects the tenant boundary.** Every resolver receives the
 *     instance's organization and must not return a member of another one. The
 *     framework's own resolvers take the population from a `MemberDirectory` that is
 *     organization-scoped by construction.
 */

export interface AssignmentTarget {
  /** A named user. Exactly one of the three fields is set. */
  userId: string | null;
  /** Everyone holding this role in the organization. */
  role: string | null;
  /** Everyone in this group. */
  groupId: string | null;
  /** Which strategy produced this, for the history entry. */
  strategy: AssignmentStrategy;
  /** Why, in words. Written into the task's history. */
  rationale: string;
}

/**
 * The population a role or group resolves to.
 *
 * Deliberately narrow: three methods, all organization-scoped. A workflow package
 * that took a `PrismaClient` could query anything; this can answer three questions
 * about one organization and nothing else.
 */
export interface MemberDirectory {
  /** Active members holding a role, in a stable order. */
  listByRole(organizationId: string, role: string): Promise<string[]>;
  /** Active members of a group. */
  listByGroup(organizationId: string, groupId: string): Promise<string[]>;
  /** Whether a user is an active member. Used before a named assignment. */
  isActiveMember(organizationId: string, userId: string): Promise<boolean>;
}

/**
 * Application-supplied resolution for the strategies the framework does not implement.
 *
 * `organizational_unit`, `least_loaded`, `requester_manager`, `resource_owner` and
 * `external_resolver` all need something the framework does not have: an org chart,
 * a workload index, a manager relationship, an ownership model. Each is a real
 * product decision, and a framework guess at any of them would be wrong somewhere.
 */
export interface AssigneeResolver {
  /** Matches `resolverKey`, or the strategy name when no key is given. */
  readonly key: string;
  resolve(input: {
    organizationId: string;
    strategy: AssignmentStrategy;
    /** The instance's data, for a resolver that routes on it. */
    data: Record<string, unknown>;
    /** Who started the instance, for `requester_manager`. */
    initiatedById: string;
    businessObjectType: string;
    businessObjectId: string;
  }): Promise<AssignmentTarget | null>;
}

/**
 * Round-robin position.
 *
 * Persisted rather than in-memory, because the point of round-robin is that work is
 * distributed evenly across a team over time — and a counter that resets on every
 * deploy sends every task after a restart to the same person.
 *
 * `next` must be atomic. The Prisma implementation uses an upsert with an increment,
 * which Postgres executes as one statement; an in-memory implementation is only
 * correct in one process, and says so.
 */
export interface RoundRobinCursor {
  /** Returns the next index for a key, then advances. Must be atomic. */
  next(organizationId: string, key: string, populationSize: number): Promise<number>;
}

export class InMemoryRoundRobinCursor implements RoundRobinCursor {
  private readonly positions = new Map<string, number>();

  async next(organizationId: string, key: string, populationSize: number): Promise<number> {
    if (populationSize <= 0) return 0;
    const mapKey = `${organizationId}::${key}`;
    const current = this.positions.get(mapKey) ?? 0;
    this.positions.set(mapKey, (current + 1) % populationSize);
    return current % populationSize;
  }
}

export interface ResolveAssignmentInput {
  assignment: WorkflowAssignmentSpec;
  organizationId: string;
  /** Substituted for `${initiator}` in a named-user assignment. */
  initiatedById: string;
  data: Record<string, unknown>;
  businessObjectType: string;
  businessObjectId: string;
  stepKey: string;
}

export interface AssignmentContext {
  directory: MemberDirectory;
  cursor?: RoundRobinCursor;
  resolvers?: AssigneeResolver[];
}

/**
 * The one placeholder the framework substitutes.
 *
 * `${initiator}` in a named-user assignment means "the person who started this",
 * which is how a draft or rework step returns to its maker. It is a fixed
 * substitution rather than a template language, for the reason the condition
 * language is a predicate tree: a template evaluated against caller-supplied data is
 * an injection surface, and one placeholder covers the only case that has come up.
 */
export const INITIATOR_PLACEHOLDER = '${initiator}';

export async function resolveAssignment(
  input: ResolveAssignmentInput,
  context: AssignmentContext,
): Promise<AssignmentTarget> {
  const { assignment, organizationId } = input;

  switch (assignment.strategy) {
    case 'named_user': {
      const raw = assignment.userId as string;
      const userId = raw === INITIATOR_PLACEHOLDER ? input.initiatedById : raw;

      // Membership is checked, and a non-member is an error rather than an empty
      // assignment: a task assigned to somebody who left is a task nobody sees, and
      // silence here would make that the normal outcome of ordinary staff turnover.
      const active = await context.directory.isActiveMember(organizationId, userId);
      if (!active) {
        throw ApiError.conflict(
          `Cannot assign step "${input.stepKey}": ${
            raw === INITIATOR_PLACEHOLDER ? 'the initiator' : `user ${userId}`
          } is not an active member of this organization.`,
          { reason: 'assignment_unresolvable', stepKey: input.stepKey },
        );
      }

      return {
        userId,
        role: null,
        groupId: null,
        strategy: 'named_user',
        rationale:
          raw === INITIATOR_PLACEHOLDER
            ? 'Assigned to the initiator.'
            : 'Assigned to a named user.',
      };
    }

    case 'role':
      // Not resolved to individuals. The task sits in the pool for everyone holding
      // the role, and whoever is available claims it — which is the behaviour a
      // shared queue is for. Resolving to one person at creation would make the task
      // invisible when that person is on leave.
      return {
        userId: null,
        role: assignment.role as string,
        groupId: null,
        strategy: 'role',
        rationale: `Pooled to everyone holding "${assignment.role}".`,
      };

    case 'group':
      return {
        userId: null,
        role: null,
        groupId: assignment.groupId as string,
        strategy: 'group',
        rationale: `Pooled to group "${assignment.groupId}".`,
      };

    case 'round_robin': {
      const role = assignment.role as string;
      const population = await context.directory.listByRole(organizationId, role);

      if (population.length === 0) {
        throw ApiError.conflict(
          `Cannot assign step "${input.stepKey}": nobody in this organization holds "${role}".`,
          { reason: 'assignment_unresolvable', stepKey: input.stepKey, role },
        );
      }

      const cursor = context.cursor;
      if (!cursor) {
        throw ApiError.internal(
          'A round-robin assignment needs a RoundRobinCursor. Without one the rotation would ' +
            'restart on every request and every task would go to the same person.',
        );
      }

      // The population order has to be stable for a rotation to be a rotation. The
      // directory returns a stable order; the cursor indexes into it.
      const index = await cursor.next(
        organizationId,
        `${input.stepKey}:${role}`,
        population.length,
      );
      const userId = population[index] as string;

      return {
        userId,
        role: null,
        groupId: null,
        strategy: 'round_robin',
        rationale: `Round-robin position ${index + 1} of ${population.length} for "${role}".`,
      };
    }

    default: {
      // The declared-only strategies. Resolution belongs to the application.
      const key = assignment.resolverKey ?? assignment.strategy;
      const resolver = context.resolvers?.find((candidate) => candidate.key === key);

      if (!resolver) {
        throw ApiError.internal(
          `The "${assignment.strategy}" assignment strategy needs a resolver registered under ` +
            `"${key}". The framework implements named_user, role, group and round_robin; the ` +
            'rest need an org chart, a workload index or an ownership model that belongs to the ' +
            'application.',
        );
      }

      const target = await resolver.resolve({
        organizationId,
        strategy: assignment.strategy,
        data: input.data,
        initiatedById: input.initiatedById,
        businessObjectType: input.businessObjectType,
        businessObjectId: input.businessObjectId,
      });

      if (!target) {
        throw ApiError.conflict(`The resolver "${key}" could not assign step "${input.stepKey}".`, {
          reason: 'assignment_unresolvable',
          stepKey: input.stepKey,
          resolver: key,
        });
      }

      // A resolver is application code, and application code can be wrong. Assignment
      // is the boundary where a mistake becomes a cross-tenant task, so the result is
      // re-checked against the directory rather than trusted.
      if (target.userId) {
        const active = await context.directory.isActiveMember(organizationId, target.userId);
        if (!active) {
          throw ApiError.internal(
            `The resolver "${key}" returned user ${target.userId}, who is not an active member ` +
              'of this organization. Refusing to create a cross-tenant assignment.',
          );
        }
      }

      return target;
    }
  }
}

// --- eligibility -----------------------------------------------------------

/**
 * Whether an actor may act on a task, given how it was assigned.
 *
 * Three cases, and the differences are the whole model:
 *
 *   * assigned to a user — only that user, or somebody with reassign authority
 *   * pooled to a role — anybody holding the role, until one of them claims it
 *   * pooled to a group — anybody in the group, same rule
 *
 * Once claimed, a pooled task behaves like an assigned one. That is what claiming
 * means: it converts "anybody eligible" into "this person", which is what makes a
 * shared queue workable rather than a race everybody re-runs.
 */
export function isEligibleForTask(
  actor: WorkflowActor,
  task: {
    assigneeUserId: string | null;
    assigneeRole: string | null;
    assigneeGroupId: string | null;
    claimedById: string | null;
  },
): { eligible: boolean; reason: string } {
  // A claim narrows eligibility to the claimant. Checked first, because it overrides
  // the pooled rules — otherwise every eligible user would still see the task as
  // theirs and two people would work the same item.
  if (task.claimedById) {
    return isSame(actor.userId, task.claimedById)
      ? { eligible: true, reason: 'claimed_by_actor' }
      : { eligible: false, reason: 'claimed_by_another' };
  }

  if (task.assigneeUserId) {
    return isSame(actor.userId, task.assigneeUserId)
      ? { eligible: true, reason: 'named_assignee' }
      : { eligible: false, reason: 'assigned_to_another' };
  }

  if (task.assigneeRole) {
    return actor.roles.includes(task.assigneeRole)
      ? { eligible: true, reason: 'holds_assigned_role' }
      : { eligible: false, reason: 'missing_assigned_role' };
  }

  if (task.assigneeGroupId) {
    return actor.groupIds.includes(task.assigneeGroupId)
      ? { eligible: true, reason: 'member_of_assigned_group' }
      : { eligible: false, reason: 'not_in_assigned_group' };
  }

  /*
   * A task with no assignment at all.
   *
   * Not eligible — deliberately, and not even for platform staff. A task that
   * anybody can act on is a task the definition failed to assign, and the fix is the
   * definition. Treating it as open to all would turn an authoring bug into a
   * permanent hole that nobody notices because everything appears to work.
   */
  return { eligible: false, reason: 'task_has_no_assignment' };
}

function isSame(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b;
}

/** The filter for "tasks I could claim". Mirrors `isEligibleForTask`. */
export function eligibilityFilter(actor: WorkflowActor): {
  organizationId: string;
  assigneeUserId: string;
  roles: string[];
  groupIds: string[];
} {
  return {
    organizationId: actor.organizationId,
    assigneeUserId: actor.userId,
    roles: actor.roles,
    groupIds: actor.groupIds,
  };
}

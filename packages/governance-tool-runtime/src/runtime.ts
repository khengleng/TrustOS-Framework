import { ApiError } from '@trustsystem/errors';
import {
  GOVERNANCE_PERMISSIONS,
  accessRefused,
  type Environment,
  type InternalAction,
  type InternalApplication,
  type ResourceOperation,
} from '@trustsystem/governance-tool-core';
import type { GovernanceActorContext } from '@trustsystem/governance-auth-context';
import { assertTenantResolved } from '@trustsystem/governance-auth-context';
import type { ResourceRegistry } from '@trustsystem/governance-resource-policy';
import {
  DataAccessGuard,
  summarizeAccess,
  type AccessSummary,
  type ReadPlan,
  type MutationPlan,
} from '@trustsystem/governance-data-access';
import { MaskPolicy } from '@trustsystem/governance-pii-policy';
import {
  GOVERNANCE_AUDIT_ACTIONS,
  governanceAuditEntry,
  type GovernanceAuditBridge,
} from '@trustsystem/governance-audit-bridge';
import type { EnvironmentRegistry } from '@trustsystem/governance-environment-config';

/**
 * The Governance Tool runtime.
 *
 * Executes an internal application definition. Every request follows the same seven steps, in the
 * same order, and the order is the design:
 *
 *   1. **Resolve the tenant** from the verified actor. Never from a header, never from the app.
 *   2. **Check the environment.** The app's environment must be the one the runtime is serving;
 *      a DEV console served against PROD resources is the failure the whole environment package
 *      exists to prevent.
 *   3. **Find the declared source or action.** A request naming something the definition does not
 *      declare is refused — the definition is the surface, not a suggestion.
 *   4. **Check the Governance Tool permission.** Which decides whether the control renders.
 *   5. **Plan the access** through the data-access guard, which applies the class, the groups,
 *      the projection and the row bound.
 *   6. **Mask on the way out**, server-side.
 *   7. **Audit**, in the same call — including the refusals.
 *
 * Step 7 including refusals is the part most systems omit. A trail of successful reads answers
 * "what did they see" and not "what did they try", and the second question is the one an
 * investigation opens with.
 *
 * The runtime **produces plans and returns rows it was given**. It holds no database client and
 * no HTTP client: a deployment's executor takes a plan and runs it. That is what keeps the
 * decision and the execution from drifting — there is nothing for the executor to decide.
 */

export interface RuntimeOptions {
  registry: ResourceRegistry;
  environments: EnvironmentRegistry;
  audit: GovernanceAuditBridge;
  masking?: MaskPolicy;
  environment: Environment;
}

export interface RuntimeContext {
  actor: GovernanceActorContext;
  app: InternalApplication;
  correlationId: string;
  requestId?: string;
}

export interface ReadResult {
  plan: ReadPlan;
  /** Rows the executor returned, masked. */
  rows: Array<Record<string, unknown>>;
  /** Fields that were masked, so the UI can offer a reveal affordance where one is allowed. */
  maskedFields: string[];
  /** Fields the request asked for and did not get. */
  droppedFields: Array<{ field: string; reason: string }>;
}

export class GovernanceToolRuntime {
  private readonly guard: DataAccessGuard;
  private readonly masking: MaskPolicy;

  constructor(private readonly options: RuntimeOptions) {
    this.guard = new DataAccessGuard(options.registry);
    this.masking = options.masking ?? new MaskPolicy();
  }

  /**
   * Plans a read from a declared data source.
   *
   * The rows are not fetched here — the executor does that with the plan. What comes back is
   * everything needed to fetch them and nothing that could change what is fetched.
   */
  async planRead(
    context: RuntimeContext,
    dataSourceId: string,
    parameters: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<ReadPlan> {
    const organizationId = assertTenantResolved(context.actor);
    this.assertEnvironment(context.app);

    const source = context.app.dataSources.find((candidate) => candidate.id === dataSourceId);

    if (!source) {
      throw new ApiError('not_found', {
        message: `The application "${context.app.appId}" declares no data source "${dataSourceId}".`,
        context: { appId: context.app.appId, dataSourceId },
      });
    }

    try {
      const plan = this.guard.planRead(
        {
          environment: this.options.environment,
          organizationId,
          actorId: context.actor.actorId,
          actorGroups: context.actor.roles,
          appId: context.app.appId,
          correlationId: context.correlationId,
        },
        {
          resourceId: source.resourceId,
          operation: source.operation as ReadPlan['operation'],
          fields: source.fields,
          maxRows: source.maxRows,
          parameters,
        },
      );

      await this.audit(context, GOVERNANCE_AUDIT_ACTIONS.DATA_READ, source.resourceId, 'allowed');
      return plan;
    } catch (error) {
      /*
       * A refused read is audited too.
       *
       * A trail of successful reads answers "what did they see" and not "what did they try". The
       * second is the question an investigation opens with, and it is unanswerable afterwards if
       * nobody recorded the refusals.
       */
      await this.audit(
        context,
        GOVERNANCE_AUDIT_ACTIONS.DATA_READ_REFUSED,
        source.resourceId,
        'refused',
        error instanceof Error ? error.message : 'refused',
      );
      throw error;
    }
  }

  /** Masks the rows an executor returned, and reports what was masked. */
  finishRead(plan: ReadPlan, rows: ReadonlyArray<Readonly<Record<string, unknown>>>): ReadResult {
    const bounded = rows.slice(0, plan.maxRows);

    return {
      plan,
      rows: bounded.map((row) => this.masking.maskRow(row)),
      maskedFields:
        bounded.length > 0 ? this.masking.maskedFields(bounded[0] as Record<string, unknown>) : [],
      droppedFields: plan.droppedFields,
    };
  }

  /**
   * Plans a mutation from a declared action.
   *
   * Refuses an action the definition does not declare, an action the actor cannot see, an action
   * missing a required reason, and — through the guard — any mutation that is not Class B routed
   * through the gateway.
   */
  async planMutation(
    context: RuntimeContext,
    actionId: string,
    input: { reason?: string; approvalRef?: string } = {},
  ): Promise<MutationPlan> {
    const organizationId = assertTenantResolved(context.actor);
    this.assertEnvironment(context.app);

    const action = context.app.actions.find((candidate) => candidate.id === actionId);

    if (!action) {
      throw new ApiError('not_found', {
        message: `The application "${context.app.appId}" declares no action "${actionId}".`,
        context: { appId: context.app.appId, actionId },
      });
    }

    this.assertPermission(context, action);

    if (action.requiresReason && (input.reason ?? '').trim().length < 10) {
      throw new ApiError('validation_error', {
        message:
          `"${action.label}" needs a reason. It is recorded on the audit entry and shown to ` +
          'whoever reviews it.',
        details: [{ path: 'reason', message: 'At least ten characters.' }],
      });
    }

    if (action.requiresApproval && !input.approvalRef) {
      throw new ApiError('forbidden', {
        message:
          `"${action.label}" needs an approval before it runs. Submit the request and it will ` +
          'appear in the approval workbench.',
        context: { actionId, appId: context.app.appId },
      });
    }

    try {
      const plan = this.guard.planMutation(
        {
          environment: this.options.environment,
          organizationId,
          actorId: context.actor.actorId,
          actorGroups: context.actor.roles,
          appId: context.app.appId,
          correlationId: context.correlationId,
        },
        {
          resourceId: action.resourceId,
          operation: action.operation as MutationPlan['operation'],
          apiPath: action.apiPath,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      );

      await this.audit(
        context,
        GOVERNANCE_AUDIT_ACTIONS.MUTATION_REQUESTED,
        action.resourceId,
        'allowed',
        input.reason ?? null,
        input.approvalRef ?? null,
      );

      return plan;
    } catch (error) {
      await this.audit(
        context,
        GOVERNANCE_AUDIT_ACTIONS.MUTATION_REFUSED,
        action.resourceId,
        'refused',
        error instanceof Error ? error.message : 'refused',
      );
      throw error;
    }
  }

  /** What this application is allowed to reach, for a security reviewer. Derived, not described. */
  accessSummary(app: InternalApplication): AccessSummary {
    return summarizeAccess({
      appId: app.appId,
      environment: this.options.environment,
      registry: this.options.registry,
      dataSources: app.dataSources.map((source) => ({
        resourceId: source.resourceId,
        operation: source.operation as ResourceOperation,
      })),
      actions: app.actions.map((action) => ({
        resourceId: action.resourceId,
        operation: action.operation as ResourceOperation,
        apiPath: action.apiPath,
      })),
    });
  }

  /**
   * The navigation a specific person sees.
   *
   * Pages whose permission the actor does not hold are **omitted**, not disabled. A disabled
   * navigation entry tells somebody a console exists and that they cannot open it, which is
   * information they did not need and occasionally should not have.
   *
   * Actions are the opposite: disabled with a reason, because the reason teaches the rule at the
   * moment somebody is about to break it. The difference is that a page is a place and an action
   * is a decision.
   */
  navigationFor(context: RuntimeContext): Array<{ id: string; title: string }> {
    return context.app.pages
      .filter((page) => context.actor.permissions.includes(page.permission))
      .map((page) => ({ id: page.id, title: page.title }));
  }

  private assertEnvironment(app: InternalApplication): void {
    if (app.environment === this.options.environment) return;

    throw new ApiError('forbidden', {
      message:
        `This is the ${app.environment} version of "${app.appId}" and the runtime is serving ` +
        `${this.options.environment}. Promote it rather than pointing it at another ` +
        'environment’s resources.',
      context: { appEnvironment: app.environment, runtimeEnvironment: this.options.environment },
    });
  }

  private assertPermission(context: RuntimeContext, action: InternalAction): void {
    if (context.actor.permissions.includes(action.permission)) return;

    /*
     * This decides whether the control *renders*. The API behind it authorizes again, and that
     * is the control — so this refusal is deliberately a friendly one rather than a security
     * boundary.
     */
    throw new ApiError('forbidden', {
      message: `You do not have "${action.permission}" in the Governance Tool.`,
      context: { actionId: action.id, permission: action.permission },
    });
  }

  private async audit(
    context: RuntimeContext,
    action: string,
    resourceId: string,
    outcome: 'allowed' | 'refused' | 'failed',
    reason: string | null = null,
    approvalRef: string | null = null,
  ): Promise<void> {
    await this.options.audit.record(
      governanceAuditEntry({
        appId: context.app.appId,
        appName: context.app.name,
        environment: this.options.environment,
        action,
        resourceType: 'GovernanceResource',
        resourceId,
        actorId: context.actor.actorId,
        actorType: context.actor.actorType,
        organizationId: context.actor.organizationId,
        outcome,
        correlationId: context.correlationId,
        now: new Date(),
        reason,
        approvalRef,
        requestId: context.requestId ?? null,
      }),
    );
  }
}

/** The permission a page needs, exported so a console can be checked without a runtime. */
export function pagePermissions(app: InternalApplication): string[] {
  return [...new Set(app.pages.map((page) => page.permission))].sort();
}

export { GOVERNANCE_PERMISSIONS, accessRefused };

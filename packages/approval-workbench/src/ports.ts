import type {
  WorkflowActor,
  WorkflowDecisionRecord,
  WorkflowInstanceRecord,
  WorkflowTaskRecord,
} from '@trustos/workflow-core';

/**
 * What the Approval Workbench is allowed to reach.
 *
 * Every port here is satisfied by something that already exists — `TaskService`,
 * `WorkflowEngine`, `CommentService`, `AuditService`. They are restated as narrow
 * interfaces for one reason: the shape of a port is the shape of the permission.
 *
 * Note what is *absent*. There is no port that writes an instance, sets a state, or
 * creates a decision. The only mutation this application can perform is
 * `EnginePort.transition`, which authorizes, evaluates policy, applies maker-checker,
 * records the decision, completes the task and writes audit — all inside the engine.
 * An application that held a store handle would eventually use it, and the day it did,
 * every control in that list would be bypassed by one line.
 *
 * Every read is organization-scoped by parameter rather than by convention, and the
 * organization is taken from the verified actor at the call site, never from input.
 */

/** Pooled and assigned task reads. Satisfied by `TaskService` and its store. */
export interface TaskQueryPort {
  /** Tasks the actor is eligible for, resolved server-side from roles and groups. */
  listAvailable(
    actor: WorkflowActor,
    page: number,
    pageSize: number,
  ): Promise<{ items: WorkflowTaskRecord[]; total: number; page: number; pageSize: number }>;

  /** Tasks assigned to the actor by name. */
  listMine(
    actor: WorkflowActor,
    page: number,
    pageSize: number,
  ): Promise<{ items: WorkflowTaskRecord[]; total: number; page: number; pageSize: number }>;

  /** Scoped find. Throws or returns null for another tenant's task. */
  find(actor: WorkflowActor, taskId: string): Promise<WorkflowTaskRecord>;
}

/** Instance reads. Satisfied by `WorkflowEngine`. */
export interface EnginePort {
  /** Scoped. Refuses another tenant's instance as not found. */
  find(actor: WorkflowActor, instanceId: string): Promise<WorkflowInstanceRecord>;

  list(
    actor: WorkflowActor,
    query: {
      status?: string[];
      currentState?: string[];
      businessObjectType?: string;
      page: number;
      pageSize: number;
    },
  ): Promise<{ items: WorkflowInstanceRecord[]; total: number; page: number; pageSize: number }>;

  /** The actions the definition and the actor's authority permit, right now. */
  available(actor: WorkflowActor, instanceId: string): Promise<string[]>;

  /**
   * The only mutation. Authorization, policy, maker-checker, decision recording,
   * task completion and audit all happen inside it.
   */
  transition(
    actor: WorkflowActor,
    input: {
      instanceId: string;
      action: string;
      expectedVersion?: number;
      reasonCode?: string | null;
      explanation?: string | null;
      taskId?: string | null;
      idempotencyKey?: string | null;
      requestId?: string | null;
    },
  ): Promise<{
    instance: WorkflowInstanceRecord;
    from: string;
    to: string;
    action: string;
    decisionId: string;
  }>;
}

/**
 * Decision history. Satisfied by the engine's decision store.
 *
 * Positional, matching the framework's own signature rather than a friendlier one of
 * this application's invention. A port that restates a dependency in a different shape
 * has to be adapted at every call site, and an adapter that silently builds the wrong
 * query is exactly what happened here the first time.
 */
export interface DecisionPort {
  listForInstance(
    workflowInstanceId: string,
    organizationId: string,
  ): Promise<WorkflowDecisionRecord[]>;
}

/** Audit reads. Satisfied by `AuditService`. Read-only by construction. */
export interface AuditPort {
  query(query: {
    organizationId: string | null;
    entityType?: string;
    entityId?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    items: Array<
      { id: string; action: string; actorId: string | null; createdAt: Date } & {
        [key: string]: unknown;
      }
    >;
    totalItems: number;
  }>;
}

/**
 * Comments, when the deployment wires them.
 *
 * Optional on purpose: a deployment without a comment store must report the feature
 * as unavailable rather than render an empty list, which reads as "no one commented".
 */
export interface CommentPort {
  list(
    actor: WorkflowActor,
    input: { workflowInstanceId: string; page: number; pageSize: number },
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }>;

  add(
    actor: WorkflowActor,
    input: { workflowInstanceId: string; body: string; visibility?: string },
  ): Promise<Record<string, unknown>>;
}

/** Reassignment, when the deployment wires it. Satisfied by `TaskService.reassign`. */
export interface ReassignmentPort {
  reassign(
    actor: WorkflowActor,
    taskId: string,
    input: { assigneeUserId: string; reason: string },
  ): Promise<WorkflowTaskRecord>;
}

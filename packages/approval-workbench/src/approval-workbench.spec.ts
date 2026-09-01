import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@trustos/errors';
import type { WorkflowActor } from '@trustos/workflow-core';
import { ApprovalWorkbenchService } from './service';
import { approvalQueueQuerySchema, decisionRequestSchema } from './models';
import type { AuditPort, DecisionPort, EnginePort, TaskQueryPort } from './ports';

/*
 * Tests for the application, not for the framework.
 *
 * The controls this application relies on — authorization, maker-checker, tenant
 * isolation, policy — are tested where they live, and re-asserting them here against a
 * stub would prove only that the stub works. What is tested here is the thing that is
 * genuinely this application's responsibility and genuinely easy to get wrong: that it
 * *delegates*, and that it cannot be talked out of delegating by its input.
 *
 * So most of these assert on what the service passed to the engine, not on what the
 * engine returned. An application that submits the caller's organization, or that
 * decides for itself that an action is allowed, fails here.
 */

const ACTOR: WorkflowActor = {
  userId: 'user_checker',
  actorType: 'user',
  email: 'checker@tenant-a.test',
  tokenId: 'tok_1',
  organizationId: 'org_a',
  roles: ['approver'],
  permissions: ['workflow.transition.approve'],
  isSuperAdmin: false,
  groupIds: [],
  authenticationLevel: 'high',
  mfa: true,
};

function instance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wfi_1',
    organizationId: 'org_a',
    workflowDefinitionId: 'def_1',
    workflowVersionId: 'ver_1',
    workflowVersion: '1.0.0',
    status: 'active',
    currentState: 'manager_review',
    businessObjectType: 'access_change_request',
    businessObjectId: 'acr_1',
    data: { title: 'Grant finance read' },
    priority: 'normal',
    initiatedById: 'user_maker',
    initiatedByActorType: 'user',
    version: 4,
    reworkCount: 0,
    startedAt: new Date('2026-08-01T09:00:00Z'),
    completedAt: null,
    cancelledAt: null,
    cancelledById: null,
    cancellationReason: null,
    dueAt: new Date('2026-08-05T09:00:00Z'),
    caseId: null,
    createdAt: new Date('2026-08-01T09:00:00Z'),
    updatedAt: new Date('2026-08-01T09:00:00Z'),
    ...overrides,
  } as never;
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task_1',
    organizationId: 'org_a',
    workflowInstanceId: 'wfi_1',
    stepKey: 'manager_review',
    title: 'Approve access change',
    description: '',
    status: 'open',
    priority: 'high',
    assigneeUserId: null,
    assigneeRole: 'approver',
    assigneeGroupId: null,
    dueAt: new Date('2026-08-05T09:00:00Z'),
    slaStatus: null,
    claimedById: null,
    claimedAt: null,
    completedById: null,
    completedAt: null,
    outcome: null,
    delegatedById: null,
    delegatedAt: null,
    version: 1,
    createdAt: new Date('2026-08-01T09:00:00Z'),
    updatedAt: new Date('2026-08-01T09:00:00Z'),
    ...overrides,
  } as never;
}

function build(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}) {
  const options = makeOptions(overrides);
  return { service: new ApprovalWorkbenchService(options), ...options };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  const transition = vi.fn(async () => ({
    instance: instance({ currentState: 'approved', version: 5 }),
    from: 'manager_review',
    to: 'approved',
    action: 'approve',
    decisionId: 'dec_1',
  }));

  const engine: EnginePort = {
    find: vi.fn(async () => instance()),
    list: vi.fn(async () => ({ items: [instance()], total: 1, page: 1, pageSize: 20 })),
    available: vi.fn(async () => ['approve', 'reject']),
    transition,
    ...(overrides['engine'] as object),
  } as EnginePort;

  const tasks: TaskQueryPort = {
    listAvailable: vi.fn(async () => ({ items: [task()], total: 1, page: 1, pageSize: 20 })),
    listMine: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    find: vi.fn(async () => task()),
    ...(overrides['tasks'] as object),
  } as TaskQueryPort;

  const decisions: DecisionPort = {
    listForInstance: vi.fn(async () => []),
    ...(overrides['decisions'] as object),
  } as DecisionPort;

  const audit: AuditPort = {
    query: vi.fn(async () => ({ items: [], totalItems: 0 })),
    ...(overrides['audit'] as object),
  } as AuditPort;

  return { engine, tasks, decisions, audit, now: () => new Date('2026-08-02T09:00:00Z') };
}

describe('the queue', () => {
  it('reads real tasks and joins them to the instance that produced them', async () => {
    const { service } = build();

    const page = await service.queue(ACTOR, { scope: 'available' });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      taskId: 'task_1',
      workflowInstanceId: 'wfi_1',
      requestId: 'acr_1',
      requestType: 'access_change_request',
      requestedBy: 'user_maker',
      currentState: 'manager_review',
      version: 4,
    });
  });

  it('asks the framework for eligibility rather than reading a role name', async () => {
    // The distinction the whole application rests on: eligibility is resolved
    // server-side from roles and groups, and this class never inspects `actor.roles`.
    const { service, tasks } = build();

    await service.queue(ACTOR, { scope: 'available' });

    expect(tasks.listAvailable).toHaveBeenCalledWith(ACTOR, 1, 20);
    expect(tasks.listMine).not.toHaveBeenCalled();
  });

  it('carries the instance version on every row, so a decision can prove freshness', async () => {
    const { service } = build();

    const page = await service.queue(ACTOR, { scope: 'available' });

    expect(page.rows[0]?.version).toBe(4);
  });

  it('drops a row whose instance the actor cannot read, rather than half-rendering it', async () => {
    // A task can outlive an actor's access to its instance. A row with the instance
    // fields blank invites somebody to click it.
    const { service } = build({
      engine: {
        find: vi.fn(async () => {
          throw ApiError.notFound();
        }),
      },
    });

    const page = await service.queue(ACTOR, { scope: 'available' });

    expect(page.rows).toEqual([]);
  });

  it('refuses a query that tries to carry its own organization', () => {
    // `.strict()` is the control: there is no organization input to tamper with.
    expect(() =>
      approvalQueueQuerySchema.parse({ scope: 'available', organizationId: 'org_b' }),
    ).toThrow();
  });

  it('refuses a page size beyond the cap', () => {
    expect(() => approvalQueueQuerySchema.parse({ pageSize: 5000 })).toThrow();
  });

  it('sorts undated rows last rather than treating them as the most urgent thing', async () => {
    // The instance must be undated too: a task with no date of its own inherits the
    // instance's, which is deliberate and is not what this test is about.
    const { service } = build({
      engine: { find: vi.fn(async () => instance({ dueAt: null })) },
      tasks: {
        listAvailable: vi.fn(async () => ({
          items: [task({ id: 'task_undated', dueAt: null }), task({ id: 'task_dated' })],
          total: 2,
          page: 1,
          pageSize: 20,
        })),
      },
    });

    const page = await service.queue(ACTOR, { scope: 'available', sortBy: 'dueAt' });

    expect(page.rows.at(-1)?.dueAt).toBeNull();
  });
});

describe('the detail view', () => {
  it('reads through the scoped find, which is the authorization boundary', async () => {
    const { service, engine } = build();

    await service.detail(ACTOR, 'wfi_1');

    expect(engine.find).toHaveBeenCalledWith(ACTOR, 'wfi_1');
  });

  it('propagates a cross-tenant read as not found, never as forbidden', async () => {
    // "Forbidden" confirms the record exists. The framework's convention is not-found,
    // and this application must not soften it into something more helpful.
    const { service } = build({
      engine: {
        find: vi.fn(async () => {
          throw ApiError.notFound();
        }),
      },
    });

    await expect(service.detail(ACTOR, 'wfi_other_tenant')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('takes eligible actions from the engine, not from the actor s roles', async () => {
    const { service, engine } = build();

    const detail = await service.detail(ACTOR, 'wfi_1');

    expect(engine.available).toHaveBeenCalledWith(ACTOR, 'wfi_1');
    expect(detail.eligibleActions).toEqual(['approve', 'reject']);
  });

  it('surfaces the policy decision that permitted each recorded decision', async () => {
    const { service } = build({
      decisions: {
        listForInstance: vi.fn(async () => [
          {
            id: 'dec_1',
            organizationId: 'org_a',
            workflowInstanceId: 'wfi_1',
            workflowTaskId: 'task_1',
            stepKey: 'manager_review',
            approverKey: 'manager',
            actorId: 'user_checker',
            actorType: 'user',
            actorRole: 'approver',
            decision: 'approved',
            reasonCode: null,
            explanation: null,
            policyDecisionId: 'pol_9',
            reworkCycle: 0,
            decidedAt: new Date('2026-08-02T08:00:00Z'),
          },
        ]) as never,
      },
    });

    const detail = await service.detail(ACTOR, 'wfi_1');

    expect(detail.decisions[0]?.policyDecisionId).toBe('pol_9');
  });

  it('reports comments as unavailable rather than as an empty list', async () => {
    // An empty list reads as "nobody commented". That is a different claim.
    const { service } = build();

    const detail = await service.detail(ACTOR, 'wfi_1');

    expect(detail.comments).toEqual({
      available: false,
      reason: 'Comments are not configured for this deployment.',
    });
    expect(detail.attachments.available).toBe(false);
  });

  it('queries the entity type the history recorder actually writes', async () => {
    /*
     * A cross-package string constant with nothing in the type system connecting the
     * read to the write. It was `workflow_instance`; the recorder writes
     * `WorkflowInstance`, so the timeline was empty for every request — and an empty
     * timeline reads as "nothing happened" rather than "wrong query". Found by driving
     * a real transition and reading the trail back.
     */
    const { service, audit } = build();

    await service.detail(ACTOR, 'wfi_1');

    expect(audit.query).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'WorkflowInstance' }),
    );
  });

  it('scopes the audit read to the actor s own tenant', async () => {
    const { service, audit } = build();

    await service.detail(ACTOR, 'wfi_1');

    expect(audit.query).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_a', entityId: 'wfi_1' }),
    );
  });
});

describe('submitting a decision', () => {
  it('hands the whole decision to the engine, with the version the screen was built at', async () => {
    const { service, engine } = build();

    await service.decide(
      ACTOR,
      'wfi_1',
      { action: 'approve', expectedVersion: 4, idempotencyKey: 'click-abc123' },
      { taskId: 'task_1' },
    );

    expect(engine.transition).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({
        instanceId: 'wfi_1',
        action: 'approve',
        expectedVersion: 4,
        taskId: 'task_1',
        idempotencyKey: 'click-abc123',
      }),
    );
  });

  it('does not pre-check permission and then submit', async () => {
    /*
     * Asking first and acting second is a race: the answer can change between the two
     * calls, and the code that trusts the first answer is the code that records the
     * decision. `available` is for drawing buttons, not for gating a submission.
     */
    const { service, engine } = build();

    await service.decide(ACTOR, 'wfi_1', { action: 'approve', expectedVersion: 4 });

    expect(engine.available).not.toHaveBeenCalled();
  });

  it('surfaces the engine s refusal unchanged', async () => {
    // Including self-approval: the reason code is the engine's, not a message this
    // application composed.
    const { service } = build({
      engine: {
        transition: vi.fn(async () => {
          throw ApiError.forbidden('Refused.', { reason: 'self_approval_forbidden' });
        }),
      },
    });

    await expect(
      service.decide(ACTOR, 'wfi_1', { action: 'approve', expectedVersion: 4 }),
    ).rejects.toMatchObject({ context: { reason: 'self_approval_forbidden' } });
  });

  it('requires a version, so a decision cannot be submitted from a screen of unknown age', () => {
    expect(() => decisionRequestSchema.parse({ action: 'approve' })).toThrow();
  });

  it('requires a reason to reject', async () => {
    const { service, engine } = build();

    await expect(
      service.decide(ACTOR, 'wfi_1', { action: 'reject', expectedVersion: 4 }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    // And it never reached the engine, so no decision was recorded.
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('requires a reason to return for rework', async () => {
    const { service } = build();

    await expect(
      service.decide(ACTOR, 'wfi_1', { action: 'return_for_rework', expectedVersion: 4 }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses an action the workbench does not offer', async () => {
    const { service, engine } = build();

    await expect(
      service.decide(ACTOR, 'wfi_1', { action: 'cancel', expectedVersion: 4 }),
    ).rejects.toThrow();
    expect(engine.transition).not.toHaveBeenCalled();
  });

  it('refuses a submission carrying an actor or a tenant of its own', () => {
    // The schema is strict, so a tampered body is rejected rather than partially honoured.
    expect(() =>
      decisionRequestSchema.parse({
        action: 'approve',
        expectedVersion: 4,
        actorId: 'user_someone_else',
      }),
    ).toThrow();

    expect(() =>
      decisionRequestSchema.parse({
        action: 'approve',
        expectedVersion: 4,
        organizationId: 'org_b',
      }),
    ).toThrow();
  });
});

describe('capabilities a deployment has not wired', () => {
  it('refuses reassignment rather than pretending to reassign', async () => {
    const { service } = build();

    await expect(
      service.reassign(ACTOR, 'task_1', { assigneeUserId: 'user_x', reason: 'on leave' }),
    ).rejects.toMatchObject({ context: { reason: 'reassignment_unavailable' } });
  });

  it('refuses a comment rather than discarding it', async () => {
    const { service } = build();

    await expect(service.comment(ACTOR, 'wfi_1', 'looks fine')).rejects.toMatchObject({
      context: { reason: 'comments_unavailable' },
    });
  });
});

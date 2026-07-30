import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustos/errors';
import {
  createTestModuleContext,
  createTestClock,
  type RecordingAuditPort,
} from '@trustos/module-sdk';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { workflowConfigSchema } from './config';
import {
  assertStepsWellFormed,
  dualApprovalDefinition,
  makerCheckerDefinition,
} from './definition';
import { RecordingEscalationHook } from './escalation';
import { HISTORY_ACTIONS } from './workflow.service';
import { createWorkflow, workflowModule } from './workflow.module';
import type { WorkflowService } from './workflow.service';

/**
 * The workflow module.
 *
 * The maker-checker tests are the ones that matter: an approval chain whose
 * submitter can approve their own request is not a control, and every regulated
 * product installing this module inherits whatever these tests allow.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const MAKER = 'user_maker';
const CHECKER = 'user_checker';
const SECOND_CHECKER = 'user_checker_2';

const APPROVE = 'payments.payout.approve';
const APPROVE_SECOND = 'payments.payout.approve_second';

interface Harness {
  service: WorkflowService;
  audit: RecordingAuditPort;
  escalation: RecordingEscalationHook;
  tasks: FakeModelDelegate;
  clock: ReturnType<typeof createTestClock>;
}

function buildHarness(config: Record<string, unknown> = {}): Harness {
  const definitions = new FakeModelDelegate([]);
  const instances = new FakeModelDelegate([]);
  const tasks = new FakeModelDelegate([]);
  const history = new FakeModelDelegate([]);

  const escalation = new RecordingEscalationHook();
  const clock = createTestClock();

  const { context, audit } = createTestModuleContext(workflowModule, {
    config,
    prisma: {
      workflowDefinition: definitions,
      workflowInstance: instances,
      workflowTask: tasks,
      workflowHistoryEntry: history,
    },
  });

  // The SDK's test context fixes the clock; workflow needs one that moves so SLA
  // breaches are reachable.
  const movable = { ...context, clock: clock.now };
  const instance = createWorkflow(movable, { escalation });

  return { service: instance.service, audit, escalation, tasks, clock };
}

const as = <T>(organizationId: string, actorId: string, fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId, actorId, isSuperAdmin: false }, fn);

const asAcme = <T>(fn: () => Promise<T>, actorId = MAKER): Promise<T> => as(ACME, actorId, fn);
const asRival = <T>(fn: () => Promise<T>, actorId = 'user_rival'): Promise<T> =>
  as(RIVAL, actorId, fn);

/** Registers the maker-checker definition and starts one instance. */
async function startMakerChecker(harness: Harness) {
  await asAcme(() =>
    harness.service.registerDefinition(
      makerCheckerDefinition({
        key: 'payout.approval',
        name: 'Payout approval',
        checkerPermission: APPROVE,
      }),
      ACME,
    ),
  );

  return asAcme(() =>
    harness.service.start(
      { definitionKey: 'payout.approval', subjectType: 'Payout', subjectId: 'pay_1' },
      ACME,
      MAKER,
    ),
  );
}

describe('maker-checker: separation of duties', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses to let the submitter approve their own request', async () => {
    const { task } = await startMakerChecker(harness);

    try {
      await asAcme(() => harness.service.approve(task.id, ACME, MAKER, [APPROVE]), MAKER);
      expect.unreachable('the submitter must not be able to approve');
    } catch (error) {
      expect((error as ApiError).code).toBe('forbidden');
      expect((error as ApiError).message).toMatch(/may not approve/);
    }
  });

  it('audits the blocked attempt rather than refusing silently', async () => {
    const { task, instance } = await startMakerChecker(harness);

    await asAcme(() => harness.service.approve(task.id, ACME, MAKER, [APPROVE]), MAKER).catch(
      () => undefined,
    );

    // An attempted self-approval is precisely what a reviewer wants to see.
    expect(harness.audit.byAction('workflow.task.self-approval-blocked')).toHaveLength(1);

    const history = await asAcme(() => harness.service.history(instance.id, ACME));
    expect(history.map((entry) => entry.action)).toContain(HISTORY_ACTIONS.SELF_APPROVAL_BLOCKED);
  });

  it('lets a different person with the permission approve', async () => {
    const { task } = await startMakerChecker(harness);

    const result = await asAcme(
      () => harness.service.approve(task.id, ACME, CHECKER, [APPROVE]),
      CHECKER,
    );

    expect(result.task.status).toBe('APPROVED');
    expect(result.instance.status).toBe('APPROVED');
  });

  it('refuses an approver who does not hold the step permission', async () => {
    const { task } = await startMakerChecker(harness);

    // The route permission says "may act on tasks"; the step names the permission
    // this particular approval requires. They are different statements.
    await expect(
      asAcme(() => harness.service.approve(task.id, ACME, CHECKER, ['something.else']), CHECKER),
    ).rejects.toThrow(/do not hold the permission/);
  });

  it('refuses the submitter rejecting their own request too', async () => {
    const { task } = await startMakerChecker(harness);

    // Withdrawal is `cancel`; a self-rejection would read as an independent
    // decision in the trail.
    await expect(
      asAcme(() => harness.service.reject(task.id, ACME, MAKER, [APPROVE]), MAKER),
    ).rejects.toThrow(/may not approve/);
  });

  it('honours an explicit, audited exception when a step allows it', async () => {
    await asAcme(() =>
      harness.service.registerDefinition(
        {
          key: 'self.serve',
          name: 'Self serve',
          description: 'Deliberate exception.',
          steps: [
            {
              order: 1,
              name: 'Acknowledge',
              approverPermission: APPROVE,
              requiredApprovals: 1,
              slaMinutes: 60,
              allowSubmitterApproval: true,
            },
          ],
        },
        ACME,
      ),
    );

    const { task } = await asAcme(() =>
      harness.service.start(
        { definitionKey: 'self.serve', subjectType: 'Note', subjectId: 'n1' },
        ACME,
        MAKER,
      ),
    );

    const result = await asAcme(
      () => harness.service.approve(task.id, ACME, MAKER, [APPROVE]),
      MAKER,
    );
    expect(result.instance.status).toBe('APPROVED');
  });
});

describe('approval counting', () => {
  it('counts distinct approvers, not decisions', async () => {
    const harness = buildHarness();

    await asAcme(() =>
      harness.service.registerDefinition(
        {
          key: 'two.eyes',
          name: 'Two approvals',
          description: '',
          steps: [
            {
              order: 1,
              name: 'Dual approval',
              approverPermission: APPROVE,
              requiredApprovals: 2,
              slaMinutes: 60,
              allowSubmitterApproval: false,
            },
          ],
        },
        ACME,
      ),
    );

    const { task } = await asAcme(() =>
      harness.service.start(
        { definitionKey: 'two.eyes', subjectType: 'Payout', subjectId: 'p1' },
        ACME,
        MAKER,
      ),
    );

    const first = await asAcme(
      () => harness.service.approve(task.id, ACME, CHECKER, [APPROVE]),
      CHECKER,
    );
    expect(first.instance.status).toBe('RUNNING');

    // The same person clicking twice must not satisfy a two-approver step.
    await expect(
      asAcme(() => harness.service.approve(task.id, ACME, CHECKER, [APPROVE]), CHECKER),
    ).rejects.toThrow(/already approved/);

    const second = await asAcme(
      () => harness.service.approve(task.id, ACME, SECOND_CHECKER, [APPROVE]),
      SECOND_CHECKER,
    );
    expect(second.instance.status).toBe('APPROVED');
  });

  it('advances through a multi-step definition in order', async () => {
    const harness = buildHarness();

    await asAcme(() =>
      harness.service.registerDefinition(
        dualApprovalDefinition({
          key: 'large.payout',
          name: 'Large payout',
          firstPermission: APPROVE,
          secondPermission: APPROVE_SECOND,
        }),
        ACME,
      ),
    );

    const { task, instance } = await asAcme(() =>
      harness.service.start(
        { definitionKey: 'large.payout', subjectType: 'Payout', subjectId: 'p2' },
        ACME,
        MAKER,
      ),
    );

    const afterFirst = await asAcme(
      () => harness.service.approve(task.id, ACME, CHECKER, [APPROVE]),
      CHECKER,
    );
    expect(afterFirst.instance.currentStep).toBe(2);
    expect(afterFirst.instance.status).toBe('RUNNING');

    const open = await asAcme(() => harness.service.tasksFor([APPROVE_SECOND], ACME), CHECKER);
    expect(open.map((row) => row.stepOrder)).toEqual([2]);

    const afterSecond = await asAcme(
      () => harness.service.approve(open[0]!.id, ACME, SECOND_CHECKER, [APPROVE_SECOND]),
      SECOND_CHECKER,
    );
    expect(afterSecond.instance.status).toBe('APPROVED');

    const history = await asAcme(() => harness.service.history(instance.id, ACME));
    expect(history.map((entry) => entry.action)).toEqual([
      HISTORY_ACTIONS.TASK_ASSIGNED,
      HISTORY_ACTIONS.STARTED,
      HISTORY_ACTIONS.APPROVED,
      HISTORY_ACTIONS.TASK_ASSIGNED,
      HISTORY_ACTIONS.APPROVED,
      HISTORY_ACTIONS.COMPLETED,
    ]);
  });
});

describe('terminal states', () => {
  it('rejects an instance on the first rejection and refuses further changes', async () => {
    const harness = buildHarness();
    const { task, instance } = await startMakerChecker(harness);

    const rejected = await asAcme(
      () => harness.service.reject(task.id, ACME, CHECKER, [APPROVE], { comment: 'Not allowed.' }),
      CHECKER,
    );
    expect(rejected.instance.status).toBe('REJECTED');

    await expect(
      asAcme(() => harness.service.approve(task.id, ACME, SECOND_CHECKER, [APPROVE])),
    ).rejects.toThrow(/is REJECTED and cannot be changed/);
    await expect(asAcme(() => harness.service.cancel(instance.id, ACME, MAKER))).rejects.toThrow(
      /cannot be changed/,
    );
  });

  it('refuses to act on a task that has already been decided', async () => {
    const harness = buildHarness();
    const { task } = await startMakerChecker(harness);

    await asAcme(() => harness.service.approve(task.id, ACME, CHECKER, [APPROVE]), CHECKER);
    await expect(
      asAcme(() => harness.service.reject(task.id, ACME, SECOND_CHECKER, [APPROVE])),
    ).rejects.toThrow(/cannot be changed|already/);
  });

  it('cancels the instance and its open tasks', async () => {
    const harness = buildHarness();
    const { instance } = await startMakerChecker(harness);

    await asAcme(() => harness.service.cancel(instance.id, ACME, MAKER, { comment: 'Withdrawn.' }));

    expect(await asAcme(() => harness.service.tasksFor([APPROVE], ACME))).toHaveLength(0);
    expect(harness.audit.byAction('workflow.instance.cancelled')).toHaveLength(1);
  });

  it('refuses to redefine a definition that already exists', async () => {
    const harness = buildHarness();
    await startMakerChecker(harness);

    // A running instance holds a step index into the definition it started with.
    await expect(
      asAcme(() =>
        harness.service.registerDefinition(
          makerCheckerDefinition({
            key: 'payout.approval',
            name: 'Changed',
            checkerPermission: 'something.else',
          }),
          ACME,
        ),
      ),
    ).rejects.toThrow(/already exists/);
  });
});

describe('task visibility', () => {
  it('shows a task only to a caller holding the step permission', async () => {
    const harness = buildHarness();
    await startMakerChecker(harness);

    expect(await asAcme(() => harness.service.tasksFor([APPROVE], ACME))).toHaveLength(1);
    // A task list that shows work someone cannot do discloses what is in flight
    // elsewhere in the organization.
    expect(await asAcme(() => harness.service.tasksFor(['unrelated.read'], ACME))).toHaveLength(0);
  });

  it('shows everything to a wildcard holder', async () => {
    const harness = buildHarness();
    await startMakerChecker(harness);

    expect(await asAcme(() => harness.service.tasksFor(['*'], ACME))).toHaveLength(1);
  });
});

describe('SLA and escalation', () => {
  it('reports nothing breached before the due time', async () => {
    const harness = buildHarness();
    await startMakerChecker(harness);

    harness.clock.advanceMinutes(239);
    expect(await asAcme(() => harness.service.breachedTasks(ACME))).toHaveLength(0);
  });

  it('escalates a breached task once and records it', async () => {
    const harness = buildHarness();
    await startMakerChecker(harness);

    harness.clock.advanceMinutes(241);
    expect(await asAcme(() => harness.service.breachedTasks(ACME))).toHaveLength(1);

    const first = await asAcme(() => harness.service.runEscalations(ACME));
    expect(first).toEqual({ escalated: 1, failed: 0 });
    expect(harness.escalation.events[0]?.overdueMinutes).toBe(1);

    // A notification storm is a worse failure than a missed escalation.
    const second = await asAcme(() => harness.service.runEscalations(ACME));
    expect(second).toEqual({ escalated: 0, failed: 0 });
    expect(harness.escalation.events).toHaveLength(1);
  });

  it('records the breach even when the hook fails, and keeps going', async () => {
    const harness = buildHarness();
    // A hook that throws for the first task must not stop the batch.
    harness.escalation.onBreach = async () => {
      throw new Error('pager unavailable');
    };

    await startMakerChecker(harness);
    harness.clock.advanceMinutes(300);

    const result = await asAcme(() => harness.service.runEscalations(ACME));
    expect(result).toEqual({ escalated: 0, failed: 1 });
    // The breach itself is in the trail regardless of whether anyone was told.
    expect(harness.audit.byAction('workflow.sla.breached')).toHaveLength(1);
  });

  it('does nothing when escalation is disabled for the organization', async () => {
    const harness = buildHarness({ escalationEnabled: false });
    await startMakerChecker(harness);
    harness.clock.advanceMinutes(300);

    expect(await asAcme(() => harness.service.runEscalations(ACME))).toEqual({
      escalated: 0,
      failed: 0,
    });
  });

  it('uses the organization default SLA for a step that declares none', async () => {
    const harness = buildHarness({ defaultSlaMinutes: 30 });

    await asAcme(() =>
      harness.service.registerDefinition(
        {
          key: 'no.sla',
          name: 'No SLA',
          description: '',
          steps: [
            {
              order: 1,
              name: 'Approve',
              approverPermission: APPROVE,
              requiredApprovals: 1,
              slaMinutes: null,
              allowSubmitterApproval: false,
            },
          ],
        },
        ACME,
      ),
    );

    const { task } = await asAcme(() =>
      harness.service.start(
        { definitionKey: 'no.sla', subjectType: 'Note', subjectId: 'n1' },
        ACME,
        MAKER,
      ),
    );

    expect(task.dueAt.getTime() - harness.clock.now().getTime()).toBe(30 * 60_000);
  });
});

describe('workflow tenant isolation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('resolves a definition key within the calling organization only', async () => {
    await startMakerChecker(harness);

    // RIVAL has no such definition, even though ACME does.
    await expect(
      asRival(() =>
        harness.service.start(
          { definitionKey: 'payout.approval', subjectType: 'Payout', subjectId: 'x' },
          RIVAL,
          'user_rival',
        ),
      ),
    ).rejects.toThrow(/No workflow definition/);
  });

  it('reports another organization instance as not_found', async () => {
    const { instance } = await startMakerChecker(harness);

    try {
      await asRival(() => harness.service.findInstance(instance.id, RIVAL));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('cannot approve, reject or cancel across organizations', async () => {
    const { task, instance } = await startMakerChecker(harness);

    await expect(
      asRival(() => harness.service.approve(task.id, RIVAL, 'user_rival', ['*'])),
    ).rejects.toThrow();
    await expect(
      asRival(() => harness.service.reject(task.id, RIVAL, 'user_rival', ['*'])),
    ).rejects.toThrow();
    await expect(
      asRival(() => harness.service.cancel(instance.id, RIVAL, 'user_rival')),
    ).rejects.toThrow();
  });

  it('never shows another organization tasks, even to a wildcard holder', async () => {
    await startMakerChecker(harness);
    expect(await asRival(() => harness.service.tasksFor(['*'], RIVAL))).toHaveLength(0);
  });

  it('never reads another organization history', async () => {
    const { instance } = await startMakerChecker(harness);
    await expect(asRival(() => harness.service.history(instance.id, RIVAL))).rejects.toThrow();
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(harness.service.listDefinitions()).rejects.toThrow(
      /Organization context is required/,
    );
  });

  it('attributes every audit record to the acting organization', async () => {
    await startMakerChecker(harness);
    expect(harness.audit.records.every((record) => record.organizationId === ACME)).toBe(true);
  });
});

describe('definition validation', () => {
  it('requires contiguous step numbers', () => {
    // Otherwise the service advances to a step that has no task and the workflow
    // stalls with no error.
    const gapped = [
      {
        order: 1,
        name: 'One',
        approverPermission: APPROVE,
        requiredApprovals: 1,
        slaMinutes: null,
        allowSubmitterApproval: false,
      },
      {
        order: 3,
        name: 'Three',
        approverPermission: APPROVE,
        requiredApprovals: 1,
        slaMinutes: null,
        allowSubmitterApproval: false,
      },
    ];

    try {
      assertStepsWellFormed(gapped);
      expect.unreachable('a gapped step list must be refused');
    } catch (error) {
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details.some((detail) => detail.message.includes('numbered 1..n'))).toBe(true);
    }
  });

  it('builds a maker-checker definition that forbids self-approval', () => {
    const definition = makerCheckerDefinition({
      key: 'refund.approval',
      name: 'Refund approval',
      checkerPermission: APPROVE,
    });

    expect(definition.steps).toHaveLength(1);
    expect(definition.steps[0]?.allowSubmitterApproval).toBe(false);
    expect(definition.steps[0]?.requiredApprovals).toBe(1);
  });
});

describe('configuration validation', () => {
  it('installs with no configuration at all', () => {
    expect(workflowConfigSchema.parse({})).toEqual({
      defaultSlaMinutes: 240,
      escalationEnabled: true,
      escalationBatchSize: 50,
    });
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    expect(workflowConfigSchema.safeParse({ defaultSla: 10 }).success).toBe(false);
  });
});

describe('lifecycle', () => {
  it('refuses to start without a database', async () => {
    const { context } = createTestModuleContext(workflowModule, { prisma: null });
    const instance = createWorkflow(context, { escalation: new RecordingEscalationHook() });

    await expect(instance.initialize()).rejects.toThrow(/needs a database/);
  });

  it('names the escalation hook in its health detail', async () => {
    const harness = buildHarness();
    const { context } = createTestModuleContext(workflowModule, {
      prisma: { workflowTask: harness.tasks },
    });
    const instance = createWorkflow(context, { escalation: new RecordingEscalationHook() });

    expect((await instance.healthIndicator().check()).detail).toContain('recording');
  });
});

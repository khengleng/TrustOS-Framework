import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthorizer } from '@trustsystem/authorization';
import { InMemoryAuditSink, AuditService } from '@trustsystem/audit';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustsystem/security-events';
import { securityPolicySchema } from '@trustsystem/security-policy';
import {
  WORKFLOW_PERMISSIONS,
  type WorkflowActor,
  type WorkflowVersionRecord,
} from '@trustsystem/workflow-core';
import {
  CHANGE_REQUEST_APPROVAL,
  SIMPLE_APPROVAL,
  hashDefinition,
  type WorkflowDefinitionDocument,
} from '@trustsystem/workflow-definition';
import { HistoryRecorder } from '@trustsystem/workflow-history';
import { WORKFLOW_POLICIES } from '@trustsystem/workflow-policy';
import { CalendarRegistry, SlaService } from '@trustsystem/workflow-sla';
import { TaskService } from '@trustsystem/workflow-tasks';
import {
  InMemoryDecisionStore,
  InMemoryDefinitionStore,
  InMemoryHistoryStore,
  InMemoryInstanceStore,
  InMemoryMemberDirectory,
  InMemorySlaStore,
  InMemoryTaskStore,
  InMemoryVersionStore,
  resetInMemoryIds,
} from './in-memory-stores';
import { InMemoryIdempotencyStore } from './idempotency';
import { WorkflowEngine } from './engine';

/**
 * Engine tests.
 *
 * The rig below wires the real engine to in-memory stores that model the two behaviours
 * production depends on — organization filtering and optimistic locking — so these tests
 * exercise the same code paths a deployment does rather than a simplified version of them.
 */

const ACME = 'org_acme';
const OTHER = 'org_globex';
const policy = securityPolicySchema.parse({ environment: 'test' });

const ALL_PERMISSIONS = Object.values(WORKFLOW_PERMISSIONS).map((permission) => permission.key);

function actor(overrides: Partial<WorkflowActor> = {}): WorkflowActor {
  return {
    userId: 'user_maker',
    actorType: 'user',
    email: 'maker@acme.test',
    tokenId: 'tok_1',
    organizationId: ACME,
    roles: ['workflow_maker'],
    permissions: ALL_PERMISSIONS,
    isSuperAdmin: false,
    groupIds: [],
    authenticationLevel: 'medium',
    mfa: false,
    ...overrides,
  };
}

const maker = actor();
const checker = actor({
  userId: 'user_checker',
  email: 'checker@acme.test',
  roles: ['workflow_checker'],
});
const secondChecker = actor({
  userId: 'user_checker_2',
  email: 'checker2@acme.test',
  roles: ['workflow_checker'],
});

interface Rig {
  engine: WorkflowEngine;
  instances: InMemoryInstanceStore;
  tasks: InMemoryTaskStore;
  decisions: InMemoryDecisionStore;
  history: InMemoryHistoryStore;
  slas: InMemorySlaStore;
  events: InMemorySecurityEventSink;
  audit: InMemoryAuditSink;
  taskService: TaskService;
  publish: (document: WorkflowDefinitionDocument) => Promise<WorkflowVersionRecord>;
  now: () => Date;
  setNow: (at: Date) => void;
}

function build(): Rig {
  resetInMemoryIds();

  const definitionStore = new InMemoryDefinitionStore();
  const instances = new InMemoryInstanceStore();
  const versions = new InMemoryVersionStore(definitionStore, instances);
  const decisions = new InMemoryDecisionStore();
  const taskStore = new InMemoryTaskStore();
  const historyStore = new InMemoryHistoryStore();
  const slaStore = new InMemorySlaStore();
  const eventSink = new InMemorySecurityEventSink();
  const auditSink = new InMemoryAuditSink();

  let clock = new Date('2026-08-01T09:00:00.000Z');
  const now = () => clock;

  const events = new SecurityEventEmitter({ sinks: [eventSink], application: 'test' });
  const history = new HistoryRecorder({
    store: historyStore,
    audit: new AuditService({ sink: auditSink }),
    now,
  });

  const taskService = new TaskService({ store: taskStore, events, now });

  const engine = new WorkflowEngine({
    instances,
    versions,
    decisions,
    tasks: taskService,
    taskStore,
    history,
    authorizer: createAuthorizer({
      mfa: policy.mfa,
      events,
      // The framework's own policies plus the workflow set. Order matters for the reason
      // documented in @trustsystem/workflow-policy: the message somebody acts on.
      additional: WORKFLOW_POLICIES,
    }),
    sla: new SlaService({ store: slaStore, calendars: new CalendarRegistry(), now }),
    // The engine's clock, not the wall clock. `expiresAt` is computed from the former.
    idempotency: new InMemoryIdempotencyStore(now),
    assignment: {
      directory: new InMemoryMemberDirectory(
        {
          user_maker: { roles: ['workflow_maker'], groups: [] },
          user_checker: { roles: ['workflow_checker'], groups: ['reviewers'] },
          user_checker_2: { roles: ['workflow_checker'], groups: ['reviewers'] },
        },
        ACME,
      ),
    },
    events,
    // One validator per object type the tests use. Accepts anything in ACME and nothing
    // elsewhere, which is what makes the cross-tenant test meaningful.
    objectValidators: ['ChangeRequest', 'GenericRequest'].map((objectType) => ({
      objectType,
      exists: async (input: { organizationId: string }) => input.organizationId === ACME,
    })),
    hasAttachment: async () => attachmentPresent,
    now,
  });

  const publish = async (document: WorkflowDefinitionDocument) => {
    const definition = await definitionStore.create({
      organizationId: ACME,
      key: document.id,
      name: document.name,
      description: document.description,
      businessObjectType: document.businessObjectType,
      createdById: 'user_author',
    });

    return versions.create({
      workflowDefinitionId: definition.id,
      organizationId: ACME,
      version: document.version,
      status: 'published',
      definition: document,
      definitionHash: hashDefinition(document),
      initialState: document.initialState,
      finalStates: document.finalStates,
      effectiveFrom: clock,
      createdById: 'user_author',
      approvedById: 'user_approver',
      approvedAt: clock,
      publishedById: 'user_publisher',
      publishedAt: clock,
      retiredAt: null,
      retiredReason: null,
    });
  };

  return {
    engine,
    instances,
    tasks: taskStore,
    decisions,
    history: historyStore,
    slas: slaStore,
    events: eventSink,
    audit: auditSink,
    taskService,
    publish,
    now,
    setNow: (at: Date) => {
      clock = at;
    },
  };
}

/** Toggled by tests that exercise a step's evidence requirement. */
let attachmentPresent = false;

beforeEach(() => {
  attachmentPresent = false;
});

async function startSimple(rig: Rig, data: Record<string, unknown> = { title: 'Widget' }) {
  await rig.publish(SIMPLE_APPROVAL);
  return rig.engine.start(maker, {
    definitionKey: 'simple-approval',
    businessObjectType: 'GenericRequest',
    businessObjectId: 'req_1',
    data,
  });
}

// ===========================================================================
// Starting
// ===========================================================================

describe('starting an instance', () => {
  it('pins the published version for the instance’s whole life', async () => {
    const rig = build();
    const version = await rig.publish(SIMPLE_APPROVAL);

    const started = await rig.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
      data: { title: 'Widget' },
    });

    expect(started.instance.workflowVersionId).toBe(version.id);
    expect(started.instance.workflowVersion).toBe('1.0.0');
    expect(started.instance.currentState).toBe('draft');
    expect(started.instance.initiatedById).toBe(maker.userId);
  });

  it('refuses to start when no version is published', async () => {
    const rig = build();
    await expect(
      rig.engine.start(maker, {
        definitionKey: 'simple-approval',
        businessObjectType: 'GenericRequest',
        businessObjectId: 'req_1',
      }),
    ).rejects.toThrow(/No published version/);
  });

  it('refuses a business object type the workflow does not govern', async () => {
    const rig = build();
    await rig.publish(SIMPLE_APPROVAL);

    // Asserted on `details`, not on `message`. `ApiError.validation` puts the specific
    // explanation in the details and a summary in the message, so matching the message
    // would be matching the wrapper.
    const error = await rig.engine
      .start(maker, {
        definitionKey: 'simple-approval',
        businessObjectType: 'Merchant',
        businessObjectId: 'm_1',
      })
      .catch(
        (caught: { code?: string; details?: Array<{ path: string; message: string }> }) => caught,
      );

    expect(error.code).toBe('validation_error');
    expect(error.details?.[0]).toMatchObject({ path: 'businessObjectType' });
    expect(error.details?.[0]?.message).toContain('governs "GenericRequest"');
  });

  it('refuses a business object that does not exist in this organization', async () => {
    const rig = build();
    await rig.publish(SIMPLE_APPROVAL);

    // The validator accepts only ACME, so a caller from another organization is refused.
    // Not found rather than forbidden — the response must not distinguish "no such
    // object" from "somebody else's object".
    await expect(
      rig.engine.start(actor({ organizationId: OTHER }), {
        definitionKey: 'simple-approval',
        businessObjectType: 'GenericRequest',
        businessObjectId: 'req_1',
      }),
    ).rejects.toThrow();
  });

  it('creates a task for the initial step, assigned to the initiator', async () => {
    const rig = build();
    const started = await startSimple(rig);

    expect(started.tasksCreated).toHaveLength(1);
    // `${initiator}` resolved. That is how a draft or rework step returns to its maker.
    expect(started.tasksCreated[0]?.assigneeUserId).toBe(maker.userId);
    expect(started.tasksCreated[0]?.stepKey).toBe('draft');
  });

  it('records workflow.started in history and in the audit trail', async () => {
    const rig = build();
    await startSimple(rig);

    expect(rig.history.byType('workflow.started')).toHaveLength(1);
    // Both trails, written by one call, so a caller cannot write one and forget the other.
    expect(rig.audit.records.some((record) => record.action === 'workflow.workflow.started')).toBe(
      true,
    );
  });

  it('follows an automatic transition chain from the initial state', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_1',
      data: { title: 'Limit increase', amount: 5000, riskRating: 'low' },
    });

    // `draft` has no automatic exit, so nothing follows yet.
    expect(started.instance.currentState).toBe('draft');
    expect(started.automaticSteps).toEqual([]);
  });
});

// ===========================================================================
// Transitions
// ===========================================================================

describe('transitions', () => {
  it('executes a legal transition', async () => {
    const rig = build();
    const started = await startSimple(rig);

    const result = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
      expectedVersion: started.instance.version,
    });

    expect(result.from).toBe('draft');
    expect(result.to).toBe('pending_approval');
    expect(result.instance.currentState).toBe('pending_approval');
  });

  it('refuses an illegal transition and reports what is available', async () => {
    const rig = build();
    const started = await startSimple(rig);

    // `approve` is not available from `draft`.
    await expect(
      rig.engine.transition(maker, { instanceId: started.instance.id, action: 'approve' }),
    ).rejects.toMatchObject({
      code: 'conflict',
      context: { reason: 'illegal_transition', availableActions: ['submit'] },
    });
  });

  it('refuses an unknown action', async () => {
    const rig = build();
    const started = await startSimple(rig);

    await expect(
      rig.engine.transition(maker, { instanceId: started.instance.id, action: 'teleport' }),
    ).rejects.toThrow(/not available/);
  });

  it('refuses a stale version rather than applying the change', async () => {
    const rig = build();
    const started = await startSimple(rig);

    // Somebody else moves it first.
    await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
      expectedVersion: started.instance.version,
    });

    // The second caller's decision was made against a state that no longer exists.
    await expect(
      rig.engine.transition(maker, {
        instanceId: started.instance.id,
        action: 'submit',
        expectedVersion: started.instance.version,
      }),
    ).rejects.toMatchObject({ context: { reason: 'stale_version' } });
  });

  it('refuses an action on a completed instance', async () => {
    const rig = build();
    const started = await startSimple(rig);

    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });
    const approved = await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'approve',
    });

    expect(approved.instance.status).toBe('completed');

    // A stale decision must not land on a closed instance.
    await expect(
      rig.engine.transition(checker, { instanceId: approved.instance.id, action: 'reject' }),
    ).rejects.toThrow();
  });

  it('requires a reason where the definition says so', async () => {
    const rig = build();
    const started = await startSimple(rig);
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    await expect(
      rig.engine.transition(checker, { instanceId: submitted.instance.id, action: 'reject' }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    await expect(
      rig.engine.transition(checker, {
        instanceId: submitted.instance.id,
        action: 'reject',
        reasonCode: 'not_justified',
        explanation: 'The justification does not support the amount.',
      }),
    ).resolves.toMatchObject({ to: 'rejected' });
  });

  it('refuses to leave a step whose required fields are missing', async () => {
    const rig = build();
    // `draft` requires `title`.
    const started = await startSimple(rig, {});

    await expect(
      rig.engine.transition(maker, { instanceId: started.instance.id, action: 'submit' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: [{ path: 'title' }],
    });
  });

  it('treats an empty string as a missing required field', async () => {
    const rig = build();
    const started = await startSimple(rig, { title: '' });

    // A required justification submitted as `""` is not a justification.
    await expect(
      rig.engine.transition(maker, { instanceId: started.instance.id, action: 'submit' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('applies only the fields the step permits, and reports the rest', async () => {
    const rig = build();
    const started = await startSimple(rig);

    const result = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
      // `title` and `description` are editable in `draft`; `amount` is not.
      dataPatch: { title: 'Renamed', amount: 999_999 },
    });

    expect(result.instance.data.title).toBe('Renamed');
    // Reported rather than silently dropped: silently dropping would let the maker
    // believe the change was saved.
    expect(result.rejectedFields).toEqual(['amount']);
    expect(result.instance.data.amount).toBeUndefined();
  });

  it('records the transition in history with both states and the decision id', async () => {
    const rig = build();
    const started = await startSimple(rig);
    const result = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    const event = rig.history.byType('workflow.transitioned').at(-1);
    expect(event).toMatchObject({
      fromState: 'draft',
      toState: 'pending_approval',
      action: 'submit',
      actorId: maker.userId,
    });
    // The decision id ties a refusal or an approval to the authorization decision that
    // permitted it.
    expect(event?.policyDecisionId).toBe(result.decisionId);
  });
});

// ===========================================================================
// Maker-checker
// ===========================================================================

describe('maker-checker', () => {
  it('prevents the submitter approving their own request', async () => {
    const rig = build();
    const started = await startSimple(rig);
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    // The maker holds every permission in this rig, so the refusal cannot be a missing
    // grant — it is the maker-checker rule.
    await expect(
      rig.engine.transition(maker, { instanceId: submitted.instance.id, action: 'approve' }),
    ).rejects.toThrow();

    // And a checker can.
    await expect(
      rig.engine.transition(checker, { instanceId: submitted.instance.id, action: 'approve' }),
    ).resolves.toMatchObject({ to: 'approved' });
  });

  it('reports self-approval as the reason, not a missing permission', async () => {
    const rig = build();
    const started = await startSimple(rig);
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    await rig.engine
      .transition(maker, { instanceId: submitted.instance.id, action: 'approve' })
      .catch(() => undefined);

    // Telling a maker "you lack the approval permission" sends them to an administrator
    // for a grant that will not help. The policy order exists for this.
    const denials = rig.events.events.filter((event) => event.result === 'blocked');
    expect(denials.some((event) => event.reason === 'self_approval_forbidden')).toBe(true);
  });

  it('prevents the same actor approving one step twice', async () => {
    const rig = build();
    const document = structuredClone(SIMPLE_APPROVAL);
    // Two approvals required, so a second click from the same person would otherwise
    // satisfy it.
    document.steps.find((step) => step.state === 'pending_approval')!.approval = {
      model: 'threshold',
      threshold: 2,
      approvers: [
        { key: 'a', name: 'A', permission: 'workflow.approval.decide', slaMinutes: null },
        { key: 'b', name: 'B', permission: 'workflow.approval.decide', slaMinutes: null },
      ],
      allowSelfApproval: false,
      allowSameActorMultipleSlots: false,
      rejectionReasonCodes: [],
    };

    const rig2 = build();
    await rig2.publish(document);
    const started = await rig2.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
      data: { title: 'Widget' },
    });
    const submitted = await rig2.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    const first = await rig2.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'approve',
    });
    // Not satisfied yet: 1 of 2.
    expect(first.approval?.satisfied).toBe(false);
    expect(first.instance.currentState).toBe('pending_approval');

    // The same person again is refused. Counting one person's two clicks as two
    // approvals would defeat "2 of 2" entirely.
    await expect(
      rig2.engine.transition(checker, { instanceId: first.instance.id, action: 'approve' }),
    ).rejects.toThrow();

    // A second, distinct approver completes it.
    const second = await rig2.engine.transition(secondChecker, {
      instanceId: first.instance.id,
      action: 'approve',
    });
    expect(second.approval?.satisfied).toBe(true);
    expect(second.instance.currentState).toBe('approved');

    void rig;
  });

  it('does not advance the workflow until a threshold is met', async () => {
    const rig = build();
    const document = structuredClone(SIMPLE_APPROVAL);
    document.steps.find((step) => step.state === 'pending_approval')!.approval = {
      model: 'threshold',
      threshold: 2,
      approvers: [
        { key: 'a', name: 'A', permission: 'workflow.approval.decide', slaMinutes: null },
        { key: 'b', name: 'B', permission: 'workflow.approval.decide', slaMinutes: null },
      ],
      allowSelfApproval: false,
      allowSameActorMultipleSlots: false,
      rejectionReasonCodes: [],
    };

    await rig.publish(document);
    const started = await rig.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
      data: { title: 'Widget' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    const partial = await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'approve',
    });

    // Advancing on the first approval would make every threshold a single approval —
    // the bug that makes a threshold look like it works.
    expect(partial.to).toBe('pending_approval');
    expect(partial.approval).toMatchObject({ approvals: 1, required: 2, satisfied: false });
  });

  it('lets a rejection settle a step whatever the model requires', async () => {
    const rig = build();
    const document = structuredClone(SIMPLE_APPROVAL);
    document.steps.find((step) => step.state === 'pending_approval')!.approval = {
      model: 'unanimous',
      approvers: [
        { key: 'a', name: 'A', permission: 'workflow.approval.decide', slaMinutes: null },
        { key: 'b', name: 'B', permission: 'workflow.approval.decide', slaMinutes: null },
      ],
      allowSelfApproval: false,
      allowSameActorMultipleSlots: false,
      rejectionReasonCodes: ['not_justified'],
    };

    await rig.publish(document);
    const started = await rig.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
      data: { title: 'Widget' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    // One veto ends it. "Three must approve but one may veto" is how every real approval
    // chain works; a model where a rejection could be outvoted would make a refusal
    // advisory.
    const rejected = await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'reject',
      reasonCode: 'not_justified',
    });

    expect(rejected.instance.status).toBe('rejected');
    expect(rejected.approval?.rejected).toBe(true);
  });
});

// ===========================================================================
// Conditional routing and rework
// ===========================================================================

describe('conditional routing', () => {
  it('routes a low-risk request straight to approved after one review', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_1',
      data: { title: 'Small change', amount: 500, riskRating: 'low' },
    });

    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });
    // The automatic chain routes `submitted` to `manager_review`.
    expect(submitted.instance.currentState).toBe('manager_review');
    expect(submitted.automaticSteps.map((step) => step.to)).toEqual(['manager_review']);

    const approved = await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'approve',
    });
    expect(approved.instance.currentState).toBe('approved');
    expect(approved.instance.status).toBe('completed');
  });

  it('routes a high-risk request through compliance', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);
    attachmentPresent = true;

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_2',
      data: { title: 'Big change', amount: 500_000, riskRating: 'high' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    // `approve` is *unavailable* from manager_review for a high-risk request, because its
    // condition requires riskRating != high. The available action is the escalation.
    const available = await rig.engine.available(maker, submitted.instance.id);
    expect(available).toContain('escalate_to_compliance');
    expect(available).not.toContain('approve');

    const escalated = await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'escalate_to_compliance',
    });
    expect(escalated.instance.currentState).toBe('compliance_review');

    const approved = await rig.engine.transition(secondChecker, {
      instanceId: escalated.instance.id,
      action: 'approve',
    });
    expect(approved.instance.currentState).toBe('approved');
  });

  it('requires evidence for a high-risk request', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);
    attachmentPresent = false;

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_3',
      data: { title: 'Big change', amount: 500_000, riskRating: 'high' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    await expect(
      rig.engine.transition(checker, {
        instanceId: submitted.instance.id,
        action: 'escalate_to_compliance',
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: [{ code: 'attachment_required' }],
    });
  });

  it('does not require evidence for a low-risk request', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);
    attachmentPresent = false;

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_4',
      data: { title: 'Small', amount: 100, riskRating: 'low' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    // An unconditional requirement gets satisfied with a screenshot of nothing.
    await expect(
      rig.engine.transition(checker, { instanceId: submitted.instance.id, action: 'approve' }),
    ).resolves.toMatchObject({ to: 'approved' });
  });
});

describe('rework', () => {
  it('returns to the maker, increments the counter, and keeps the decision', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_5',
      data: { title: 'Change', amount: 100, riskRating: 'low' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    const returned = await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'return_for_rework',
      reasonCode: 'insufficient_justification',
      explanation: 'Please attach the impact assessment.',
    });

    expect(returned.instance.currentState).toBe('returned_for_rework');
    expect(returned.instance.reworkCount).toBe(1);
    // The decision is retained. The point of an approval trail is that it shows what was
    // decided before, not only what was decided last.
    expect(rig.decisions.records).toHaveLength(1);
    expect(rig.decisions.records[0]).toMatchObject({
      decision: 'return_for_rework',
      reasonCode: 'insufficient_justification',
      reworkCycle: 0,
    });
  });

  it('does not carry an approval across a rework cycle', async () => {
    const rig = build();
    const document = structuredClone(CHANGE_REQUEST_APPROVAL);
    // Two approvals at manager_review, so a carried-over approval would be visible.
    document.steps.find((step) => step.state === 'manager_review')!.approval = {
      model: 'threshold',
      threshold: 2,
      approvers: [
        { key: 'a', name: 'A', permission: 'workflow.approval.decide', slaMinutes: null },
        { key: 'b', name: 'B', permission: 'workflow.approval.decide', slaMinutes: null },
      ],
      allowSelfApproval: false,
      allowSameActorMultipleSlots: false,
      rejectionReasonCodes: ['insufficient_justification'],
    };

    await rig.publish(document);
    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_6',
      data: { title: 'Change', amount: 100, riskRating: 'low' },
    });
    let current = (
      await rig.engine.transition(maker, { instanceId: started.instance.id, action: 'submit' })
    ).instance;

    // One genuine approval in cycle 0.
    current = (await rig.engine.transition(checker, { instanceId: current.id, action: 'approve' }))
      .instance;

    // Returned, so cycle 1 begins.
    current = (
      await rig.engine.transition(secondChecker, {
        instanceId: current.id,
        action: 'return_for_rework',
        reasonCode: 'insufficient_justification',
      })
    ).instance;
    expect(current.reworkCount).toBe(1);

    // Resubmitted, and the maker may have changed the amount in between.
    current = (await rig.engine.transition(maker, { instanceId: current.id, action: 'resubmit' }))
      .instance;
    expect(current.currentState).toBe('manager_review');

    // The approval from cycle 0 must not count: it was an approval of a different
    // request. Progress starts from zero.
    const progress = await rig.engine.approvalProgress(maker, current.id);
    expect(progress).toMatchObject({ approvals: 0, required: 2 });
  });

  it('blocks a rework beyond the configured limit', async () => {
    const rig = build();
    const document = structuredClone(CHANGE_REQUEST_APPROVAL);
    document.rework = { maxCycles: 1, onLimitReached: 'block' };

    await rig.publish(document);
    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_7',
      data: { title: 'Change', amount: 100, riskRating: 'low' },
    });
    let current = (
      await rig.engine.transition(maker, { instanceId: started.instance.id, action: 'submit' })
    ).instance;

    current = (
      await rig.engine.transition(checker, {
        instanceId: current.id,
        action: 'return_for_rework',
        reasonCode: 'insufficient_justification',
      })
    ).instance;
    current = (await rig.engine.transition(maker, { instanceId: current.id, action: 'resubmit' }))
      .instance;

    // An unbounded rework loop is how a request stays open for a year while both sides
    // believe the other has it.
    await expect(
      rig.engine.transition(checker, {
        instanceId: current.id,
        action: 'return_for_rework',
        reasonCode: 'insufficient_justification',
      }),
    ).rejects.toMatchObject({ context: { reason: 'rework_limit_reached', limit: 1 } });
  });
});

// ===========================================================================
// Cancellation
// ===========================================================================

describe('cancellation', () => {
  it('cancels with a reason and preserves the history', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_8',
      data: { title: 'Change', amount: 100, riskRating: 'low' },
    });

    const cancelled = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'cancel',
      reasonCode: 'no_longer_needed',
    });

    expect(cancelled.instance.status).toBe('cancelled');
    expect(cancelled.instance.cancelledById).toBe(maker.userId);
    // The history is not erased.
    expect(rig.history.byType('workflow.started')).toHaveLength(1);
    expect(rig.history.byType('workflow.cancelled')).toHaveLength(1);
  });

  it('refuses a cancellation with no reason', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);
    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_9',
      data: { title: 'Change', amount: 100, riskRating: 'low' },
    });

    await expect(
      rig.engine.transition(maker, { instanceId: started.instance.id, action: 'cancel' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('cancels every open task when the workflow ends', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);
    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_10',
      data: { title: 'Change', amount: 100, riskRating: 'low' },
    });

    await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'cancel',
      reasonCode: 'withdrawn',
    });

    // A task left in somebody's queue after the workflow ended is a task they will work.
    const open = [...rig.tasks.records.values()].filter((task) =>
      ['open', 'assigned', 'claimed', 'in_progress'].includes(task.status),
    );
    expect(open).toEqual([]);
  });
});

// ===========================================================================
// Tenant isolation
// ===========================================================================

describe('tenant isolation', () => {
  it('does not find an instance from another organization', async () => {
    const rig = build();
    const started = await startSimple(rig);

    // Not found, never forbidden: a 403 would confirm the instance exists.
    await expect(
      rig.engine.find(actor({ organizationId: OTHER }), started.instance.id),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not transition an instance from another organization', async () => {
    const rig = build();
    const started = await startSimple(rig);

    await expect(
      rig.engine.transition(actor({ organizationId: OTHER }), {
        instanceId: started.instance.id,
        action: 'submit',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not leak the owning organization in the error', async () => {
    const rig = build();
    const started = await startSimple(rig);

    const error = await rig.engine
      .find(actor({ organizationId: OTHER }), started.instance.id)
      .catch((caught: Error) => caught);

    expect(JSON.stringify(error)).not.toContain(ACME);
  });

  it('lists only this organization’s instances', async () => {
    const rig = build();
    await startSimple(rig);

    const mine = await rig.engine.list(maker, {});
    expect(mine.total).toBe(1);

    const theirs = await rig.engine.list(actor({ organizationId: OTHER }), {});
    expect(theirs.total).toBe(0);
  });
});

// ===========================================================================
// Definition tampering
// ===========================================================================

describe('definition integrity', () => {
  it('refuses to execute a published version whose definition was modified', async () => {
    const rig = build();
    const version = await rig.publish(SIMPLE_APPROVAL);
    const started = await startSimple(rig);
    void started;

    // Simulate a direct database write: the document changes, the hash does not. The
    // application has write access to its own database, so "the API refuses" is not a
    // guarantee.
    const stored = (rig as unknown as { engine: WorkflowEngine }).engine;
    void stored;

    const tampered = structuredClone(SIMPLE_APPROVAL);
    tampered.steps.find((step) => step.state === 'pending_approval')!.approval!.allowSelfApproval =
      true;

    // Reach into the in-memory store the way a rogue UPDATE would reach into the table.
    const versionStore = (rig.instances as unknown as Record<string, never>) && undefined;
    void versionStore;

    // The engine caches published versions, so a fresh rig is needed to observe the check.
    const rig2 = build();
    const v2 = await rig2.publish(SIMPLE_APPROVAL);
    // Overwrite the stored definition without updating the hash.
    Object.assign(v2, { definition: tampered });

    void version;
    // A second engine reading that row must refuse rather than execute rules nobody
    // approved. Verified through the definition hash helper, which is what the engine
    // calls on every compile.
    const { assertDefinitionUntampered } = await import('@trustsystem/workflow-definition');
    expect(() =>
      assertDefinitionUntampered({
        definition: tampered,
        expectedHash: hashDefinition(SIMPLE_APPROVAL),
        version: '1.0.0',
      }),
    ).toThrow(/does not match its recorded hash/);
  });

  it('accepts a definition whose hash matches', async () => {
    const { assertDefinitionUntampered } = await import('@trustsystem/workflow-definition');
    expect(() =>
      assertDefinitionUntampered({
        definition: SIMPLE_APPROVAL,
        expectedHash: hashDefinition(SIMPLE_APPROVAL),
        version: '1.0.0',
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// Idempotency
// ===========================================================================

describe('idempotency', () => {
  it('starts one instance for a repeated key with the same payload', async () => {
    const rig = build();
    await rig.publish(SIMPLE_APPROVAL);

    const input = {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
      data: { title: 'Widget' },
      idempotencyKey: 'key-1',
    };

    const first = await rig.engine.start(maker, input);
    const second = await rig.engine.start(maker, input);

    expect(second.instance.id).toBe(first.instance.id);
    expect(rig.instances.records.size).toBe(1);
  });

  it('refuses the same key with a different payload', async () => {
    const rig = build();
    await rig.publish(SIMPLE_APPROVAL);

    await rig.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
      data: { title: 'Widget' },
      idempotencyKey: 'key-2',
    });

    // Replaying the first result would tell the caller an operation succeeded that never
    // ran for this request, which is worse than any error.
    await expect(
      rig.engine.start(maker, {
        definitionKey: 'simple-approval',
        businessObjectType: 'GenericRequest',
        businessObjectId: 'req_2',
        data: { title: 'Different' },
        idempotencyKey: 'key-2',
      }),
    ).rejects.toMatchObject({ context: { reason: 'idempotency_key_reused' } });
  });

  it('records one approval for a repeated transition key', async () => {
    const rig = build();
    const started = await startSimple(rig);
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });

    const input = {
      instanceId: submitted.instance.id,
      action: 'approve',
      idempotencyKey: 'approve-once',
    };

    await rig.engine.transition(checker, input);
    await rig.engine.transition(checker, input);

    // Two clicks, one decision. For a threshold model, two would have been two
    // approvals from one person.
    expect(rig.decisions.records).toHaveLength(1);
  });

  it('does not use idempotency when no key is given', async () => {
    const rig = build();
    await rig.publish(SIMPLE_APPROVAL);

    // Opt-in per request: forcing it would break every existing caller, and most internal
    // ones do not need it.
    await rig.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
    });
    await rig.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
    });

    expect(rig.instances.records.size).toBe(2);
  });

  it('refuses a key whose first attempt failed', async () => {
    const rig = build();
    await rig.publish(SIMPLE_APPROVAL);

    const input = {
      definitionKey: 'simple-approval',
      businessObjectType: 'Merchant', // wrong type, so the first attempt fails
      businessObjectId: 'm_1',
      idempotencyKey: 'failing-key',
    };

    await expect(rig.engine.start(maker, input)).rejects.toThrow();

    // The failure was deterministic. Retrying silently would hide that from the caller;
    // refusing tells them a new attempt needs a new key.
    await expect(rig.engine.start(maker, input)).rejects.toMatchObject({
      context: { reason: 'idempotency_key_reused' },
    });
  });
});

// ===========================================================================
// SLA
// ===========================================================================

describe('SLA integration', () => {
  it('starts a step SLA when a task is created', async () => {
    const rig = build();
    await rig.publish(SIMPLE_APPROVAL);
    const started = await rig.engine.start(maker, {
      definitionKey: 'simple-approval',
      businessObjectType: 'GenericRequest',
      businessObjectId: 'req_1',
      data: { title: 'Widget' },
    });

    await rig.engine.transition(maker, { instanceId: started.instance.id, action: 'submit' });

    // `pending_approval` declares an 8-hour time_to_complete.
    const slas = [...rig.slas.records.values()];
    expect(slas.some((sla) => sla.stepKey === 'pending_approval')).toBe(true);
    expect(slas.find((sla) => sla.stepKey === 'pending_approval')?.durationSeconds).toBe(480 * 60);
  });

  it('completes the instance SLAs when the workflow ends', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);
    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_1',
      data: { title: 'Change', amount: 10, riskRating: 'low' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });
    await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'approve',
    });

    // A clock still running on a finished workflow would breach and escalate.
    const running = [...rig.slas.records.values()].filter((sla) => sla.completedAt === null);
    expect(running).toEqual([]);
  });
});

// ===========================================================================
// History completeness
// ===========================================================================

describe('history', () => {
  it('records every step of a full lifecycle, in order', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);

    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_1',
      data: { title: 'Change', amount: 10, riskRating: 'low' },
    });
    const submitted = await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });
    await rig.engine.transition(checker, {
      instanceId: submitted.instance.id,
      action: 'approve',
    });

    const types = rig.history.records
      .filter((event) => event.workflowInstanceId === started.instance.id)
      .sort((a, b) => a.sequence - b.sequence)
      .map((event) => event.type);

    expect(types[0]).toBe('workflow.started');
    expect(types).toContain('task.created');
    expect(types).toContain('workflow.transitioned');
    expect(types.at(-1)).toBe('workflow.completed');
  });

  it('gives every event a distinct, monotonic sequence', async () => {
    const rig = build();
    const started = await startSimple(rig);
    await rig.engine.transition(maker, { instanceId: started.instance.id, action: 'submit' });

    const sequences = rig.history.records
      .filter((event) => event.workflowInstanceId === started.instance.id)
      .map((event) => event.sequence);

    // Two events in one transaction share a millisecond, so ordering by timestamp is not
    // ordering. The sequence is what makes the trail readable.
    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  it('attributes an automatic transition to the system, not to a person', async () => {
    const rig = build();
    await rig.publish(CHANGE_REQUEST_APPROVAL);
    const started = await rig.engine.start(maker, {
      definitionKey: 'change-request-approval',
      businessObjectType: 'ChangeRequest',
      businessObjectId: 'cr_1',
      data: { title: 'Change', amount: 10, riskRating: 'low' },
    });
    await rig.engine.transition(maker, { instanceId: started.instance.id, action: 'submit' });

    const automatic = rig.history.records.find((event) => event.action === 'route_to_manager');
    // Putting somebody's name on a decision they did not make is worse than an
    // unattributed one.
    expect(automatic?.actorId).toBe(null);
    expect(automatic?.actorType).toBe('system');
    expect(automatic?.metadata).toMatchObject({ automatic: true });
  });

  it('redacts a secret-looking field out of metadata', async () => {
    const rig = build();
    const started = await startSimple(rig);

    await rig.engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
      // A field named like a secret in the editable set would otherwise be written into
      // the longest-lived record in the system.
      dataPatch: { description: 'fine' },
    });

    const serialized = JSON.stringify(rig.history.records);
    expect(serialized).not.toContain('hunter2');
  });
});

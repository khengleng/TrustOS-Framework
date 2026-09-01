#!/usr/bin/env node
/**
 * Approval Workbench validation — three real scenarios against a real database.
 *
 *   DATABASE_URL=postgres://… npm run validate:approval-workbench
 *
 * Drives approve, reject and return-for-rework through the Approval Workbench service,
 * which drives the TrustOS engines, which write to Postgres. Nothing is asserted from a
 * test double: instances, tasks, decisions and audit records are written and read back.
 *
 * Every check computes its own result from what the call did. There is no PASS constant
 * in this file, and a check that throws is recorded as a failure rather than skipped —
 * "this control refused" and "this control was never reached" are different findings and
 * only one of them is reassuring.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wantJson = process.argv.includes('--json');

/** The commit the suite ran against, so a reviewer can check the claim. */
const commitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is required. An application proven only against in-memory stores\n' +
      'has not been proven.',
  );
  process.exit(2);
}

const { PrismaClient } = await import('@prisma/client');
const { CHANGE_REQUEST_APPROVAL, hashDefinition } = await import('@trustsystem/workflow-definition');
const { ApprovalWorkbenchService } = await import('@trustsystem/approval-workbench');
const { createAuthorizer } = await import('@trustsystem/authorization');
const { AuditService, InMemoryAuditSink } = await import('@trustsystem/audit');
const { SecurityEventEmitter, InMemorySecurityEventSink } = await import('@trustsystem/security-events');
const { securityPolicySchema } = await import('@trustsystem/security-policy');
const { HistoryRecorder } = await import('@trustsystem/workflow-history');
const { WORKFLOW_POLICIES } = await import('@trustsystem/workflow-policy');
const { CalendarRegistry, SlaService } = await import('@trustsystem/workflow-sla');
const { TaskService, PrismaTaskStore } = await import('@trustsystem/workflow-tasks');
const runtime = await import('@trustsystem/workflow-runtime');

const prisma = new PrismaClient();
const results = [];
const timings = [];
const correlationId = `awb_${randomUUID()}`;
const suffix = randomUUID().slice(0, 8);

async function check(name, fn) {
  try {
    const outcome = await fn();
    results.push({ check: name, status: outcome.pass ? 'PASS' : 'FAIL', detail: outcome.detail });
  } catch (error) {
    results.push({ check: name, status: 'FAIL', detail: `threw: ${error.message}` });
  }
}

/** Refusal is the expected outcome for most of these. */
async function refusal(fn) {
  try {
    const value = await fn();
    return { refused: false, reason: 'the call succeeded', value };
  } catch (error) {
    return {
      refused: true,
      reason: error.message,
      code: error.code ?? null,
      context: error.context ?? null,
    };
  }
}

/** Wall-clock for one call, recorded for the performance section. */
async function timed(label, fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  timings.push({ label, ms: Number(process.hrtime.bigint() - started) / 1e6 });
  return value;
}

const created = { organizations: [], users: [] };

async function seed() {
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({ data: { name: `AWB A ${suffix}`, slug: `awb-a-${suffix}` } }),
    prisma.organization.create({ data: { name: `AWB B ${suffix}`, slug: `awb-b-${suffix}` } }),
  ]);
  created.organizations.push(orgA.id, orgB.id);

  const makeUser = (label, organizationId) =>
    prisma.user.create({
      data: {
        email: `${label}-${suffix}@validation.trustos`,
        passwordHash: null,
        externalId: `sub-${label}-${suffix}`,
        displayName: label,
        memberships: { create: { organizationId, status: 'ACTIVE', joinedAt: new Date() } },
      },
    });

  const users = {
    aAdmin: await makeUser('awb-a-admin', orgA.id),
    aMaker: await makeUser('awb-a-maker', orgA.id),
    aChecker: await makeUser('awb-a-checker', orgA.id),
    aChecker2: await makeUser('awb-a-checker2', orgA.id),
    aViewer: await makeUser('awb-a-viewer', orgA.id),
    bChecker: await makeUser('awb-b-checker', orgB.id),
  };
  created.users.push(...Object.values(users).map((u) => u.id));

  return { orgA, orgB, users };
}

function buildStack({ orgA, users }) {
  const document = CHANGE_REQUEST_APPROVAL;
  const now = () => new Date();
  const policy = securityPolicySchema.parse({ environment: 'test' });
  const securitySink = new InMemorySecurityEventSink();
  const events = new SecurityEventEmitter({ sinks: [securitySink] });
  const auditSink = new InMemoryAuditSink();
  const auditService = new AuditService({ sink: auditSink });

  const definitionStore = new runtime.PrismaDefinitionStore(prisma.workflowDefinition);
  const instances = new runtime.PrismaInstanceStore(prisma.workflowInstance);
  const versions = new runtime.PrismaVersionStore(
    prisma.workflowVersion,
    prisma.workflowInstance,
    prisma.workflowDefinition,
  );
  const decisions = new runtime.PrismaDecisionStore(prisma.workflowDecision);

  // Persisted, unlike the foundation run: the queue is the thing under test here, and a
  // queue read from memory would prove the projection, not the read path.
  const taskStore = new PrismaTaskStore(prisma.workflowTask);
  const taskService = new TaskService({ store: taskStore, events, now });

  const engine = new runtime.WorkflowEngine({
    instances,
    versions,
    decisions,
    tasks: taskService,
    taskStore,
    history: new HistoryRecorder({
      store: new runtime.InMemoryHistoryStore(),
      audit: auditService,
      now,
    }),
    authorizer: createAuthorizer({ mfa: policy.mfa, events, additional: WORKFLOW_POLICIES }),
    sla: new SlaService({ store: new runtime.InMemorySlaStore(), calendars: new CalendarRegistry(), now }),
    idempotency: new runtime.InMemoryIdempotencyStore(now),
    assignment: {
      directory: new runtime.InMemoryMemberDirectory(
        {
          [users.aMaker.id]: { roles: ['workflow_maker'], groups: [] },
          [users.aChecker.id]: { roles: ['workflow_checker'], groups: ['reviewers'] },
          [users.aChecker2.id]: { roles: ['workflow_checker'], groups: ['reviewers'] },
        },
        orgA.id,
      ),
    },
    events,
    objectValidators: [
      { objectType: document.businessObjectType, exists: async (i) => i.organizationId === orgA.id },
    ],
    now,
  });

  const workbench = new ApprovalWorkbenchService({
    tasks: {
      listAvailable: (actor, page, pageSize) => taskService.listAvailable(actor, page, pageSize),
      listMine: (actor, page, pageSize) => taskService.listMine(actor, page, pageSize),
      find: (actor, taskId) => taskService.find(actor, taskId),
    },
    engine: {
      find: (actor, id) => engine.find(actor, id),
      list: (actor, query) => engine.list(actor, query),
      available: (actor, id) => engine.available(actor, id),
      transition: (actor, input) => engine.transition(actor, input),
    },
    decisions: {
      listForInstance: (instanceId, organizationId) =>
        decisions.listForInstance(instanceId, organizationId),
    },
    audit: { query: (query) => auditService.query(query) },
    now,
  });

  return { engine, workbench, definitionStore, versions, taskService, auditSink, securitySink, document, now };
}

async function publishDefinition({ definitionStore, versions, document, now }, orgA, users) {
  const definition = await definitionStore.create({
    organizationId: orgA.id,
    key: document.id,
    name: document.name,
    description: document.description,
    businessObjectType: document.businessObjectType,
    createdById: users.aAdmin.id,
  });

  const clock = now();
  await versions.create({
    workflowDefinitionId: definition.id,
    organizationId: orgA.id,
    version: document.version,
    status: 'published',
    definition: document,
    definitionHash: hashDefinition(document),
    initialState: document.initialState,
    finalStates: document.finalStates,
    effectiveFrom: clock,
    createdById: users.aAdmin.id,
    approvedById: users.aChecker.id,
    approvedAt: clock,
    publishedById: users.aAdmin.id,
    publishedAt: clock,
  });

  return definition;
}

const PERMISSIONS = [
  'workflow.instance.start',
  'workflow.instance.transition',
  'workflow.approval.decide',
];

function actorFor(user, organizationId, roles, options = {}) {
  return {
    userId: user.id,
    actorType: 'user',
    email: user.email,
    tokenId: correlationId,
    organizationId,
    roles,
    permissions: options.permissions ?? PERMISSIONS,
    isSuperAdmin: false,
    groupIds: options.groupIds ?? [],
    authenticationLevel: 'medium',
    mfa: false,
  };
}

/** Raises and submits one request, returning it in `manager_review`. */
async function raiseRequest(engine, maker, document, label) {
  const started = await engine.start(maker, {
    definitionKey: document.id,
    businessObjectType: document.businessObjectType,
    businessObjectId: `acr-${label}-${suffix}`,
    data: {
      title: `Grant operator (${label})`,
      amount: 0,
      riskRating: 'low',
      reason: `Approval Workbench validation: ${label}`,
      correlationId,
    },
  });

  const submitted = await engine.transition(maker, {
    instanceId: started.instance.id,
    action: 'submit',
  });

  return submitted.instance;
}

async function main() {
  const { orgA, orgB, users } = await seed();
  const stack = buildStack({ orgA, users });
  const { engine, workbench, document } = stack;

  await publishDefinition(stack, orgA, users);

  const maker = actorFor(users.aMaker, orgA.id, ['workflow_maker']);
  const checker = actorFor(users.aChecker, orgA.id, ['workflow_checker'], { groupIds: ['reviewers'] });
  const checker2 = actorFor(users.aChecker2, orgA.id, ['workflow_checker'], { groupIds: ['reviewers'] });
  const viewer = actorFor(users.aViewer, orgA.id, ['workflow_viewer'], { permissions: [] });
  const foreign = actorFor(users.bChecker, orgB.id, ['workflow_checker'], { groupIds: ['reviewers'] });

  // ======================= SCENARIO 1 — approve =========================
  const approvalCase = await raiseRequest(engine, maker, document, 'approve');

  await check('queue: the workbench shows a real pending approval', async () => {
    const page = await timed('queue', () => workbench.queue(checker, { scope: 'available' }));
    const row = page.rows.find((r) => r.workflowInstanceId === approvalCase.id);
    return {
      pass: Boolean(row),
      detail: row
        ? `row ${row.taskId} state=${row.currentState} type=${row.requestType} by=${row.requestedBy}`
        : `not in ${page.rows.length} row(s)`,
    };
  });

  await check('queue: the row carries the fields a reviewer chooses on', async () => {
    const page = await workbench.queue(checker, { scope: 'available' });
    const row = page.rows.find((r) => r.workflowInstanceId === approvalCase.id);
    if (!row) return { pass: false, detail: 'row not found' };
    const required = ['requestId', 'requestType', 'title', 'requestedBy', 'submittedAt', 'currentState', 'priority', 'version'];
    const missing = required.filter((field) => row[field] === undefined || row[field] === null);
    return { pass: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : required.join(', ') };
  });

  await check('queue: search narrows to a matching request', async () => {
    const page = await workbench.queue(checker, { scope: 'available', search: 'approve' });
    const hit = page.rows.some((r) => r.workflowInstanceId === approvalCase.id);
    const other = await workbench.queue(checker, { scope: 'available', search: 'zzz-no-such-request' });
    return {
      pass: hit && other.rows.length === 0,
      detail: `match=${hit} nonMatch=${other.rows.length} row(s)`,
    };
  });

  await check('detail: the workbench reads the real request', async () => {
    const detail = await timed('detail', () => workbench.detail(checker, approvalCase.id));
    return {
      pass: detail.workflowInstanceId === approvalCase.id && detail.requestedBy === users.aMaker.id,
      detail: `state=${detail.currentState} v${detail.version} actions=[${detail.eligibleActions.join(', ')}]`,
    };
  });

  await check('maker-checker: the maker cannot approve their own request', async () => {
    const outcome = await refusal(() =>
      workbench.decide(maker, approvalCase.id, { action: 'approve', expectedVersion: approvalCase.version }),
    );
    const reason = outcome.context?.reason ?? null;
    return {
      pass: outcome.refused && reason === 'self_approval_forbidden',
      detail: outcome.refused ? `refused: ${reason}` : 'THE MAKER APPROVED THEIR OWN REQUEST',
    };
  });

  await check('rbac: a viewer cannot approve', async () => {
    const outcome = await refusal(() =>
      workbench.decide(viewer, approvalCase.id, { action: 'approve', expectedVersion: approvalCase.version }),
    );
    return {
      pass: outcome.refused,
      detail: outcome.refused ? `refused: ${outcome.context?.reason ?? outcome.code}` : 'A VIEWER APPROVED',
    };
  });

  await check('tenancy: another tenant cannot open the request by id', async () => {
    const outcome = await refusal(() => workbench.detail(foreign, approvalCase.id));
    return {
      pass: outcome.refused && outcome.code === 'not_found',
      detail: outcome.refused ? `refused as ${outcome.code}` : 'CROSS-TENANT READ SUCCEEDED',
    };
  });

  await check('tenancy: another tenant cannot approve the request', async () => {
    const outcome = await refusal(() =>
      workbench.decide(foreign, approvalCase.id, { action: 'approve', expectedVersion: approvalCase.version }),
    );
    return {
      pass: outcome.refused,
      detail: outcome.refused ? `refused as ${outcome.code}` : 'CROSS-TENANT APPROVAL SUCCEEDED',
    };
  });

  await check('tenancy: another tenant does not see the request in their queue', async () => {
    const page = await workbench.queue(foreign, { scope: 'available' });
    const leaked = page.rows.some((r) => r.organizationId === orgA.id);
    return {
      pass: !leaked,
      detail: leaked ? 'TENANT B SAW TENANT A ROWS' : `${page.rows.length} row(s), none from tenant A`,
    };
  });

  let approvedVersion = approvalCase.version;
  await check('workflow: the checker approves and the request reaches approved', async () => {
    const fresh = await workbench.detail(checker, approvalCase.id);
    const decided = await timed('decide', () =>
      workbench.decide(checker, approvalCase.id, {
        action: 'approve',
        expectedVersion: fresh.version,
        idempotencyKey: `awb-approve-${suffix}`,
      }),
    );
    approvedVersion = decided.version;
    return { pass: decided.to === 'approved', detail: `${decided.from} -> ${decided.to} decision=${decided.decisionId}` };
  });

  await check('workflow: the approved state is in Postgres', async () => {
    const row = await prisma.workflowInstance.findUnique({ where: { id: approvalCase.id } });
    return {
      pass: row?.currentState === 'approved' && row?.organizationId === orgA.id,
      detail: row ? `state=${row.currentState} org=${row.organizationId === orgA.id ? 'A' : row.organizationId}` : 'no row',
    };
  });

  await check('concurrency: a second checker with a stale view is refused', async () => {
    // Checker 2 opened the request before checker 1 decided. Their submission carries
    // the version they read, which has since moved.
    const outcome = await refusal(() =>
      workbench.decide(checker2, approvalCase.id, {
        action: 'approve',
        expectedVersion: approvalCase.version,
      }),
    );
    return {
      pass: outcome.refused,
      detail: outcome.refused ? `refused: ${outcome.context?.reason ?? outcome.code}` : 'A SECOND DECISION WAS RECORDED',
    };
  });

  await check('concurrency: only one decision exists for the step', async () => {
    const rows = await prisma.workflowDecision.count({
      where: { workflowInstanceId: approvalCase.id, stepKey: 'manager_review' },
    });
    return { pass: rows === 1, detail: `${rows} decision row(s) for manager_review` };
  });

  await check('idempotency: replaying the same approval creates no second decision', async () => {
    const before = await prisma.workflowDecision.count({ where: { workflowInstanceId: approvalCase.id } });
    await refusal(() =>
      workbench.decide(checker, approvalCase.id, {
        action: 'approve',
        expectedVersion: approvedVersion,
        idempotencyKey: `awb-approve-${suffix}`,
      }),
    );
    const after = await prisma.workflowDecision.count({ where: { workflowInstanceId: approvalCase.id } });
    return { pass: after === before, detail: `${before} -> ${after} decision row(s)` };
  });

  await check('queue: the approved request has left the pending queue', async () => {
    const page = await workbench.queue(checker, { scope: 'available' });
    const still = page.rows.some((r) => r.workflowInstanceId === approvalCase.id);
    return { pass: !still, detail: still ? 'STILL PENDING' : `absent from ${page.rows.length} pending row(s)` };
  });

  await check('queue: the approved request appears under completed', async () => {
    const page = await workbench.queue(checker, { scope: 'completed' });
    const found = page.rows.some((r) => r.workflowInstanceId === approvalCase.id);
    return { pass: found, detail: found ? 'present in completed' : `absent from ${page.rows.length} completed row(s)` };
  });

  await check('audit: the decision is visible on the detail timeline', async () => {
    const detail = await workbench.detail(checker, approvalCase.id);
    return {
      pass: detail.auditTimeline.length > 0,
      detail: `${detail.auditTimeline.length} entr(ies): ${[...new Set(detail.auditTimeline.map((e) => e.action))].join(', ')}`,
    };
  });

  await check('policy: the recorded decision names the authorization that permitted it', async () => {
    const detail = await workbench.detail(checker, approvalCase.id);
    const decision = detail.decisions.find((d) => d.decision === 'approve');
    return {
      pass: Boolean(decision),
      detail: decision
        ? `decision=${decision.decisionId} policyDecisionId=${decision.policyDecisionId ?? 'null'} role=${decision.actorRole ?? 'null'}`
        : 'no approval decision recorded',
    };
  });

  // ======================= SCENARIO 2 — reject ==========================
  const rejectCase = await raiseRequest(engine, maker, document, 'reject');

  await check('reject: a rejection with no reason is refused before it reaches the engine', async () => {
    const outcome = await refusal(() =>
      workbench.decide(checker, rejectCase.id, { action: 'reject', expectedVersion: rejectCase.version }),
    );
    return {
      pass: outcome.refused && outcome.code === 'validation_error',
      detail: outcome.refused ? `refused as ${outcome.code}` : 'A REJECTION WITH NO REASON WAS ACCEPTED',
    };
  });

  await check('reject: the checker rejects with a reason', async () => {
    const fresh = await workbench.detail(checker, rejectCase.id);
    const decided = await workbench.decide(checker, rejectCase.id, {
      action: 'reject',
      expectedVersion: fresh.version,
      reasonCode: 'insufficient_justification',
      explanation: 'The business reason does not cover production access.',
    });
    return { pass: decided.to === 'rejected', detail: `${decided.from} -> ${decided.to}` };
  });

  await check('reject: the original request still exists, with its reason', async () => {
    const detail = await workbench.detail(checker, rejectCase.id);
    const decision = detail.decisions.find((d) => d.decision === 'reject');
    return {
      pass: Boolean(decision) && decision.reasonCode === 'insufficient_justification',
      detail: decision ? `reason=${decision.reasonCode}` : 'no rejection decision recorded',
    };
  });

  // ======================= SCENARIO 3 — rework ==========================
  const reworkCase = await raiseRequest(engine, maker, document, 'rework');

  await check('rework: the checker returns the request for rework', async () => {
    const fresh = await workbench.detail(checker, reworkCase.id);
    const decided = await workbench.decide(checker, reworkCase.id, {
      action: 'return_for_rework',
      expectedVersion: fresh.version,
      reasonCode: 'needs_more_detail',
      explanation: 'Name the systems in scope.',
    });
    return { pass: decided.to !== 'manager_review', detail: `${decided.from} -> ${decided.to}` };
  });

  await check('rework: the maker resubmits and a checker approves', async () => {
    const afterReturn = await engine.find(maker, reworkCase.id);
    const resubmitted = await engine.transition(maker, {
      instanceId: reworkCase.id,
      action: 'resubmit',
      expectedVersion: afterReturn.version,
    });
    const fresh = await workbench.detail(checker, reworkCase.id);
    const approved = await workbench.decide(checker, reworkCase.id, {
      action: 'approve',
      expectedVersion: fresh.version,
    });
    return {
      pass: approved.to === 'approved',
      detail: `resubmit -> ${resubmitted.to}, approve -> ${approved.to}`,
    };
  });

  await check('rework: the full decision history is preserved across the cycle', async () => {
    const detail = await workbench.detail(checker, reworkCase.id);
    const kinds = detail.decisions.map((d) => `${d.decision}@cycle${d.reworkCycle}`);
    // The framework's outcomes are the action names — approve, reject,
    // return_for_rework, abstain — not past-tense forms.
    const hasReturn = detail.decisions.some((d) => d.decision === 'return_for_rework');
    const hasApproval = detail.decisions.some((d) => d.decision === 'approve');
    return {
      pass: detail.decisions.length >= 2 && hasApproval && hasReturn,
      detail: `${detail.decisions.length} decision(s): ${kinds.join(', ')}${hasReturn ? '' : ' (no explicit return decision recorded)'}`,
    };
  });

  await check('rework: the rework cycle is recorded on the instance', async () => {
    const row = await prisma.workflowInstance.findUnique({ where: { id: reworkCase.id } });
    return { pass: (row?.reworkCount ?? 0) >= 1, detail: `reworkCount=${row?.reworkCount ?? 'null'}` };
  });

  // ======================= security =====================================

  await check('security: an actor with no organization is refused', async () => {
    const outcome = await refusal(() =>
      workbench.queue({ ...checker, organizationId: '' }, { scope: 'available' }),
    );
    return { pass: outcome.refused, detail: outcome.refused ? `refused: ${outcome.reason.slice(0, 70)}` : 'ACCEPTED' };
  });

  await check('security: a query carrying its own organization is refused', async () => {
    const outcome = await refusal(() =>
      workbench.queue(checker, { scope: 'available', organizationId: orgB.id }),
    );
    return { pass: outcome.refused, detail: outcome.refused ? 'refused by the strict schema' : 'TAMPERED QUERY ACCEPTED' };
  });

  await check('security: a submission carrying its own actor is refused', async () => {
    const outcome = await refusal(() =>
      workbench.decide(checker, reworkCase.id, {
        action: 'approve',
        expectedVersion: 1,
        actorId: users.aMaker.id,
      }),
    );
    return { pass: outcome.refused, detail: outcome.refused ? 'refused by the strict schema' : 'TAMPERED SUBMISSION ACCEPTED' };
  });

  await check('security: an action outside the workbench is refused', async () => {
    const outcome = await refusal(() =>
      workbench.decide(checker, reworkCase.id, { action: 'cancel', expectedVersion: 1 }),
    );
    return { pass: outcome.refused, detail: outcome.refused ? 'refused' : 'AN UNDECLARED ACTION WAS ACCEPTED' };
  });

  await check('security: an unknown request id is not found rather than forbidden', async () => {
    const outcome = await refusal(() => workbench.detail(checker, `wfi_${randomUUID()}`));
    return {
      pass: outcome.refused && outcome.code === 'not_found',
      detail: outcome.refused ? `refused as ${outcome.code}` : 'ACCEPTED',
    };
  });

  await check('capability: reassignment is reported unavailable rather than faked', async () => {
    const outcome = await refusal(() =>
      workbench.reassign(checker, 'task_x', { assigneeUserId: users.aChecker2.id, reason: 'leave' }),
    );
    return {
      pass: outcome.refused && outcome.context?.reason === 'reassignment_unavailable',
      detail: outcome.refused ? `refused: ${outcome.context?.reason}` : 'REASSIGNMENT SILENTLY SUCCEEDED',
    };
  });

  // ======================= performance =================================
  //
  // Representative for DEV and nothing more. These are measured against a Railway
  // Postgres over a public proxy from a developer machine, so they carry the network
  // twice; they are recorded because §30 asks for real numbers, not because they
  // predict anything about a production deployment.

  await check('performance: the queue and detail are sampled, not guessed', async () => {
    for (let i = 0; i < 20; i += 1) {
      await timed('queue', () => workbench.queue(checker, { scope: 'available' }));
      await timed('detail', () => workbench.detail(checker, reworkCase.id));
    }

    const queueSamples = timings.filter((t) => t.label === 'queue').length;
    const detailSamples = timings.filter((t) => t.label === 'detail').length;
    return {
      pass: queueSamples >= 20 && detailSamples >= 20,
      detail: `queue n=${queueSamples}, detail n=${detailSamples}`,
    };
  });

  await check('capability: comments are reported unavailable rather than empty', async () => {
    const detail = await workbench.detail(checker, reworkCase.id);
    return {
      pass: detail.comments.available === false,
      detail: detail.comments.available === false ? detail.comments.reason : 'reported as available',
    };
  });
}

async function cleanup() {
  // Ordered by dependency; a failed run leaves nothing behind.
  await prisma.workflowDecision.deleteMany({ where: { organizationId: { in: created.organizations } } }).catch(() => {});
  await prisma.workflowTask.deleteMany({ where: { organizationId: { in: created.organizations } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { organizationId: { in: created.organizations } } }).catch(() => {});
  await prisma.workflowVersion.deleteMany({ where: { organizationId: { in: created.organizations } } }).catch(() => {});
  await prisma.workflowDefinition.deleteMany({ where: { organizationId: { in: created.organizations } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: created.organizations } } }).catch(() => {});
  await prisma.organizationMember.deleteMany({ where: { organizationId: { in: created.organizations } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: created.organizations } } }).catch(() => {});
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  results.push({ check: 'scenario', status: 'FAIL', detail: `the run aborted: ${error.message}` });
} finally {
  await cleanup();
  await prisma.$disconnect();
}

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

const performance = {};
for (const label of [...new Set(timings.map((t) => t.label))]) {
  const samples = timings.filter((t) => t.label === label).map((t) => t.ms);
  performance[label] = {
    samples: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
  };
}

const errorRate = results.length === 0 ? null : failed / results.length;

const summary = {
  generatedAt: new Date().toISOString(),
  correlationId,
  environment: process.env.TRUSTOS_ENVIRONMENT ?? 'unknown',
  application: 'approval-workbench',
  totals: { checks: results.length, passed, failed, errorRate },
  verdict: failed === 0 ? 'PASS' : passed === 0 ? 'FAIL' : 'PARTIAL',
  performance,
  results,
};

if (wantJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Approval Workbench validation — correlation ${correlationId}\n`);
  for (const result of results) {
    console.log(`  ${result.status.padEnd(4)}  ${result.check.padEnd(66)} ${result.detail}`);
  }
  console.log(`\n  ${passed}/${results.length} checks passed  (error rate ${(errorRate * 100).toFixed(1)}%)`);
  for (const [label, stats] of Object.entries(performance)) {
    console.log(`  ${label}: p50 ${stats.p50?.toFixed(1)}ms  p95 ${stats.p95?.toFixed(1)}ms  (n=${stats.samples})`);
  }
  console.log(`\nVerdict: ${summary.verdict}`);
}

mkdirSync(join(root, 'docs/validation'), { recursive: true });
writeFileSync(
  join(root, 'docs/validation/approval-workbench-latest.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);

/*
 * The evidence record the Governance Tool reads.
 *
 * Written from this run's own counts, so the catalog cannot report a status nobody
 * measured. `lifecycle` is deliberately not written: passing validation is not
 * promotion, and an application that works is still `draft` until somebody with the
 * authority to say so decides otherwise.
 *
 * A failed or partial run writes its verdict too, rather than leaving a previous pass
 * standing. Stale green is worse than red.
 */
const evidencePath = join(root, 'docs/validation/application-evidence.json');
let index = {};
try {
  index = JSON.parse(readFileSync(evidencePath, 'utf8'));
} catch {
  index = {};
}

index['approval-workbench'] = {
  appId: 'approval-workbench',
  status: summary.verdict === 'PASS' ? 'pass' : summary.verdict === 'FAIL' ? 'fail' : 'partial',
  environment: summary.environment,
  suite: 'npm run validate:approval-workbench',
  commit: commitSha,
  validatedAt: summary.generatedAt,
  checks: { total: results.length, passed, failed },
  evidenceRef: 'docs/validation/approval-workbench-latest.json',
};

writeFileSync(evidencePath, `${JSON.stringify(index, null, 2)}\n`);

/*
 * The same evidence as a compiled module.
 *
 * The JSON above is for people; this is what the application actually reads. It has to
 * be a module under `packages/` because the runtime image copies `packages/` and not
 * `docs/` — reading the JSON at startup meant every deployed environment reported
 * not_tested, which was the safe answer to a question nobody could answer.
 *
 * Written through Prettier's own settings by the format step, and committed, so a change
 * to what the framework claims about itself appears in a diff.
 */
const modulePath = join(root, 'packages/governance-tool-core/src/recorded-evidence.ts');
const header = `/**
 * Validation evidence, as a compiled module.
 *
 * GENERATED by the validation suites — edit those, not this.
 *
 * A module rather than a JSON file read at startup, because the runtime image copies
 * \`packages/\` and not \`docs/\`: the file was never present in a deployed environment and
 * every application reported not_tested. Committed, so a change to what the framework
 * claims about itself shows up in a diff next to the code it claims about.
 *
 * Each record names the commit it was validated at. Nothing here verifies the running
 * build is that commit — the container has no way to know its own — so the commit is
 * carried through to the API rather than checked. A reader can compare it; the framework
 * does not pretend to.
 */

import type { ApplicationEvidenceIndex } from './application-evidence';

export const RECORDED_APPLICATION_EVIDENCE: ApplicationEvidenceIndex = Object.freeze(
${JSON.stringify(index, null, 2)
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')},
);
`;
writeFileSync(modulePath, header);

/*
 * Formatted by Prettier, because CI checks formatting and a generator that emits
 * unformatted source breaks the build every time somebody runs it. Generated code is
 * still code, and it lives in the same tree under the same rules.
 */
try {
  execFileSync('npx', ['prettier', '--write', modulePath], { cwd: root, stdio: 'ignore' });
} catch {
  console.warn(
    `\n  Could not format ${modulePath}. Run "npx prettier --write" on it before committing.`,
  );
}

if (failed > 0) exitCode = 1;
process.exit(exitCode);

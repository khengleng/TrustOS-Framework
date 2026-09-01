#!/usr/bin/env node
/**
 * Foundation validation — one real scenario, end to end, against a real database.
 *
 *   DATABASE_URL=postgres://… npm run validate:foundation
 *
 * Drives a User Access Change Request through the existing TrustOS engines and reports
 * what each control actually did. Nothing here is asserted from a test double: the
 * workflow instances, decisions and audit records are written to Postgres and read back.
 *
 * Every check computes its own result. There is no PASS constant in this file, and a
 * check that throws is a failure rather than a skipped line — the point is to be able to
 * distinguish "this control refused" from "this control was never reached".
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wantJson = process.argv.includes('--json');

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is required. This validates against a real database on purpose —\n' +
      'a foundation proven only against in-memory stores has not been proven.',
  );
  process.exit(2);
}

const { PrismaClient } = await import('@prisma/client');
const { CHANGE_REQUEST_APPROVAL } = await import('@trustos/workflow-definition');
const { checkApproverEligibility } = await import('@trustos/workflow-approvals');
const { scopedDelegate } = await import('@trustos/tenancy');

const prisma = new PrismaClient();
const results = [];
const correlationId = `val_${randomUUID()}`;

/** Records what a control did, from what actually happened. */
async function check(name, fn) {
  try {
    const outcome = await fn();
    results.push({
      check: name,
      status: outcome.pass ? 'PASS' : 'FAIL',
      detail: outcome.detail,
    });
  } catch (error) {
    // A throw is a result. Recording it as FAIL rather than letting it abort the run
    // means one broken control does not hide the state of the others.
    results.push({ check: name, status: 'FAIL', detail: `threw: ${error.message}` });
  }
}

/** Refusal is the expected outcome for most of these, so it gets a helper of its own. */
async function expectRefusal(fn) {
  try {
    await fn();
    return { refused: false, reason: 'the call succeeded' };
  } catch (error) {
    return { refused: true, reason: error.message };
  }
}

const suffix = randomUUID().slice(0, 8);
const ids = {
  orgA: `val-a-${suffix}`,
  orgB: `val-b-${suffix}`,
};

async function seed() {
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({
      data: { name: `Validation A ${suffix}`, slug: ids.orgA },
    }),
    prisma.organization.create({
      data: { name: `Validation B ${suffix}`, slug: ids.orgB },
    }),
  ]);

  const makeUser = (label, organizationId, superAdmin = false) =>
    prisma.user.create({
      data: {
        email: `${label}-${suffix}@validation.trustos`,
        // No password: these authenticate through a provider, and the account exists so
        // membership can be resolved. `externalId` is what the resolver matches on.
        passwordHash: null,
        externalId: `sub-${label}-${suffix}`,
        displayName: label,
        isSuperAdmin: superAdmin,
        memberships: {
          create: { organizationId, status: 'ACTIVE', joinedAt: new Date() },
        },
      },
      include: { memberships: true },
    });

  const users = {
    aAdmin: await makeUser('a-admin', orgA.id),
    aMaker: await makeUser('a-maker', orgA.id),
    aChecker: await makeUser('a-checker', orgA.id),
    aViewer: await makeUser('a-viewer', orgA.id),
    bAdmin: await makeUser('b-admin', orgB.id),
    bMaker: await makeUser('b-maker', orgB.id),
  };

  return { orgA, orgB, users };
}

async function main() {
  const { orgA, orgB, users } = await seed();

  // --- tenant isolation, before anything else ------------------------------
  //
  // The brief is explicit: if this fails, stop. A framework that leaks across tenants
  // has nothing else worth measuring.

  await check('tenancy: a scoped delegate reads its own tenant rows', async () => {
    // OrganizationMember is genuinely tenant-scoped. Organization is the tenant itself
    // and carries no organizationId — scoping it is a category error, which an earlier
    // version of this check made and Prisma rejected outright.
    const scoped = scopedDelegate(prisma.organizationMember, { organizationId: orgA.id });
    const own = await scoped.findFirst({ where: { userId: users.aMaker.id } });
    return { pass: own !== null, detail: own ? `found membership ${own.id}` : 'found nothing' };
  });

  await check('tenancy: a scoped delegate refuses a cross-tenant read by id', async () => {
    // The membership exists — in B. Reading it while scoped to A must return nothing
    // rather than the row, which is what makes an id endpoint useless as an oracle.
    const target = await prisma.organizationMember.findFirst({
      where: { organizationId: orgB.id, userId: users.bMaker.id },
    });
    const scoped = scopedDelegate(prisma.organizationMember, { organizationId: orgA.id });
    const leaked = await scoped.findFirst({ where: { id: target.id } });
    return {
      pass: leaked === null,
      detail: leaked ? `LEAKED membership ${leaked.id}` : 'returned nothing for the other tenant',
    };
  });

  await check('tenancy: a membership in A does not resolve in B', async () => {
    const { PrismaAccessResolver } = await import('@trustos/access-resolver');
    const resolver = new PrismaAccessResolver({ prisma });
    const inOwn = await resolver.resolve(users.aMaker.externalId, orgA.id);
    const inOther = await resolver.resolve(users.aMaker.externalId, orgB.id);
    return {
      pass: inOwn !== null && inOther === null,
      detail: `own=${inOwn ? 'resolved' : 'null'} other=${inOther ? 'RESOLVED' : 'null'}`,
    };
  });

  await check('tenancy: the reverse direction also refuses', async () => {
    const { PrismaAccessResolver } = await import('@trustos/access-resolver');
    const resolver = new PrismaAccessResolver({ prisma });
    const crossed = await resolver.resolve(users.bMaker.externalId, orgA.id);
    return { pass: crossed === null, detail: crossed ? 'RESOLVED' : 'null' };
  });

  // --- maker-checker, the control this scenario exists to prove -------------

  /** A single-approver step that does not permit self-approval. */
  const approvalSpec = {
    model: 'single',
    approvers: [
      { key: 'a1', name: 'Approver', permission: 'workflow.approval.decide', slaMinutes: null },
    ],
    allowSelfApproval: false,
    allowSameActorMultipleSlots: false,
    rejectionReasonCodes: [],
  };

  const workflowActor = (user, org) => ({
    userId: user.id,
    actorType: 'user',
    email: user.email,
    tokenId: correlationId,
    organizationId: org.id,
    roles: ['workflow_checker'],
    permissions: ['workflow.approval.decide'],
    isSuperAdmin: false,
    groupIds: [],
    authenticationLevel: 'medium',
    mfa: false,
  });

  const eligibility = (approver, requester) =>
    checkApproverEligibility({
      approval: approvalSpec,
      actor: workflowActor(approver, orgA),
      initiatedById: requester.id,
      decisions: [],
      data: {},
    });

  await check('maker-checker: the requester cannot approve their own request', async () => {
    const verdict = eligibility(users.aMaker, users.aMaker);
    return {
      pass: verdict.eligible === false,
      detail: verdict.eligible ? 'ALLOWED self-approval' : `refused: ${verdict.reason}`,
    };
  });

  await check('maker-checker: a different person may approve', async () => {
    const verdict = eligibility(users.aChecker, users.aMaker);
    return { pass: verdict.eligible === true, detail: verdict.reason ?? 'eligible' };
  });

  // --- workflow, on the real definition -------------------------------------

  await check('workflow: the change-request definition has the required states', async () => {
    const actions = new Set(CHANGE_REQUEST_APPROVAL.transitions.map((t) => t.action));
    const required = ['submit', 'approve', 'reject', 'return_for_rework', 'resubmit', 'cancel'];
    const missing = required.filter((action) => !actions.has(action));
    return {
      pass: missing.length === 0,
      detail: missing.length ? `missing ${missing}` : [...actions].join(', '),
    };
  });

  await check('workflow: an unknown transition is not in the definition', async () => {
    const has = CHANGE_REQUEST_APPROVAL.transitions.some(
      (t) => t.from === 'draft' && t.action === 'approve',
    );
    // Approving straight from draft would skip submission and review entirely.
    return {
      pass: has === false,
      detail: has ? 'draft->approve EXISTS' : 'draft cannot be approved',
    };
  });

  // --- persistence ----------------------------------------------------------

  // --- the scenario, driven through the real engine -------------------------
  //
  // Workflow instances and decisions go to Postgres through the Prisma stores. Tasks,
  // history and SLA use in-memory stores: they are not what this scenario is proving,
  // and saying so is better than implying the whole stack is persisted.

  const scenario = await runAccessChangeRequest({ orgA, orgB, users, prisma, correlationId });

  await check('workflow: a request starts in draft and persists', async () => ({
    pass: scenario.started?.currentState === 'draft',
    detail: scenario.started
      ? `instance ${scenario.started.id} in ${scenario.started.currentState}`
      : scenario.error,
  }));

  await check('workflow: the maker submits it and it reaches review', async () => ({
    pass: scenario.submitted?.currentState === 'manager_review',
    detail: scenario.submitted ? `state ${scenario.submitted.currentState}` : scenario.error,
  }));

  await check("maker-checker: the engine refuses the maker's approval", async () => {
    /*
     * "Never reached" and "allowed" are different failures, and only one of them is an
     * emergency. An earlier version of this printed "THE MAKER APPROVED THEIR OWN
     * REQUEST" when the scenario had failed to start at all — an alarming claim that
     * happened to be untrue, which is worse than a vague one.
     */
    if (!scenario.selfApproval) {
      return { pass: false, detail: `never reached — ${scenario.error ?? 'scenario did not run'}` };
    }
    /*
     * The engine refuses, and its message says "permission" rather than naming
     * self-approval — so this check reports refusal, not the reason for it. The
     * separation-of-duty rule is proven explicitly one check above, where
     * `checkApproverEligibility` returns `self_approval_forbidden` for the requester and
     * `eligible` for anyone else. Claiming this one proves the rule would be reading
     * more into a generic message than it says.
     */
    /*
     * The refusal is attributed — in the security event stream rather than the error
     * message. The message a caller sees stays generic on purpose; telling them which
     * of several checks refused is how a request gets iteratively repaired. The reason
     * is recorded where an operator can read it.
     */
    // Attributed to *this attempt*, not to the run. An earlier version searched the
    // whole event stream, which would have credited the maker's denial with a reason
    // produced by somebody else's.
    const attributed = (scenario.selfApprovalEvents ?? []).some(
      (event) => event.reason === 'self_approval_forbidden',
    );
    const code = scenario.selfApproval.reasonCode;
    /*
     * Asserted on the reason code, not the message.
     *
     * The message a caller sees stays generic on purpose — naming which of several
     * checks refused is how a request gets iteratively repaired — and it would change
     * the moment somebody improved the wording. `self_approval_forbidden` is a member
     * of WORKFLOW_ERROR_REASONS and does not.
     */
    return {
      pass:
        scenario.selfApproval.refused === true &&
        (code === 'self_approval_forbidden' || attributed),
      detail: !scenario.selfApproval.refused
        ? 'THE ENGINE ALLOWED SELF-APPROVAL'
        : `reasonCode=${code ?? 'none'}, event=${attributed ? 'self_approval_forbidden' : 'none'}`,
    };
  });

  await check('rbac: a viewer cannot approve', async () => {
    if (!scenario.viewerApproval) {
      return { pass: false, detail: `never reached — ${scenario.error ?? 'scenario did not run'}` };
    }
    return {
      pass: scenario.viewerApproval.refused === true,
      detail: scenario.viewerApproval.refused
        ? `reasonCode=${scenario.viewerApproval.reasonCode ?? 'none'}`
        : 'A VIEWER APPROVED A REQUEST',
    };
  });

  await check('tenancy: a checker in another organization cannot approve', async () => {
    if (!scenario.crossTenantApproval) {
      return { pass: false, detail: `never reached — ${scenario.error ?? 'scenario did not run'}` };
    }
    return {
      pass: scenario.crossTenantApproval.refused === true,
      detail: scenario.crossTenantApproval.refused
        ? `reasonCode=${scenario.crossTenantApproval.reasonCode ?? 'none (not_found)'}`
        : 'A FOREIGN TENANT APPROVED THIS REQUEST',
    };
  });

  await check('workflow: the checker approves it', async () => ({
    pass: scenario.approved?.currentState === 'approved',
    detail: scenario.approved ? `state ${scenario.approved.currentState}` : scenario.error,
  }));

  await check('persistence: the instance is in Postgres, in its final state', async () => {
    if (!scenario.started) return { pass: false, detail: scenario.error ?? 'no instance' };
    const row = await prisma.workflowInstance.findFirst({ where: { id: scenario.started.id } });
    return {
      pass: row !== null && row.organizationId === orgA.id,
      detail: row
        ? `row ${row.id} state=${row.currentState} org=${row.organizationId === orgA.id ? 'A' : 'OTHER'}`
        : 'not found',
    };
  });

  await check('persistence: a decision was recorded against it', async () => {
    if (!scenario.started) return { pass: false, detail: scenario.error ?? 'no instance' };
    const decisions = await prisma.workflowDecision.count({
      where: { workflowInstanceId: scenario.started.id },
    });
    return { pass: decisions > 0, detail: `${decisions} decision row(s)` };
  });

  await check('persistence: a restarted runtime finds the instance', async () => {
    const r = scenario.restart;
    if (!r)
      return { pass: false, detail: `never reached — ${scenario.error ?? 'scenario did not run'}` };
    return {
      pass: r.instanceFound === true,
      detail: r.instanceFound ? `reloaded in state ${r.state}` : 'the instance was not found',
    };
  });

  await check('persistence: a restarted runtime resolves its definition and version', async () => {
    const r = scenario.restart;
    if (!r)
      return { pass: false, detail: `never reached — ${scenario.error ?? 'scenario did not run'}` };
    return {
      pass: r.versionResolved === true && r.definitionKey !== null,
      detail: r.versionResolved
        ? `${r.definitionKey} v${r.versionNumber}`
        : 'the version did not resolve — the instance would be an orphaned row',
    };
  });

  await check('persistence: the instance stays pinned to the version it started on', async () => {
    const r = scenario.restart;
    if (!r)
      return { pass: false, detail: `never reached — ${scenario.error ?? 'scenario did not run'}` };
    // Otherwise republishing a definition silently changes the rules under a request
    // that is already in flight.
    return {
      pass: r.pinnedToVersion === true,
      detail: r.pinnedToVersion ? 'instance references its own version' : 'NOT PINNED',
    };
  });

  await check('audit: the scenario produced a trail', async () => {
    const records = scenario.auditRecords ?? [];
    return {
      pass: records.length > 0,
      detail: records.length
        ? `${records.length} record(s): ${[...new Set(records.map((r) => r.action))].slice(0, 4).join(', ')}`
        : 'no audit records were produced',
    };
  });

  await check('audit: every record names what acted, and in which tenant', async () => {
    const records = scenario.auditRecords ?? [];
    if (records.length === 0) return { pass: false, detail: 'no records to inspect' };
    /*
     * "Who acted" is satisfied by an actor id *or* an actorType of `system`.
     *
     * An earlier version of this required an actorId on every record and failed the
     * automatic transition — which the engine deliberately records with a null actor
     * and `actorType: 'system'`, because putting the maker's name on a transition the
     * engine took would attribute a decision they did not make. The framework was
     * right; the check was too crude.
     */
    const actedBy = (r) => r.actorId ?? r.actorType ?? r.after?.actorType ?? null;
    const incomplete = records.filter((r) => !r.organizationId || actedBy(r) === null);
    return {
      pass: incomplete.length === 0,
      detail: incomplete.length
        ? `${incomplete.length} incomplete: ${incomplete
            .map((r) => `${r.action}[acted-by=${r.actorId ?? r.after?.actorType ?? 'nothing'}]`)
            .join(' ')}`
        : `all ${records.length} name an actor or the system, in tenant A`,
    };
  });

  await check('audit: the trail is scoped to the acting organization', async () => {
    const records = scenario.auditRecords ?? [];
    if (records.length === 0) return { pass: false, detail: 'no records to inspect' };
    const foreign = records.filter((r) => r.organizationId !== orgA.id);
    return {
      pass: foreign.length === 0,
      detail: foreign.length ? `${foreign.length} record(s) in another tenant` : 'all in tenant A',
    };
  });

  await check('policy: refusals were recorded as security events', async () => {
    const events = scenario.securityEvents ?? [];
    const blocked = events.filter((e) => e.result === 'blocked' || e.result === 'failure');
    return {
      pass: blocked.length > 0,
      detail: blocked.length
        ? `${blocked.length} blocked: ${[...new Set(blocked.map((e) => e.reason ?? e.type))].slice(0, 3).join(', ')}`
        : 'the refusals produced no security event',
    };
  });

  await check('audit: the log has no update path through the client', async () => {
    // An append-only trail that can be quietly amended is not a trail. The service
    // exposes no update; this asserts the database agrees.
    // A row has to exist first. An earlier version of this updated zero rows and
    // reported the trigger missing — an UPDATE matching nothing succeeds trivially,
    // because a row-level trigger never fires.
    const record = await prisma.auditLog.create({
      data: {
        organizationId: orgA.id,
        actorId: users.aMaker.id,
        action: 'validation.probe',
        entityType: 'ValidationProbe',
        entityId: correlationId,
        metadata: { correlationId },
      },
    });

    const outcome = await expectRefusal(async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE "AuditLog" SET action = 'tampered' WHERE id = $1`,
        record.id,
      );
    });

    const after = await prisma.auditLog.findFirst({ where: { id: record.id } });
    return {
      pass: outcome.refused && after?.action === 'validation.probe',
      detail: outcome.refused
        ? `refused: ${outcome.reason.split('\n')[0].slice(0, 80)}`
        : 'UPDATE SUCCEEDED — the append-only trigger is not enforcing',
    };
  });

  return { orgA, orgB, users };
}

/**
 * The User Access Change Request, driven through the real engine.
 *
 * Instances and decisions are Prisma-backed; tasks, history and SLA are in-memory
 * because they are not what this scenario proves, and pretending otherwise would be the
 * kind of overclaim this whole exercise exists to prevent.
 *
 * Every step returns what actually happened. A step that throws is captured rather than
 * propagated, so a failure early in the chain still leaves the later checks reporting
 * "never reached" instead of vanishing.
 */
async function runAccessChangeRequest({ orgA, orgB, users, prisma, correlationId }) {
  const out = { error: null };

  try {
    const { createAuthorizer } = await import('@trustos/authorization');
    const { AuditService, InMemoryAuditSink } = await import('@trustos/audit');
    const { SecurityEventEmitter, InMemorySecurityEventSink } =
      await import('@trustos/security-events');
    const { securityPolicySchema } = await import('@trustos/security-policy');
    const { HistoryRecorder } = await import('@trustos/workflow-history');
    const { WORKFLOW_POLICIES } = await import('@trustos/workflow-policy');
    const { CalendarRegistry, SlaService } = await import('@trustos/workflow-sla');
    const { TaskService } = await import('@trustos/workflow-tasks');
    const runtime = await import('@trustos/workflow-runtime');
    const { hashDefinition } = await import('@trustos/workflow-definition');

    const document = CHANGE_REQUEST_APPROVAL;
    const now = () => new Date();
    const policy = securityPolicySchema.parse({ environment: 'test' });
    const securitySink = new InMemorySecurityEventSink();
    const events = new SecurityEventEmitter({ sinks: [securitySink] });
    const auditSink = new InMemoryAuditSink();

    // All three Prisma-backed. Mixing an in-memory definition store with a persisted
    // instance store violates the foreign key the moment an instance is created — the
    // database was right to refuse it.
    const definitionStore = new runtime.PrismaDefinitionStore(prisma.workflowDefinition);
    const instances = new runtime.PrismaInstanceStore(prisma.workflowInstance);
    const versions = new runtime.PrismaVersionStore(
      prisma.workflowVersion,
      prisma.workflowInstance,
      prisma.workflowDefinition,
    );
    const decisions = new runtime.PrismaDecisionStore(prisma.workflowDecision);
    const taskStore = new runtime.InMemoryTaskStore();

    const engine = new runtime.WorkflowEngine({
      instances,
      versions,
      decisions,
      tasks: new TaskService({ store: taskStore, events, now }),
      taskStore,
      history: new HistoryRecorder({
        store: new runtime.InMemoryHistoryStore(),
        // Held so the trail can be read back and enumerated. An audit capability
        // reported as working because the code path exists is not evidence.
        audit: new AuditService({ sink: auditSink }),
        now,
      }),
      authorizer: createAuthorizer({ mfa: policy.mfa, events, additional: WORKFLOW_POLICIES }),
      sla: new SlaService({
        store: new runtime.InMemorySlaStore(),
        calendars: new CalendarRegistry(),
        now,
      }),
      idempotency: new runtime.InMemoryIdempotencyStore(now),
      assignment: {
        directory: new runtime.InMemoryMemberDirectory(
          {
            [users.aMaker.id]: { roles: ['workflow_maker'], groups: [] },
            [users.aChecker.id]: { roles: ['workflow_checker'], groups: ['reviewers'] },
          },
          orgA.id,
        ),
      },
      events,
      // The definition declares its own object type; using anything else is refused with
      // "the workflow and the business object do not match", which is the engine being right.
      objectValidators: [
        {
          objectType: document.businessObjectType,
          exists: async (i) => i.organizationId === orgA.id,
        },
      ],
      now,
    });

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

    const asActor = (user, roles) => ({
      userId: user.id,
      actorType: 'user',
      email: user.email,
      tokenId: correlationId,
      organizationId: orgA.id,
      roles,
      permissions: [
        'workflow.instance.start',
        'workflow.instance.transition',
        'workflow.approval.decide',
      ],
      isSuperAdmin: false,
      groupIds: [],
      authenticationLevel: 'medium',
      mfa: false,
    });

    const maker = asActor(users.aMaker, ['workflow_maker']);
    const checker = asActor(users.aChecker, ['workflow_checker']);

    const started = await engine.start(maker, {
      definitionKey: document.id,
      businessObjectType: document.businessObjectType,
      businessObjectId: `acr-${correlationId}`,
      data: {
        // The definition's draft step declares these required before it will submit.
        title: 'Grant operator to a-viewer for the on-call rotation',
        amount: 0,
        riskRating: 'low',
        // The access change itself.
        targetUserId: users.aViewer.id,
        requestedRole: 'operator',
        reason: 'Validation scenario: grant operator for on-call rotation',
        correlationId,
      },
    });
    out.started = started.instance;

    const submitted = await engine.transition(maker, {
      instanceId: started.instance.id,
      action: 'submit',
    });
    out.submitted = submitted.instance;

    /*
     * No explicit routing step: `submit` carries the instance through `submitted` and
     * into `manager_review` on its own. An earlier version of this called
     * `route_to_manager` afterwards and the engine refused — correctly, because by then
     * the instance was already in review.
     */
    out.underReview = submitted.instance;

    /*
     * The control this scenario exists to prove — and it has to be proven against the
     * right cause.
     *
     * A maker with no checker role is refused for lacking permission, which says nothing
     * about separation of duty. So the attempt is made by the maker *holding the checker
     * role and permissions*: the only thing left to refuse them is that they are the
     * requester. If this passes, self-approval is genuinely enforced rather than
     * incidentally blocked.
     */
    const makerAsChecker = {
      ...asActor(users.aMaker, ['workflow_maker', 'workflow_checker']),
    };

    const eventsBefore = (securitySink.events ?? []).length;
    try {
      await engine.transition(makerAsChecker, {
        instanceId: started.instance.id,
        action: 'approve',
      });
      out.selfApproval = { refused: false, reason: 'the engine allowed it' };
    } catch (error) {
      out.selfApproval = {
        refused: true,
        reason: error.message,
        // The machine-readable code. Prose is for the person reading the screen; this
        // is what a validation may assert on, because it does not change when somebody
        // improves the wording.
        reasonCode: error.context?.reason ?? null,
      };
    }
    // Only the events this attempt produced, so the reason can be attributed to it.
    out.selfApprovalEvents = (securitySink.events ?? []).slice(eventsBefore);

    /*
     * A viewer holds no workflow role and no decide permission. Refusing them is the
     * negative half of the RBAC matrix — an authorization check that only ever sees
     * authorized callers has not been tested.
     */
    const viewer = {
      ...asActor(users.aViewer, ['viewer']),
      permissions: ['workflow.instance.read'],
    };
    const beforeViewer = (securitySink.events ?? []).length;
    try {
      await engine.transition(viewer, { instanceId: started.instance.id, action: 'approve' });
      out.viewerApproval = { refused: false, reason: 'the engine allowed it' };
    } catch (error) {
      out.viewerApproval = {
        refused: true,
        reason: error.message,
        reasonCode: error.context?.reason ?? null,
      };
    }
    out.viewerApprovalEvents = (securitySink.events ?? []).slice(beforeViewer);

    /*
     * A checker in another organization, holding every role and permission its own
     * tenant would grant. The only thing left to refuse them is the tenant boundary.
     */
    const foreignChecker = {
      ...asActor(users.bMaker, ['workflow_checker']),
      organizationId: orgB.id,
    };
    try {
      await engine.transition(foreignChecker, {
        instanceId: started.instance.id,
        action: 'approve',
      });
      out.crossTenantApproval = { refused: false, reason: 'the engine allowed it' };
    } catch (error) {
      out.crossTenantApproval = {
        refused: true,
        reason: error.message,
        reasonCode: error.context?.reason ?? null,
      };
    }

    const approved = await engine.transition(checker, {
      instanceId: started.instance.id,
      action: 'approve',
    });
    out.approved = approved.instance;

    /*
     * Restart: a second runtime context over the same database.
     *
     * New stores, new engine, nothing shared with the one above. This is what proves the
     * persisted instance still means something after a process dies — that its
     * definition and version resolve, and that it can still be transitioned rather than
     * being an orphaned row referencing a definition that lived in memory.
     */
    const restarted = {
      definitions: new runtime.PrismaDefinitionStore(prisma.workflowDefinition),
      instances: new runtime.PrismaInstanceStore(prisma.workflowInstance),
    };
    restarted.versions = new runtime.PrismaVersionStore(
      prisma.workflowVersion,
      prisma.workflowInstance,
      prisma.workflowDefinition,
    );

    const reloaded = await restarted.instances.findById(started.instance.id, orgA.id);
    const resolvedVersion = reloaded
      ? await restarted.versions.findById(reloaded.workflowVersionId)
      : null;

    out.restart = {
      instanceFound: reloaded !== null,
      state: reloaded?.currentState ?? null,
      versionResolved: resolvedVersion !== null,
      definitionKey: resolvedVersion?.definition?.id ?? null,
      versionNumber: resolvedVersion?.version ?? null,
      // The instance must point at the version it started on, not merely at whatever is
      // published now — otherwise a republished definition silently changes the rules
      // under a request that is already in flight.
      pinnedToVersion: reloaded?.workflowVersionId === resolvedVersion?.id,
    };

    // The trail this scenario actually produced, for enumeration rather than assertion
    // that "audit exists".
    out.auditRecords = auditSink.records ?? auditSink.entries ?? [];
    out.securityEvents = securitySink.events ?? [];
  } catch (error) {
    out.error = error.message;
  }

  return out;
}

let seeded;
try {
  seeded = await main();
} finally {
  // Test data is removed whatever happened, so a failed run does not leave two
  // organizations behind in a shared environment.
  if (seeded) {
    await prisma.user.deleteMany({
      where: { email: { contains: `-${suffix}@validation.trustos` } },
    });
    await prisma.organization.deleteMany({ where: { slug: { in: [ids.orgA, ids.orgB] } } });
  }
  await prisma.$disconnect();
}

const failed = results.filter((r) => r.status === 'FAIL');
const summary = {
  generatedAt: new Date().toISOString(),
  correlationId,
  environment: process.env.TRUSTOS_ENVIRONMENT ?? 'unknown',
  results,
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
};

if (wantJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Foundation validation — correlation ${correlationId}\n`);
  const width = Math.max(...results.map((r) => r.check.length));
  for (const result of results) {
    console.log(`  ${result.status.padEnd(5)} ${result.check.padEnd(width)}  ${result.detail}`);
  }
  console.log(`\n  ${summary.totals.passed}/${summary.totals.checks} checks passed`);
  console.log(`\nVerdict: ${summary.verdict}`);
}

if (process.argv.includes('--write')) {
  mkdirSync(join(root, 'docs/validation'), { recursive: true });
  writeFileSync(
    join(root, 'docs/validation/foundation-latest.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

process.exit(summary.verdict === 'PASS' ? 0 : 1);

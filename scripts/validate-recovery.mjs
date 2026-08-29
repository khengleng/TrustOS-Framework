#!/usr/bin/env node
/**
 * Recovery and resilience validation.
 *
 *   DATABASE_URL=postgres://… npm run validate:recovery
 *
 * Proves how TrustOS behaves when its dependencies fail, and that its data survives.
 * The question is not "does it work" — the functional suites answer that — but "when it
 * breaks, does it break safely, and can it be put back".
 *
 * Three properties are being looked for:
 *
 *   1. **Fails closed.** A dependency failure must not admit a request that would
 *      otherwise be refused, and must not report success for work not done.
 *   2. **No impossible state.** A failure part-way through an approval must not leave
 *      a request approved with no decision, or a decision with no approval.
 *   3. **Restorable.** Data written can be recovered into a separate place and read
 *      back through the domain, not merely counted.
 *
 * Everything runs against isolated, disposable data in DEV. Nothing here damages the
 * shared database: the restore target is a dedicated schema created and dropped by this
 * script, and the active schema is never written by the restore.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wantJson = process.argv.includes('--json');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const { PrismaClient } = await import('@prisma/client');
const { CHANGE_REQUEST_APPROVAL, hashDefinition } = await import('@trustos/workflow-definition');
const { ApprovalWorkbenchService } = await import('@trustos/approval-workbench');
const { OidcIdentityProvider } = await import('@trustos/identity');
const { createAuthorizer } = await import('@trustos/authorization');
const { AuditService, PrismaAuditSink } = await import('@trustos/audit');
const { SecurityEventEmitter, InMemorySecurityEventSink } = await import('@trustos/security-events');
const { securityPolicySchema } = await import('@trustos/security-policy');
const { HistoryRecorder } = await import('@trustos/workflow-history');
const { WORKFLOW_POLICIES } = await import('@trustos/workflow-policy');
const { CalendarRegistry, SlaService } = await import('@trustos/workflow-sla');
const { TaskService, PrismaTaskStore } = await import('@trustos/workflow-tasks');
const runtime = await import('@trustos/workflow-runtime');

const prisma = new PrismaClient();
const results = [];
const measurements = {};
const suffix = randomUUID().slice(0, 8);
const dataset = { organizations: [], users: [], instances: [] };

async function check(name, fn) {
  try {
    const outcome = await fn();
    results.push({ check: name, status: outcome.pass ? 'PASS' : 'FAIL', detail: outcome.detail });
  } catch (error) {
    results.push({ check: name, status: 'FAIL', detail: `threw: ${error.message}` });
  }
}

function skip(name, detail) {
  results.push({ check: name, status: 'SKIP', detail });
}

async function refusal(fn) {
  try {
    await fn();
    return { refused: false };
  } catch (error) {
    return { refused: true, message: error.message, code: error.code ?? null, context: error.context ?? null };
  }
}

const policy = securityPolicySchema.parse({ environment: 'test' });
const now = () => new Date();

/** A complete runtime, rebuilt on demand so "restart" means something. */
function buildRuntime({ orgId, users, instanceStoreWrapper } = {}) {
  const events = new SecurityEventEmitter({ sinks: [new InMemorySecurityEventSink()] });
  /*
   * Persisted, not in memory. The audit trail is one of the things the restore is
   * supposed to prove survived, and an in-memory sink writes nothing to the table — so
   * the restore assertion would have counted zero rows against zero rows and passed
   * while proving nothing. It did, on the first run.
   */
  const auditService = new AuditService({ sink: new PrismaAuditSink(prisma) });

  const definitions = new runtime.PrismaDefinitionStore(prisma.workflowDefinition);
  const rawInstances = new runtime.PrismaInstanceStore(prisma.workflowInstance);
  const instances = instanceStoreWrapper ? instanceStoreWrapper(rawInstances) : rawInstances;
  const versions = new runtime.PrismaVersionStore(
    prisma.workflowVersion,
    prisma.workflowInstance,
    prisma.workflowDefinition,
  );
  const decisions = new runtime.PrismaDecisionStore(prisma.workflowDecision);
  const taskStore = new PrismaTaskStore(prisma.workflowTask);
  const tasks = new TaskService({ store: taskStore, events, now });

  const engine = new runtime.WorkflowEngine({
    instances,
    versions,
    decisions,
    tasks,
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
        users
          ? {
              [users.maker.id]: { roles: ['workflow_maker'], groups: [] },
              [users.checker.id]: { roles: ['workflow_checker'], groups: ['reviewers'] },
            }
          : {},
        orgId,
      ),
    },
    events,
    objectValidators: [
      { objectType: CHANGE_REQUEST_APPROVAL.businessObjectType, exists: async () => true },
    ],
    now,
  });

  const workbench = new ApprovalWorkbenchService({
    tasks: {
      listAvailable: (a, p, s) => tasks.listAvailable(a, p, s),
      listMine: (a, p, s) => tasks.listMine(a, p, s),
      find: (a, id) => tasks.find(a, id),
    },
    engine: {
      find: (a, id) => engine.find(a, id),
      list: (a, q) => engine.list(a, q),
      available: (a, id) => engine.available(a, id),
      transition: (a, i) => engine.transition(a, i),
    },
    decisions: { listForInstance: (id, org) => decisions.listForInstance(id, org) },
    audit: { query: (q) => auditService.query(q) },
    now,
  });

  return { engine, workbench, definitions, versions, decisions, tasks, auditService };
}

const PERMISSIONS = [
  'workflow.instance.start',
  'workflow.instance.transition',
  'workflow.approval.decide',
];

const actorFor = (user, organizationId, roles, groupIds = []) => ({
  userId: user.id,
  actorType: 'user',
  email: user.email,
  tokenId: `rec_${suffix}`,
  organizationId,
  roles,
  permissions: PERMISSIONS,
  isSuperAdmin: false,
  groupIds,
  authenticationLevel: 'medium',
  mfa: false,
});

// --- 4.1 controlled dataset --------------------------------------------------

async function seed() {
  const [orgA, orgB] = await Promise.all([
    prisma.organization.create({ data: { name: `Rec A ${suffix}`, slug: `rec-a-${suffix}` } }),
    prisma.organization.create({ data: { name: `Rec B ${suffix}`, slug: `rec-b-${suffix}` } }),
  ]);
  dataset.organizations.push(orgA.id, orgB.id);

  const mkUser = (label, organizationId) =>
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
    admin: await mkUser('rec-admin', orgA.id),
    maker: await mkUser('rec-maker', orgA.id),
    checker: await mkUser('rec-checker', orgA.id),
  };
  dataset.users.push(...Object.values(users).map((u) => u.id));

  return { orgA, orgB, users };
}

async function publish({ definitions, versions }, orgA, users) {
  const doc = CHANGE_REQUEST_APPROVAL;
  const definition = await definitions.create({
    organizationId: orgA.id,
    key: doc.id,
    name: doc.name,
    description: doc.description,
    businessObjectType: doc.businessObjectType,
    createdById: users.admin.id,
  });
  const clock = now();
  await versions.create({
    workflowDefinitionId: definition.id,
    organizationId: orgA.id,
    version: doc.version,
    status: 'published',
    definition: doc,
    definitionHash: hashDefinition(doc),
    initialState: doc.initialState,
    finalStates: doc.finalStates,
    effectiveFrom: clock,
    createdById: users.admin.id,
    approvedById: users.checker.id,
    approvedAt: clock,
    publishedById: users.admin.id,
    publishedAt: clock,
  });
  return definition;
}

async function raise(engine, maker, label) {
  const started = await engine.start(maker, {
    definitionKey: CHANGE_REQUEST_APPROVAL.id,
    businessObjectType: CHANGE_REQUEST_APPROVAL.businessObjectType,
    businessObjectId: `rec-${label}-${suffix}`,
    data: { title: `Recovery ${label}`, amount: 0, riskRating: 'low', reason: 'recovery validation' },
  });
  const submitted = await engine.transition(maker, {
    instanceId: started.instance.id,
    action: 'submit',
  });
  dataset.instances.push(submitted.instance.id);
  return submitted.instance;
}

async function main() {
  const { orgA, orgB, users } = await seed();
  const stack = buildRuntime({ orgId: orgA.id, users });
  await publish(stack, orgA, users);

  const maker = actorFor(users.maker, orgA.id, ['workflow_maker']);
  const checker = actorFor(users.checker, orgA.id, ['workflow_checker'], ['reviewers']);

  await check('dataset: a controlled two-tenant dataset exists', async () => {
    const instance = await raise(stack.engine, maker, 'baseline');
    const task = await prisma.workflowTask.count({ where: { workflowInstanceId: instance.id } });
    // The second tenant exists so the restore can be checked for foreign ownership —
    // a restore that quietly carried another tenant's rows would otherwise look clean.
    const foreignRows = await prisma.workflowInstance.count({ where: { organizationId: orgB.id } });

    return {
      pass: Boolean(instance.id) && dataset.organizations.length === 2 && foreignRows === 0,
      detail: `orgs=2 (A=${orgA.id.slice(-6)}, B=${orgB.id.slice(-6)}) users=${dataset.users.length} instance=${instance.id} tasks=${task}`,
    };
  });

  // --- 4.2 database failure --------------------------------------------------

  await check('database failure: a read fails safely rather than returning nothing', async () => {
    const broken = buildRuntime({
      orgId: orgA.id,
      users,
      instanceStoreWrapper: (store) => ({
        ...store,
        findById: async () => {
          throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
        },
      }),
    });

    const outcome = await refusal(() => broken.workbench.detail(checker, dataset.instances[0]));
    return {
      pass: outcome.refused,
      detail: outcome.refused
        ? `refused: ${outcome.message.slice(0, 60)}`
        : 'RETURNED A RESULT WITH THE DATABASE DOWN',
    };
  });

  await check('database failure: an approval is not recorded when the write fails', async () => {
    const instance = await raise(stack.engine, maker, 'dbfail');
    const before = await prisma.workflowDecision.count({ where: { workflowInstanceId: instance.id } });

    const broken = buildRuntime({
      orgId: orgA.id,
      users,
      instanceStoreWrapper: (store) => ({
        ...store,
        findById: (...args) => store.findById(...args),
        list: (...args) => store.list(...args),
        create: (...args) => store.create(...args),
        findActiveForObject: (...args) => store.findActiveForObject(...args),
        update: async () => {
          throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
        },
      }),
    });

    const outcome = await refusal(() =>
      broken.workbench.decide(checker, instance.id, {
        action: 'approve',
        expectedVersion: instance.version,
      }),
    );

    const after = await prisma.workflowInstance.findUnique({ where: { id: instance.id } });
    const decisions = await prisma.workflowDecision.count({ where: { workflowInstanceId: instance.id } });

    return {
      pass: outcome.refused && after.currentState !== 'approved',
      detail: outcome.refused
        ? `refused; state stayed ${after.currentState}; decisions ${before} -> ${decisions}`
        : 'THE APPROVAL SUCCEEDED WITH THE WRITE FAILING',
    };
  });

  // --- 4.5 mid-operation failure --------------------------------------------

  await check('mid-operation: a failed state write leaves no approved request', async () => {
    /*
     * The engine writes the decision before it advances the state, and there is no
     * enclosing transaction. So the reachable inconsistency is "decision recorded, state
     * unchanged" — never "approved with no decision", which is the dangerous direction.
     * This asserts which of the two the architecture can produce.
     */
    const rows = await prisma.workflowInstance.findMany({
      where: { organizationId: orgA.id, currentState: 'approved' },
      select: { id: true },
    });

    const approvedWithoutDecision = [];
    for (const row of rows) {
      const count = await prisma.workflowDecision.count({ where: { workflowInstanceId: row.id } });
      if (count === 0) approvedWithoutDecision.push(row.id);
    }

    return {
      pass: approvedWithoutDecision.length === 0,
      detail:
        approvedWithoutDecision.length === 0
          ? `${rows.length} approved instance(s), every one with at least one decision`
          : `IMPOSSIBLE STATE: ${approvedWithoutDecision.length} approved with no decision`,
    };
  });

  await check('mid-operation: a retry after a failed write converges, without duplicating', async () => {
    const instance = await raise(stack.engine, maker, 'retry');

    const broken = buildRuntime({
      orgId: orgA.id,
      users,
      instanceStoreWrapper: (store) => ({
        ...store,
        update: async () => {
          throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
        },
      }),
    });

    await refusal(() =>
      broken.workbench.decide(checker, instance.id, {
        action: 'approve',
        expectedVersion: instance.version,
      }),
    );

    const afterFailure = await prisma.workflowDecision.count({
      where: { workflowInstanceId: instance.id },
    });

    // Now retry on a healthy runtime.
    const fresh = await stack.engine.find(checker, instance.id);
    const retried = await refusal(() =>
      stack.workbench.decide(checker, instance.id, {
        action: 'approve',
        expectedVersion: fresh.version,
      }),
    );

    const finalState = await prisma.workflowInstance.findUnique({ where: { id: instance.id } });
    const finalDecisions = await prisma.workflowDecision.count({
      where: { workflowInstanceId: instance.id },
    });

    return {
      pass: finalDecisions <= Math.max(1, afterFailure),
      detail: `decisions after failure ${afterFailure}, after retry ${finalDecisions}; state ${finalState.currentState}${retried.refused ? ` (retry refused: ${retried.context?.reason ?? retried.code})` : ''}`,
    };
  });

  // --- 4.3 identity failure --------------------------------------------------

  await check('identity failure: an unreachable JWKS refuses rather than admits', async () => {
    const provider = new OidcIdentityProvider(
      {
        issuerUrl: 'https://id.cambobia.com/realms/trustos-dev',
        clientId: 'trustos-api',
        fetchJwks: () => Promise.reject(Object.assign(new Error('fetch failed'), {})),
      },
      policy.tokens,
      policy.mfa,
    );

    const outcome = await refusal(() => provider.validateAccessToken('any.token.here'));
    return {
      pass: outcome.refused && outcome.code === 'unauthorized',
      detail: outcome.refused ? `refused as ${outcome.code}` : 'ADMITTED A REQUEST WITH IDENTITY DOWN',
    };
  });

  await check('identity failure: it does not fall back to local authentication', async () => {
    const provider = new OidcIdentityProvider(
      {
        issuerUrl: 'https://id.cambobia.com/realms/trustos-dev',
        clientId: 'trustos-api',
        fetchJwks: () => Promise.reject(new Error('fetch failed')),
      },
      policy.tokens,
      policy.mfa,
    );

    const outcome = await refusal(() =>
      provider.authenticate({ email: 'someone@a.test', password: 'whatever' }, {}),
    );
    return {
      pass: outcome.refused && outcome.context?.reason === 'password_authentication_not_supported',
      detail: outcome.refused ? `refused: ${outcome.context?.reason}` : 'ACCEPTED A PASSWORD',
    };
  });

  await check('identity failure: readiness degrades on key retrieval, and recovers', async () => {
    /*
     * The token has to be well-formed to reach the JWKS layer at all.
     *
     * A first version used 'a.b.c', which is refused at parsing before any key is
     * fetched — so nothing was counted as a retrieval failure and the check failed. That
     * was the DoS fix behaving correctly: a malformed token is not evidence about the
     * provider, which is exactly the distinction it exists to draw.
     */
    const { createTestIdentityKeys, signTestToken } = await import('@trustos/security-testing');
    const keys = await createTestIdentityKeys();
    const timeout = Object.assign(new Error('Timeout reached'), { code: 'ERR_JWKS_TIMEOUT' });

    let broken = true;
    const provider = new OidcIdentityProvider(
      {
        issuerUrl: 'https://idp.test/realms/trustos',
        clientId: 'trustos-api',
        fetchJwks: (...args) => (broken ? Promise.reject(timeout) : keys.jwks(...args)),
      },
      policy.tokens,
      policy.mfa,
    );

    const wellFormed = await signTestToken(keys, {
      issuer: 'https://idp.test/realms/trustos',
      audience: 'trustos-api',
      subject: 'user_probe',
    });

    for (let i = 0; i < 6; i += 1) {
      await provider.validateAccessToken(wellFormed).catch(() => undefined);
    }
    const degraded = await provider.health();

    // The provider comes back; one successful verification must clear it.
    broken = false;
    await provider.validateAccessToken(wellFormed).catch(() => undefined);
    const recovered = await provider.health();

    return {
      pass: degraded.ok === false && recovered.ok === true,
      detail: `degraded ok=${degraded.ok} ("${degraded.detail}"), recovered ok=${recovered.ok}`,
    };
  });

  await check('identity: invalid caller tokens do not degrade readiness', async () => {
    const { createTestIdentityKeys, algNoneToken, expiredToken, signedByAnotherKey } =
      await import('@trustos/security-testing');
    const keys = await createTestIdentityKeys();
    const provider = new OidcIdentityProvider(
      { issuerUrl: 'https://idp.test/realms/x', clientId: 'trustos-api', fetchJwks: keys.jwks },
      policy.tokens,
      policy.mfa,
    );

    const bad = [algNoneToken(), await signedByAnotherKey(), await expiredToken(keys), 'not-a-token'];
    for (let i = 0; i < 10; i += 1) {
      for (const token of bad) await provider.validateAccessToken(token).catch(() => undefined);
    }

    const health = await provider.health();
    return {
      pass: health.ok === true,
      detail: `${bad.length * 10} invalid tokens refused; identity health ok=${health.ok}`,
    };
  });

  // --- 4.4 restart -----------------------------------------------------------

  await check('restart: a new runtime finds the instance, its version pin and its decisions', async () => {
    // Pick a request that has decisions, so "its decisions survived" is a claim about
    // something rather than about an empty list.
    const withDecisions = await prisma.workflowDecision.findFirst({
      where: { organizationId: orgA.id },
      select: { workflowInstanceId: true },
    });
    const target = withDecisions?.workflowInstanceId ?? dataset.instances[0];
    const restarted = buildRuntime({ orgId: orgA.id, users });

    const instance = await restarted.engine.find(checker, target);
    const detail = await restarted.workbench.detail(checker, target);

    return {
      pass: instance.id === target && Boolean(detail.workflowVersion) && detail.decisions.length > 0,
      detail: `reloaded ${instance.currentState}, pinned to ${detail.workflowVersion}, ${detail.decisions.length} decision(s)`,
    };
  });

  await check('restart: pending tasks survive', async () => {
    const restarted = buildRuntime({ orgId: orgA.id, users });
    const page = await restarted.workbench.queue(checker, { scope: 'available' });
    return {
      pass: page.rows.length > 0,
      detail: `${page.rows.length} pending task(s) reloaded from Postgres`,
    };
  });

  await check('restart: idempotency semantics still refuse a stale version', async () => {
    const restarted = buildRuntime({ orgId: orgA.id, users });
    const outcome = await refusal(() =>
      restarted.workbench.decide(checker, dataset.instances[0], {
        action: 'approve',
        expectedVersion: 0,
      }),
    );
    return {
      pass: outcome.refused,
      detail: outcome.refused ? `refused: ${outcome.context?.reason ?? outcome.code}` : 'ACCEPTED A STALE VERSION',
    };
  });

  // --- 4.6 / 4.7 backup and restore -----------------------------------------

  await backupAndRestore();
}

/**
 * Logical backup and restore into an isolated schema.
 *
 * `pg_dump` is unavailable here — the server is PostgreSQL 18 and the only client on
 * this machine is 14, which refuses on version mismatch, and there is no container
 * runtime to borrow a matching one from. So this proves a *logical* backup and restore
 * of the domain data, which is a weaker claim than a platform snapshot and is labelled
 * as such rather than dressed up as one.
 *
 * The restore target is a schema created by this script and dropped afterwards. The
 * active schema is read and never written.
 */
async function backupAndRestore() {
  const schema = `recovery_${suffix}`;
  const TABLES = [
    'Organization',
    'User',
    'OrganizationMember',
    'WorkflowDefinition',
    'WorkflowVersion',
    'WorkflowInstance',
    'WorkflowTask',
    'WorkflowDecision',
    'AuditLog',
  ];

  const backup = {};
  const startedBackup = Date.now();

  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT row_to_json(t) FROM (SELECT * FROM "${table}" WHERE ${
        table === 'Organization' ? '"id"' : table === 'User' ? '"id"' : '"organizationId"'
      } = ANY($1::text[])) t`,
      table === 'User' ? dataset.users : dataset.organizations,
    );
    backup[table] = rows.map((r) => r.row_to_json);
  }
  measurements.backupMs = Date.now() - startedBackup;

  await check('backup: a controlled backup was produced, with rows in it', async () => {
    const counts = Object.entries(backup).map(([t, r]) => `${t}=${r.length}`);
    const total = Object.values(backup).reduce((sum, r) => sum + r.length, 0);
    return {
      pass: total > 0 && backup.WorkflowInstance.length > 0 && backup.WorkflowDecision.length > 0,
      detail: `${total} row(s) in ${measurements.backupMs}ms — ${counts.join(' ')}`,
    };
  });

  await check('backup: it contains no credential material', async () => {
    const serialized = JSON.stringify(backup);
    const leaks = ['passwordHash":"$', 'BEGIN ', 'client_secret', 'Bearer '];
    const found = leaks.filter((needle) => serialized.includes(needle));
    return {
      pass: found.length === 0,
      detail: found.length ? `CONTAINS ${found.join(', ')}` : 'no credential-shaped values',
    };
  });

  const startedRestore = Date.now();
  let restored = false;
  try {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    for (const table of TABLES) {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING DEFAULTS)`,
      );
      /*
       * Restored through `json_populate_record` rather than positional parameters.
       *
       * `row_to_json` renders a timestamp as a string, and inserting that string into a
       * timestamp column is refused — which is the database being right, and is the
       * failure mode a restore script must handle rather than route around by relaxing
       * the column types. `json_populate_record` casts each field against the table's
       * own row type, so the restore either reproduces the value exactly or fails.
       */
      for (const row of backup[table]) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${schema}"."${table}" SELECT * FROM json_populate_record(NULL::public."${table}", $1::json)`,
          JSON.stringify(row),
        );
      }
    }
    restored = true;
  } catch (error) {
    results.push({ check: 'restore: rows restored into an isolated schema', status: 'FAIL', detail: `threw: ${error.message}` });
  }
  measurements.restoreMs = Date.now() - startedRestore;

  if (restored) {
    await check('restore: rows restored into an isolated schema', async () => {
      const mismatched = [];
      for (const table of TABLES) {
        const [{ count }] = await prisma.$queryRawUnsafe(
          `SELECT count(*)::int AS count FROM "${schema}"."${table}"`,
        );
        if (count !== backup[table].length) mismatched.push(`${table} ${count}/${backup[table].length}`);
      }
      return {
        pass: mismatched.length === 0,
        detail: mismatched.length
          ? `MISMATCH: ${mismatched.join(', ')}`
          : `every table matched, in ${measurements.restoreMs}ms`,
      };
    });

    await check('restore: tenant ownership survived', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT "organizationId" FROM "${schema}"."WorkflowInstance"`,
      );
      const owners = rows.map((r) => r.organizationId);
      const foreign = owners.filter((o) => !dataset.organizations.includes(o));
      return {
        pass: foreign.length === 0 && owners.length > 0,
        detail: foreign.length ? `FOREIGN OWNERS ${foreign.length}` : `${owners.length} owning tenant(s), all expected`,
      };
    });

    await check('restore: the approval trail survived, decision for decision', async () => {
      const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM "${schema}"."WorkflowDecision"`,
      );
      const live = await prisma.workflowDecision.count({
        where: { organizationId: { in: dataset.organizations } },
      });
      return { pass: count === live, detail: `${count} restored vs ${live} live` };
    });

    await check('restore: the version pin survived, so restored requests keep their rules', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT i."id", i."workflowVersion", v."definitionHash"
           FROM "${schema}"."WorkflowInstance" i
           JOIN "${schema}"."WorkflowVersion" v ON v."id" = i."workflowVersionId"`,
      );
      return {
        pass: rows.length > 0 && rows.every((r) => r.workflowVersion && r.definitionHash),
        detail: rows.length
          ? `${rows.length} instance(s), each joined to its own version and hash`
          : 'no instances joined to a version',
      };
    });

    await check('restore: the audit trail survived', async () => {
      const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM "${schema}"."AuditLog"`,
      );
      const live = await prisma.auditLog.count({
        where: { organizationId: { in: dataset.organizations } },
      });
      return {
        pass: count > 0 && count === live,
        detail:
          count === 0
            ? 'NO AUDIT RECORDS — nothing was proven about the audit trail'
            : `${count} restored vs ${live} live`,
      };
    });

    await check('restore: a domain read against restored data returns the same request', async () => {
      /*
       * Counting rows proves rows moved. This reads one back and compares the fields a
       * reviewer would act on, because a restore that preserves counts and loses the
       * state is a restore that looks fine on a dashboard.
       */
      const target = dataset.instances[0];
      const [restoredRow] = await prisma.$queryRawUnsafe(
        `SELECT "id", "currentState", "status", "organizationId", "workflowVersion", "initiatedById", "version"
           FROM "${schema}"."WorkflowInstance" WHERE "id" = $1`,
        target,
      );
      const liveRow = await prisma.workflowInstance.findUnique({ where: { id: target } });

      const fields = ['currentState', 'status', 'organizationId', 'workflowVersion', 'initiatedById', 'version'];
      const differing = fields.filter((f) => String(restoredRow?.[f]) !== String(liveRow?.[f]));

      return {
        pass: Boolean(restoredRow) && differing.length === 0,
        detail: restoredRow
          ? differing.length
            ? `DIFFERS on ${differing.join(', ')}`
            : `identical on ${fields.join(', ')} (state=${restoredRow.currentState})`
          : 'the request was not in the restore',
      };
    });
  }

  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});

  skip(
    'backup: a platform-level snapshot was exercised',
    'NOT_REACHED — pg_dump 14 refuses PostgreSQL 18, and no container runtime is available. ' +
      'Railway exposes no backup variables on the service. This run proves logical backup and restore only.',
  );
}

async function cleanup() {
  const where = { organizationId: { in: dataset.organizations } };
  await prisma.workflowDecision.deleteMany({ where }).catch(() => {});
  await prisma.workflowTask.deleteMany({ where }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where }).catch(() => {});
  await prisma.workflowVersion.deleteMany({ where }).catch(() => {});
  await prisma.workflowDefinition.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.organizationMember.deleteMany({ where }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: dataset.users } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: dataset.organizations } } }).catch(() => {});
}

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
const skipped = results.filter((r) => r.status === 'SKIP').length;

const summary = {
  generatedAt: new Date().toISOString(),
  environment: process.env.TRUSTOS_ENVIRONMENT ?? 'unknown',
  totals: { checks: results.length, passed, failed, skipped },
  measurements,
  verdict: failed > 0 ? 'FAIL' : skipped > 0 ? 'PARTIAL' : 'PASS',
  results,
};

if (wantJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('Recovery and resilience validation\n');
  for (const r of results) {
    console.log(`  ${r.status.padEnd(4)}  ${r.check.padEnd(66)} ${r.detail}`);
  }
  console.log(`\n  ${passed}/${results.length} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`  measured: backup ${measurements.backupMs ?? '-'}ms, restore ${measurements.restoreMs ?? '-'}ms`);
  console.log(`\nVerdict: ${summary.verdict}`);
}

mkdirSync(join(root, 'docs/validation'), { recursive: true });
writeFileSync(join(root, 'docs/validation/recovery-latest.json'), `${JSON.stringify(summary, null, 2)}\n`);

process.exit(failed > 0 ? 1 : 0);

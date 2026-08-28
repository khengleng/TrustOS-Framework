import { describe, expect, it } from 'vitest';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustos/security-events';
import {
  WORKFLOW_PERMISSIONS,
  type WorkflowActor,
  type WorkflowTaskRecord,
} from '@trustos/workflow-core';
import {
  InMemoryRoundRobinCursor,
  isEligibleForTask,
  resolveAssignment,
  TaskService,
  type AssignmentContext,
  type MemberDirectory,
  type TaskStore,
} from './index';

/**
 * Task tests.
 *
 * The heart of the file is the claim race. JavaScript is single-threaded, so two awaited
 * claims never truly interleave — a test that just called `claim` twice would prove
 * nothing about concurrency, because the first would fully complete before the second
 * started.
 *
 * `onBeforeClaimWrite` is the hook that makes the race real: it fires between the store
 * reading the row and evaluating the version condition, which is exactly the window a
 * check-then-act implementation leaves open. A competing claim inside that hook is what
 * two simultaneous requests actually look like.
 */

const ACME = 'org_acme';
const OTHER = 'org_globex';
const ALL = Object.values(WORKFLOW_PERMISSIONS).map((permission) => permission.key);

function actor(overrides: Partial<WorkflowActor> = {}): WorkflowActor {
  return {
    userId: 'user_a',
    actorType: 'user',
    email: 'a@acme.test',
    tokenId: 'tok',
    organizationId: ACME,
    roles: ['workflow_checker'],
    permissions: ALL,
    isSuperAdmin: false,
    groupIds: ['reviewers'],
    authenticationLevel: 'medium',
    mfa: false,
    ...overrides,
  };
}

// A local in-memory store, with the race hook. Kept here rather than imported from
// @trustos/workflow-runtime so this package's tests do not depend on the runtime.
class TestTaskStore implements TaskStore {
  readonly records = new Map<string, WorkflowTaskRecord>();
  onBeforeClaimWrite?: () => void | Promise<void>;
  private counter = 0;

  async findById(id: string, organizationId: string) {
    const record = this.records.get(id);
    return record && record.organizationId === organizationId ? { ...record } : null;
  }

  async list(query: Parameters<TaskStore['list']>[0]) {
    const all = [...this.records.values()]
      .filter((record) => record.organizationId === query.organizationId)
      .filter((record) => !query.status || query.status.includes(record.status))
      .filter((record) => {
        if (query.assigneeUserId) {
          return (
            record.assigneeUserId === query.assigneeUserId ||
            record.claimedById === query.assigneeUserId
          );
        }
        if (query.eligibleFor) {
          const { roles, groupIds, userId } = query.eligibleFor;
          if (record.assigneeUserId === userId) return true;
          if (record.claimedById) return false;
          if (record.assigneeRole && roles.includes(record.assigneeRole)) return true;
          if (record.assigneeGroupId && groupIds.includes(record.assigneeGroupId)) return true;
          return false;
        }
        return true;
      })
      .filter((record) => {
        if (!query.dueBefore) return true;
        return record.dueAt !== null && record.dueAt.getTime() <= query.dueBefore.getTime();
      });

    return {
      items: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(input: Omit<WorkflowTaskRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>) {
    this.counter += 1;
    const now = new Date();
    const record: WorkflowTaskRecord = {
      ...input,
      id: `t${this.counter}`,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async claim(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    claimedById: string;
    claimedAt: Date;
  }) {
    await this.onBeforeClaimWrite?.();

    const record = this.records.get(input.id);
    if (!record) return null;
    if (record.organizationId !== input.organizationId) return null;
    if (record.version !== input.expectedVersion) return null;
    if (record.claimedById) return null;

    const updated: WorkflowTaskRecord = {
      ...record,
      claimedById: input.claimedById,
      claimedAt: input.claimedAt,
      status: 'claimed',
      version: record.version + 1,
    };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  onBeforeUpdate?: (id: string) => void | Promise<void>;

  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<WorkflowTaskRecord>;
  }) {
    await this.onBeforeUpdate?.(input.id);

    const record = this.records.get(input.id);
    if (!record) return null;
    if (record.organizationId !== input.organizationId) return null;
    if (record.version !== input.expectedVersion) return null;

    const updated = { ...record, ...input.patch, version: record.version + 1 };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async cancelForInstance(input: {
    workflowInstanceId: string;
    organizationId: string;
    at: Date;
    reason: string;
  }) {
    let count = 0;
    for (const [id, record] of this.records) {
      if (record.workflowInstanceId !== input.workflowInstanceId) continue;
      if (record.organizationId !== input.organizationId) continue;
      this.records.set(id, { ...record, status: 'cancelled', version: record.version + 1 });
      count += 1;
    }
    return count;
  }

  async listOverdue(input: { organizationId?: string; asOf: Date; limit: number }) {
    return [...this.records.values()]
      .filter((record) => !input.organizationId || record.organizationId === input.organizationId)
      .filter((record) => ['open', 'assigned', 'claimed'].includes(record.status))
      .filter((record) => record.dueAt !== null && record.dueAt <= input.asOf)
      .slice(0, input.limit);
  }

  async countOpenByAssignee() {
    return [];
  }
}

function build() {
  const store = new TestTaskStore();
  const sink = new InMemorySecurityEventSink();
  const service = new TaskService({
    store,
    events: new SecurityEventEmitter({ sinks: [sink], application: 'test' }),
  });
  return { store, service, sink };
}

async function pooledTask(store: TestTaskStore, overrides: Partial<WorkflowTaskRecord> = {}) {
  return store.create({
    organizationId: ACME,
    workflowInstanceId: 'wfi_1',
    stepKey: 'pending_approval',
    title: 'Approve',
    description: '',
    status: 'open',
    priority: 'normal',
    assigneeUserId: null,
    assigneeRole: 'workflow_checker',
    assigneeGroupId: null,
    dueAt: null,
    slaStatus: null,
    claimedById: null,
    claimedAt: null,
    completedById: null,
    completedAt: null,
    outcome: null,
    delegatedById: null,
    delegatedAt: null,
    ...overrides,
  });
}

// ===========================================================================
// Claiming
// ===========================================================================

describe('claiming a pooled task', () => {
  it('succeeds for an eligible user', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    const claimed = await service.claim(actor(), task.id);

    expect(claimed.claimedById).toBe('user_a');
    expect(claimed.status).toBe('claimed');
    // The version advanced, which is what makes a second claim against the old version
    // fail.
    expect(claimed.version).toBe(1);
  });

  it('refuses a user who does not hold the pooled role', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    await expect(
      service.claim(actor({ userId: 'user_b', roles: ['workflow_maker'] }), task.id),
    ).rejects.toMatchObject({ context: { reason: 'not_assignee' } });
  });

  it('refuses a task already claimed, and names the claimant', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);
    await service.claim(actor(), task.id);

    // An unattributed "already claimed" in a shared queue is the start of a conversation
    // on a group chat.
    await expect(service.claim(actor({ userId: 'user_b' }), task.id)).rejects.toMatchObject({
      context: { reason: 'already_claimed', claimedById: 'user_a' },
    });
  });

  it('lets exactly one of two simultaneous claimants win', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    /*
     * The real race.
     *
     * The hook fires inside `claim`, after the caller read the task and before the store
     * evaluates the version condition. `user_b` claims in that window, so `user_a`'s
     * write then finds a version that has moved — which is precisely what two
     * simultaneous HTTP requests produce.
     *
     * A check-then-act implementation would have both succeed and the second would
     * silently overwrite the first.
     */
    let fired = false;
    store.onBeforeClaimWrite = async () => {
      if (fired) return;
      fired = true;
      store.onBeforeClaimWrite = undefined;
      await service.claim(actor({ userId: 'user_b' }), task.id);
    };

    const outcome = await service
      .claim(actor({ userId: 'user_a' }), task.id)
      .then(() => 'won' as const)
      .catch((error: { context?: { reason?: string } }) => error.context?.reason ?? 'unknown');

    expect(outcome).toBe('already_claimed');

    // Exactly one claimant on the record, and it is the one who got there first.
    const final = store.records.get(task.id);
    expect(final?.claimedById).toBe('user_b');
    expect(final?.version).toBe(1);
  });

  it('lets exactly one of ten simultaneous claimants win', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    // Ten callers all read version 0, then all write. Nine must lose.
    const reads = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.findById(task.id, ACME).then((record) => ({ index, record })),
      ),
    );

    const outcomes = await Promise.all(
      reads.map(async ({ index }) => {
        try {
          await service.claim(actor({ userId: `user_${index}` }), task.id);
          return 'won';
        } catch {
          return 'lost';
        }
      }),
    );

    expect(outcomes.filter((outcome) => outcome === 'won')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'lost')).toHaveLength(9);
  });

  it('refuses a claim on a completed task', async () => {
    const { store, service } = build();
    const task = await pooledTask(store, { status: 'completed' });

    await expect(service.claim(actor(), task.id)).rejects.toMatchObject({
      context: { reason: 'already_completed' },
    });
  });

  it('refuses a claim from another organization', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    // Not found, not forbidden.
    await expect(service.claim(actor({ organizationId: OTHER }), task.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses a claim without the claim permission', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    await expect(
      service.claim(actor({ permissions: [WORKFLOW_PERMISSIONS.TASK_READ.key] }), task.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('releasing and reassigning', () => {
  it('lets the claimant release a task back to the pool', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);
    await service.claim(actor(), task.id);

    const released = await service.release(actor(), task.id, 'reassigning myself');

    expect(released.claimedById).toBe(null);
    expect(released.status).toBe('open');
  });

  it('lets somebody with reassign authority release another person’s claim', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);
    await service.claim(actor({ userId: 'user_a' }), task.id);

    // Without this, a task claimed by somebody who then goes on leave is stuck — nothing
    // expires a claim.
    const released = await service.release(
      actor({ userId: 'user_admin', roles: ['workflow_administrator'] }),
      task.id,
      'holder unavailable',
    );

    expect(released.claimedById).toBe(null);
  });

  it('refuses a release by somebody who is neither the claimant nor an administrator', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);
    await service.claim(actor({ userId: 'user_a' }), task.id);

    await expect(
      service.release(
        actor({
          userId: 'user_b',
          permissions: [WORKFLOW_PERMISSIONS.TASK_READ.key, WORKFLOW_PERMISSIONS.TASK_CLAIM.key],
        }),
        task.id,
        'because',
      ),
    ).rejects.toMatchObject({ context: { reason: 'not_assignee' } });
  });

  it('is idempotent when the task is already in the pool', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    const released = await service.release(actor(), task.id, 'noop');
    expect(released.claimedById).toBe(null);
  });

  it('clears the claim when reassigning, and records a security event', async () => {
    const { store, service, sink } = build();
    const task = await pooledTask(store);
    await service.claim(actor({ userId: 'user_a' }), task.id);

    const reassigned = await service.reassign(actor({ userId: 'user_admin' }), task.id, {
      toUserId: 'user_b',
      toRole: null,
      reason: 'load balancing',
    });

    expect(reassigned.assigneeUserId).toBe('user_b');
    // Leaving the claim would mean the new assignee cannot act because the old holder
    // still has it.
    expect(reassigned.claimedById).toBe(null);

    // Moving an approval task from one reviewer to another is how a decision gets
    // steered, so it belongs in a trail somebody reviews.
    expect(sink.byType('workflow.task_reassigned')).toHaveLength(1);
    expect(sink.byType('workflow.task_reassigned')[0]?.context).toMatchObject({
      toUserId: 'user_b',
      reason: 'load balancing',
    });
  });

  it('refuses a reassignment with no reason', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    await expect(
      service.reassign(actor(), task.id, { toUserId: 'user_b', toRole: null, reason: '  ' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('refuses a reassignment with no target', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);

    await expect(
      service.reassign(actor(), task.id, { toUserId: null, toRole: null, reason: 'because' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('delegation', () => {
  it('moves work but not authority', async () => {
    const { store, service, sink } = build();
    const task = await pooledTask(store);
    await service.claim(actor({ userId: 'user_a' }), task.id);

    // The delegate must be eligible in their own right; otherwise delegation would be a
    // way to grant an approval permission to somebody who does not hold it.
    await expect(
      service.delegate(actor({ userId: 'user_a' }), task.id, {
        toUserId: 'user_ineligible',
        reason: 'on leave',
        isEligible: async () => false,
      }),
    ).rejects.toMatchObject({ context: { reason: 'separation_of_duty' } });

    // And the refusal is recorded, because an attempt to route an approval to somebody
    // who cannot make it is worth noticing.
    expect(sink.byType('workflow.separation_of_duty_blocked')).toHaveLength(1);

    const delegated = await service.delegate(actor({ userId: 'user_a' }), task.id, {
      toUserId: 'user_b',
      reason: 'on leave',
      isEligible: async () => true,
    });

    expect(delegated.claimedById).toBe('user_b');
    // `delegatedById` records who handed it over, which is a different fact from an
    // administrator moving it.
    expect(delegated.delegatedById).toBe('user_a');
  });

  it('refuses delegation of a task the actor does not hold', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);
    await service.claim(actor({ userId: 'user_a' }), task.id);

    await expect(
      service.delegate(actor({ userId: 'user_b' }), task.id, {
        toUserId: 'user_c',
        reason: 'x',
        isEligible: async () => true,
      }),
    ).rejects.toMatchObject({ context: { reason: 'not_assignee' } });
  });

  it('refuses delegation to oneself', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);
    await service.claim(actor({ userId: 'user_a' }), task.id);

    await expect(
      service.delegate(actor({ userId: 'user_a' }), task.id, {
        toUserId: 'user_a',
        reason: 'x',
        isEligible: async () => true,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

// ===========================================================================
// Eligibility
// ===========================================================================

describe('eligibility', () => {
  const base = {
    assigneeUserId: null,
    assigneeRole: null,
    assigneeGroupId: null,
    claimedById: null,
  };

  it('narrows to the claimant once a task is claimed', () => {
    const task = { ...base, assigneeRole: 'workflow_checker', claimedById: 'user_a' };

    expect(isEligibleForTask(actor({ userId: 'user_a' }), task).eligible).toBe(true);
    // Otherwise every eligible user still sees it as theirs and two people work the same
    // item.
    expect(isEligibleForTask(actor({ userId: 'user_b' }), task).eligible).toBe(false);
  });

  it('honours a named assignee', () => {
    const task = { ...base, assigneeUserId: 'user_a' };
    expect(isEligibleForTask(actor({ userId: 'user_a' }), task).eligible).toBe(true);
    expect(isEligibleForTask(actor({ userId: 'user_b' }), task).eligible).toBe(false);
  });

  it('honours a pooled role and a pooled group', () => {
    expect(
      isEligibleForTask(actor({ roles: ['workflow_checker'] }), {
        ...base,
        assigneeRole: 'workflow_checker',
      }).eligible,
    ).toBe(true);

    expect(
      isEligibleForTask(actor({ groupIds: ['reviewers'] }), {
        ...base,
        assigneeGroupId: 'reviewers',
      }).eligible,
    ).toBe(true);

    expect(
      isEligibleForTask(actor({ groupIds: [] }), { ...base, assigneeGroupId: 'reviewers' })
        .eligible,
    ).toBe(false);
  });

  it('refuses a task with no assignment, for anybody', () => {
    // A task nobody was assigned means the definition failed to assign the step. Treating
    // it as open to all would turn an authoring bug into a permanent hole that nobody
    // notices, because from the outside everything appears to work.
    const verdict = isEligibleForTask(actor({ isSuperAdmin: true }), base);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('task_has_no_assignment');
  });
});

// ===========================================================================
// Assignment
// ===========================================================================

describe('assignment', () => {
  const directory: MemberDirectory = {
    // Deliberately unsorted input, returned sorted — round-robin needs a stable order to
    // be a rotation rather than a shuffle.
    listByRole: async (organizationId, role) =>
      organizationId === ACME && role === 'workflow_checker'
        ? ['user_c', 'user_a', 'user_b'].sort()
        : [],
    listByGroup: async () => [],
    // A closed membership list. An `isActiveMember` that accepted any id would make the
    // resolver re-check below pass for the wrong reason — an earlier version of this test
    // did exactly that and the assertion failed.
    isActiveMember: async (organizationId, userId) =>
      organizationId === ACME && ['user_a', 'user_b', 'user_c', 'user_maker'].includes(userId),
  };

  const context: AssignmentContext = { directory, cursor: new InMemoryRoundRobinCursor() };

  const input = {
    organizationId: ACME,
    initiatedById: 'user_maker',
    data: {},
    businessObjectType: 'Thing',
    businessObjectId: 't1',
    stepKey: 'review',
  };

  it('resolves a named user', async () => {
    const target = await resolveAssignment(
      { ...input, assignment: { strategy: 'named_user', userId: 'user_a' } },
      context,
    );
    expect(target).toMatchObject({ userId: 'user_a', strategy: 'named_user' });
  });

  it('substitutes the initiator placeholder', async () => {
    const target = await resolveAssignment(
      { ...input, assignment: { strategy: 'named_user', userId: '${initiator}' } },
      context,
    );
    // How a draft or rework step returns to its maker.
    expect(target.userId).toBe('user_maker');
    expect(target.rationale).toContain('initiator');
  });

  it('refuses to assign a named user who is not an active member', async () => {
    // A task assigned to somebody who left is a task nobody sees, and silence here would
    // make that the normal outcome of ordinary staff turnover.
    await expect(
      resolveAssignment(
        { ...input, assignment: { strategy: 'named_user', userId: 'user_gone' } },
        context,
      ),
    ).rejects.toMatchObject({ context: { reason: 'assignment_unresolvable' } });
  });

  it('pools a role without resolving it to an individual', async () => {
    const target = await resolveAssignment(
      { ...input, assignment: { strategy: 'role', role: 'workflow_checker' } },
      context,
    );
    // Resolving to one person at creation would make the task invisible when that person
    // is on leave.
    expect(target).toMatchObject({ userId: null, role: 'workflow_checker' });
  });

  it('rotates round-robin across the population in a stable order', async () => {
    const assignment = { strategy: 'round_robin' as const, role: 'workflow_checker' };
    const cursor = new InMemoryRoundRobinCursor();
    const rotating: AssignmentContext = { directory, cursor };

    const assigned: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const target = await resolveAssignment({ ...input, assignment }, rotating);
      assigned.push(target.userId as string);
    }

    // Three members, six assignments: each gets two, in the same order twice.
    expect(assigned).toEqual(['user_a', 'user_b', 'user_c', 'user_a', 'user_b', 'user_c']);
  });

  it('refuses round-robin when nobody holds the role', async () => {
    await expect(
      resolveAssignment(
        { ...input, assignment: { strategy: 'round_robin', role: 'nobody_has_this' } },
        context,
      ),
    ).rejects.toMatchObject({ context: { reason: 'assignment_unresolvable' } });
  });

  it('refuses round-robin with no cursor', async () => {
    await expect(
      resolveAssignment(
        { ...input, assignment: { strategy: 'round_robin', role: 'workflow_checker' } },
        { directory },
      ),
    ).rejects.toThrow(/RoundRobinCursor/);
  });

  it('refuses a declared-only strategy with no registered resolver', async () => {
    await expect(
      resolveAssignment({ ...input, assignment: { strategy: 'least_loaded' } }, context),
    ).rejects.toThrow(/needs a resolver registered/);
  });

  it('re-checks a resolver’s answer against the directory', async () => {
    // A resolver is application code and can be wrong. Assignment is the boundary where a
    // mistake becomes a cross-tenant task.
    await expect(
      resolveAssignment(
        { ...input, assignment: { strategy: 'external_resolver', resolverKey: 'custom' } },
        {
          ...context,
          resolvers: [
            {
              key: 'custom',
              resolve: async () => ({
                userId: 'user_from_another_org',
                role: null,
                groupId: null,
                strategy: 'external_resolver' as const,
                rationale: 'test',
              }),
            },
          ],
        },
      ),
    ).rejects.toThrow(/not an active member/);
  });
});

// ===========================================================================
// Expiry
// ===========================================================================

describe('expiring overdue tasks', () => {
  it('expires what is past due and skips what changed underneath', async () => {
    const { store, service } = build();

    const overdue = await pooledTask(store, { dueAt: new Date('2020-01-01T00:00:00.000Z') });
    await pooledTask(store, { dueAt: new Date('2099-01-01T00:00:00.000Z') });

    const result = await service.expireOverdue({ organizationId: ACME });

    expect(result.expired).toBe(1);
    expect(store.records.get(overdue.id)?.status).toBe('expired');
  });

  it('skips rather than retries a task somebody acted on in the same moment', async () => {
    const { store, service } = build();
    const task = await pooledTask(store, { dueAt: new Date('2020-01-01T00:00:00.000Z') });

    /*
     * The sweep lists the task, then somebody claims it, then the sweep writes.
     *
     * The hook is what puts the claim in that window. Without it the sweep's list would
     * see the already-claimed row and the version would match, which is a different
     * scenario — and the one an earlier version of this test accidentally exercised.
     *
     * Their action is more current than the sweep's opinion that the task is abandoned,
     * so the sweep must lose rather than retry.
     */
    let claimed = false;
    store.onBeforeUpdate = async () => {
      if (claimed) return;
      claimed = true;
      store.onBeforeUpdate = undefined;
      await service.claim(actor(), task.id);
    };

    const result = await service.expireOverdue({ organizationId: ACME });

    expect(result.expired).toBe(0);
    expect(result.skipped).toBe(1);
    expect(store.records.get(task.id)?.status).toBe('claimed');
  });
});

// ===========================================================================
// Pagination
// ===========================================================================

describe('pagination', () => {
  it('caps the page size, whatever the caller asks for', async () => {
    const { store, service } = build();
    for (let index = 0; index < 5; index += 1) {
      await pooledTask(store, { assigneeUserId: 'user_a', assigneeRole: null });
    }

    // A client asking for 10,000 tasks is either a mistake or an attempt to make the
    // database do the work of a denial of service.
    const page = await service.listMine(actor(), 1, 10_000);
    expect(page.pageSize).toBe(100);
  });

  it('excludes claimed tasks from the available pool', async () => {
    const { store, service } = build();
    const first = await pooledTask(store);
    await pooledTask(store);

    await service.claim(actor({ userId: 'user_a' }), first.id);

    const available = await service.listAvailable(actor({ userId: 'user_b' }), 1, 25);
    expect(available.total).toBe(1);
  });

  it('includes a claimed task in the claimant’s own list', async () => {
    const { store, service } = build();
    const task = await pooledTask(store);
    await service.claim(actor({ userId: 'user_a' }), task.id);

    // A task pulled from a pool is theirs even though `assigneeUserId` is still null.
    const mine = await service.listMine(actor({ userId: 'user_a' }), 1, 25);
    expect(mine.total).toBe(1);
  });
});

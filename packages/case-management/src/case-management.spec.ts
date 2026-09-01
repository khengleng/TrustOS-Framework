import { describe, expect, it } from 'vitest';
import type { CaseRecord, CaseStatus, WorkflowActor } from '@trustsystem/workflow-core';
import { WORKFLOW_PERMISSIONS } from '@trustsystem/workflow-core';
import {
  HistoryRecorder,
  type HistoryStore,
  type WorkflowEventRecord,
} from '@trustsystem/workflow-history';
import { canTransitionCase, CaseService, EXAMPLE_CASE_TYPES, type CaseStore } from './index';

const ACME = 'org_acme';
const OTHER = 'org_globex';
const ALL = Object.values(WORKFLOW_PERMISSIONS).map((permission) => permission.key);

function actor(overrides: Partial<WorkflowActor> = {}): WorkflowActor {
  return {
    userId: 'user_owner',
    actorType: 'user',
    email: 'owner@acme.test',
    tokenId: 'tok',
    organizationId: ACME,
    roles: ['workflow_administrator'],
    permissions: ALL,
    isSuperAdmin: false,
    groupIds: [],
    authenticationLevel: 'medium',
    mfa: false,
    ...overrides,
  };
}

class TestHistoryStore implements HistoryStore {
  readonly records: WorkflowEventRecord[] = [];
  private counter = 0;

  async append(input: Omit<WorkflowEventRecord, 'id' | 'sequence'>) {
    this.counter += 1;
    const record: WorkflowEventRecord = {
      ...input,
      id: `e${this.counter}`,
      sequence: this.counter,
    };
    this.records.push(record);
    return { ...record };
  }

  async query(query: Parameters<HistoryStore['query']>[0]) {
    const all = this.records
      .filter((record) => record.organizationId === query.organizationId)
      .filter((record) => !query.caseId || record.caseId === query.caseId);
    return {
      items: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async recent() {
    return [];
  }

  async count() {
    return this.records.length;
  }

  byType(type: string) {
    return this.records.filter((record) => record.type === type);
  }
}

class TestCaseStore implements CaseStore {
  readonly records = new Map<string, CaseRecord>();
  private counter = 0;

  async findById(id: string, organizationId: string) {
    const found = this.records.get(id);
    return found && found.organizationId === organizationId ? { ...found } : null;
  }

  async findByReference(reference: string, organizationId: string) {
    return (
      [...this.records.values()].find(
        (record) => record.reference === reference && record.organizationId === organizationId,
      ) ?? null
    );
  }

  async create(input: Omit<CaseRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>) {
    this.counter += 1;
    const now = new Date('2026-08-01T09:00:00.000Z');
    const record: CaseRecord = {
      ...input,
      id: `case_${this.counter}`,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<CaseRecord>;
  }) {
    const found = this.records.get(input.id);
    if (!found) return null;
    if (found.organizationId !== input.organizationId) return null;
    if (found.version !== input.expectedVersion) return null;

    const updated = { ...found, ...input.patch, version: found.version + 1 };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async list(query: Parameters<CaseStore['list']>[0]) {
    const all = [...this.records.values()]
      .filter((record) => record.organizationId === query.organizationId)
      .filter((record) => !query.status || query.status.includes(record.status));
    return {
      items: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async listInstances() {
    return [];
  }

  async countByStatus(organizationId: string) {
    const counts = new Map<CaseStatus, number>();
    for (const record of this.records.values()) {
      if (record.organizationId !== organizationId) continue;
      counts.set(record.status, (counts.get(record.status) ?? 0) + 1);
    }
    return [...counts].map(([status, count]) => ({ status, count }));
  }
}

function build() {
  const store = new TestCaseStore();
  const historyStore = new TestHistoryStore();
  const service = new CaseService({
    store,
    history: new HistoryRecorder({
      store: historyStore,
      now: () => new Date('2026-08-01T09:00:00.000Z'),
    }),
    reference: async () => `CASE-${store.records.size + 1}`,
    now: () => new Date('2026-08-01T12:00:00.000Z'),
  });
  return { store, history: historyStore, service };
}

async function open(service: CaseService, overrides: Record<string, unknown> = {}) {
  return service.open(actor(), {
    caseType: 'complaint',
    subject: 'Card declined repeatedly',
    description: 'The customer reports three declines.',
    ...overrides,
  });
}

// ===========================================================================
// Opening
// ===========================================================================

describe('opening a case', () => {
  it('creates it unowned, in the open status', async () => {
    const { service } = build();
    const record = await open(service);

    expect(record.status).toBe('open');
    // An owner assigned at creation to whoever happened to open it is an owner nobody
    // chose, and "assigned to the person who raised it" is how a case queue stops working.
    expect(record.ownerId).toBe(null);
    expect(record.reference).toBe('CASE-1');
  });

  it('refuses an empty subject', async () => {
    const { service } = build();
    await expect(open(service, { subject: '   ' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('records case.opened in the timeline', async () => {
    const { service, history } = build();
    await open(service);

    expect(history.byType('case.opened')).toHaveLength(1);
  });

  it('refuses a caller without case.create', async () => {
    const { service } = build();
    await expect(
      service.open(actor({ permissions: [WORKFLOW_PERMISSIONS.CASE_READ.key] }), {
        caseType: 'complaint',
        subject: 'x',
        description: '',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('accepts a business-object reference', async () => {
    const { service } = build();
    const record = await open(service, {
      businessObjectType: 'Merchant',
      businessObjectId: 'm_1',
    });

    expect(record).toMatchObject({ businessObjectType: 'Merchant', businessObjectId: 'm_1' });
  });
});

// ===========================================================================
// The status graph
// ===========================================================================

describe('the case status graph', () => {
  it('is loose where case work is genuinely loose', () => {
    // Real case work moves backwards. A machine that forbade it would be worked around by
    // closing and re-raising, which loses the history.
    expect(canTransitionCase('waiting_for_information', 'under_review')).toBe(true);
    expect(canTransitionCase('escalated', 'under_review')).toBe(true);
    expect(canTransitionCase('resolved', 'under_review')).toBe(true);
  });

  it('reaches closed only from resolved', () => {
    // "Closed" with no record of what was decided is the state that makes a case system
    // useless six months later.
    expect(canTransitionCase('resolved', 'closed')).toBe(true);
    expect(canTransitionCase('open', 'closed')).toBe(false);
    expect(canTransitionCase('under_review', 'closed')).toBe(false);
    expect(canTransitionCase('escalated', 'closed')).toBe(false);
  });

  it('makes closed and cancelled terminal', () => {
    // Reopening means a new case that references this one, so the original closure stands.
    expect(canTransitionCase('closed', 'open')).toBe(false);
    expect(canTransitionCase('cancelled', 'open')).toBe(false);
  });
});

describe('changing status', () => {
  it('moves through the ordinary path', async () => {
    const { service } = build();
    const record = await open(service);

    const reviewing = await service.changeStatus(actor(), record.id, { to: 'under_review' });
    expect(reviewing.status).toBe('under_review');
  });

  it('requires a reason for waiting_for_information and escalated', async () => {
    const { service } = build();
    const record = await open(service);

    // "Waiting for what?" and "escalated why?" are the questions a reader asks.
    await expect(
      service.changeStatus(actor(), record.id, { to: 'waiting_for_information' }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    await expect(
      service.changeStatus(actor(), record.id, { to: 'escalated' }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    await expect(
      service.changeStatus(actor(), record.id, {
        to: 'escalated',
        reason: 'No response after five days.',
      }),
    ).resolves.toMatchObject({ status: 'escalated' });
  });

  it('refuses an illegal transition and lists what is available', async () => {
    const { service } = build();
    const record = await open(service);

    const error = await service
      .changeStatus(actor(), record.id, { to: 'closed' })
      .catch((caught: Error) => caught);

    expect(error.message).toContain('close()');
  });

  it('directs a caller to resolve() rather than faking a resolution', async () => {
    const { service } = build();
    const record = await open(service);

    await expect(service.changeStatus(actor(), record.id, { to: 'resolved' })).rejects.toThrow(
      /Use resolve\(\)/,
    );
  });

  it('refuses a stale version', async () => {
    const { service } = build();
    const record = await open(service);
    await service.changeStatus(actor(), record.id, { to: 'under_review' });

    await expect(
      service.changeStatus(actor(), record.id, {
        to: 'escalated',
        reason: 'x',
        expectedVersion: record.version,
      }),
    ).rejects.toMatchObject({ context: { reason: 'stale_version' } });
  });
});

// ===========================================================================
// Resolution and closure
// ===========================================================================

describe('resolving', () => {
  it('records a code and a narrative', async () => {
    const { service, history } = build();
    const record = await open(service);

    const resolved = await service.resolve(actor(), record.id, {
      resolutionCode: 'upheld',
      resolution: 'The declines were caused by an expired card. A replacement was issued.',
    });

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionCode).toBe('upheld');
    expect(resolved.resolvedById).toBe('user_owner');
    expect(history.byType('case.resolved')).toHaveLength(1);
  });

  it('requires both the code and the narrative', async () => {
    const { service } = build();
    const record = await open(service);

    // Codes without narrative cannot be understood; narrative without codes cannot be
    // counted. Either alone is insufficient.
    await expect(
      service.resolve(actor(), record.id, { resolutionCode: 'upheld', resolution: '  ' }),
    ).rejects.toMatchObject({ code: 'validation_error' });

    await expect(
      service.resolve(actor(), record.id, { resolutionCode: ' ', resolution: 'Something' }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('records how long the case was open', async () => {
    const { service, history } = build();
    const record = await open(service);

    await service.resolve(actor(), record.id, {
      resolutionCode: 'upheld',
      resolution: 'Done.',
    });

    // Created at 09:00, resolved at 12:00.
    expect(history.byType('case.resolved')[0]?.metadata).toMatchObject({
      openForSeconds: 3 * 3600,
    });
  });

  it('puts the narrative’s length in history, not its text', async () => {
    const { service, history } = build();
    const record = await open(service);

    await service.resolve(actor(), record.id, {
      resolutionCode: 'upheld',
      resolution: 'A customer identity number appears here: 998877.',
    });

    // A copy in history would be a second version that a later correction does not update.
    const serialized = JSON.stringify(history.byType('case.resolved'));
    expect(serialized).not.toContain('998877');
    expect(history.byType('case.resolved')[0]?.metadata).toHaveProperty('resolutionLength');
  });
});

describe('closing', () => {
  it('closes a resolved case with a reason', async () => {
    const { service, history } = build();
    const record = await open(service);
    await service.resolve(actor(), record.id, { resolutionCode: 'upheld', resolution: 'Done.' });

    const closed = await service.close(actor(), record.id, {
      closureReason: 'Customer confirmed the replacement arrived.',
    });

    expect(closed.status).toBe('closed');
    expect(closed.closedById).toBe('user_owner');
    expect(history.byType('case.closed')).toHaveLength(1);
  });

  it('refuses to close a case that was never resolved', async () => {
    const { service } = build();
    const record = await open(service);

    await expect(
      service.close(actor(), record.id, { closureReason: 'tidying up' }),
    ).rejects.toThrow(/must be resolved before it is closed/);
  });

  it('requires a closure reason', async () => {
    const { service } = build();
    const record = await open(service);
    await service.resolve(actor(), record.id, { resolutionCode: 'upheld', resolution: 'Done.' });

    await expect(service.close(actor(), record.id, { closureReason: '   ' })).rejects.toMatchObject(
      { code: 'validation_error' },
    );
  });

  it('is idempotent', async () => {
    const { service } = build();
    const record = await open(service);
    await service.resolve(actor(), record.id, { resolutionCode: 'upheld', resolution: 'Done.' });
    await service.close(actor(), record.id, { closureReason: 'Confirmed.' });

    const again = await service.close(actor(), record.id, { closureReason: 'Confirmed.' });
    expect(again.status).toBe('closed');
  });

  it('refuses any change to a closed case', async () => {
    const { service } = build();
    const record = await open(service);
    await service.resolve(actor(), record.id, { resolutionCode: 'upheld', resolution: 'Done.' });
    await service.close(actor(), record.id, { closureReason: 'Confirmed.' });

    await expect(service.update(actor(), record.id, { priority: 'high' })).rejects.toMatchObject({
      context: { reason: 'case_terminal' },
    });
  });
});

describe('cancelling', () => {
  it('is distinct from closing', async () => {
    const { service } = build();
    const record = await open(service);

    const cancelled = await service.cancel(actor(), record.id, 'Duplicate of CASE-3.');

    // A cancelled case was raised in error; a closed one was worked and resolved.
    // Reporting them as one number would make a team's resolution rate depend on how many
    // duplicates they received.
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.resolutionCode).toBe(null);
  });

  it('requires a reason', async () => {
    const { service } = build();
    const record = await open(service);

    await expect(service.cancel(actor(), record.id, '  ')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

// ===========================================================================
// Updating
// ===========================================================================

describe('updating', () => {
  it('changes ownership and records who it was before', async () => {
    const { service, history } = build();
    const record = await open(service);

    await service.update(actor(), record.id, { ownerId: 'user_a' });
    const second = await service.update(actor(), record.id, { ownerId: 'user_b' });

    expect(second.ownerId).toBe('user_b');
    // "Who owned this when it went wrong" is the question a case review asks, and a bare
    // "updated" does not answer it.
    const updates = history.byType('case.updated');
    expect(updates.at(-1)?.metadata).toMatchObject({
      previousOwnerId: 'user_a',
      newOwnerId: 'user_b',
    });
  });

  it('returns the record unchanged when nothing differs', async () => {
    const { service, history } = build();
    const record = await open(service);

    const same = await service.update(actor(), record.id, { priority: 'normal' });

    expect(same.version).toBe(record.version);
    expect(history.byType('case.updated')).toHaveLength(0);
  });

  it('does not move the status', async () => {
    const { service } = build();
    const record = await open(service);

    // A generic update that also moved the status would let a status change happen without
    // validation or a history entry.
    const updated = await service.update(actor(), record.id, { priority: 'high' });
    expect(updated.status).toBe('open');
  });
});

// ===========================================================================
// Tenant isolation
// ===========================================================================

describe('tenant isolation', () => {
  it('does not find a case from another organization', async () => {
    const { service } = build();
    const record = await open(service);

    // A case reference is guessable, so a 403 that confirmed existence would be worse than
    // a 404.
    await expect(service.find(actor({ organizationId: OTHER }), record.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('lists only this organization’s cases', async () => {
    const { service } = build();
    await open(service);

    expect((await service.list(actor(), { page: 1, pageSize: 25 })).total).toBe(1);
    expect(
      (await service.list(actor({ organizationId: OTHER }), { page: 1, pageSize: 25 })).total,
    ).toBe(0);
  });

  it('counts only this organization’s cases', async () => {
    const { service } = build();
    await open(service);

    expect(await service.countByStatus(actor())).toEqual([{ status: 'open', count: 1 }]);
    expect(await service.countByStatus(actor({ organizationId: OTHER }))).toEqual([]);
  });
});

describe('the timeline', () => {
  it('reads from workflow history rather than keeping its own', async () => {
    const { service } = build();
    const record = await open(service);
    await service.changeStatus(actor(), record.id, { to: 'under_review' });

    // One trail means a case and the workflows inside it are ordered against each other.
    // Two trails would need merging by timestamp, which is what `sequence` exists to avoid.
    const timeline = await service.timeline(actor(), record.id);
    expect(timeline.total).toBe(2);
  });

  it('is paginated', async () => {
    const { service } = build();
    const record = await open(service);

    const page = await service.timeline(actor(), record.id, { page: 1, pageSize: 1 });
    expect(page.pageSize).toBe(1);
  });
});

describe('the example case types', () => {
  it('are examples, and none of their business processes is implemented', () => {
    // `caseType` is a string and a product defines its own. These exist so the
    // documentation and the example application have something concrete.
    expect(EXAMPLE_CASE_TYPES).toContain('merchant_onboarding');
    expect(EXAMPLE_CASE_TYPES).toContain('fraud_investigation');
    expect(EXAMPLE_CASE_TYPES.length).toBe(6);
  });
});

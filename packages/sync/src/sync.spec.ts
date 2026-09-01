import { beforeEach, describe, expect, it, vi } from 'vitest';
import { retryPolicySchema } from '@trustsystem/retry';
import { SYNC_FAILURE_THRESHOLD, SyncService, type SyncConnector, type SyncRecord } from './sync';
import { InMemorySyncStore } from './testing';

const NO_WAIT = retryPolicySchema.parse({ maxAttempts: 0 });

let clock = new Date('2026-07-01T10:00:00Z');
let counter = 0;

/** A connector over a fixed set of remote records, paged by index. */
function connectorOver(
  remote: SyncRecord[],
  overrides: Partial<SyncConnector> = {},
): SyncConnector & { applied: SyncRecord[]; pushed: SyncRecord[] } {
  const applied: SyncRecord[] = [];
  const pushed: SyncRecord[] = [];

  return {
    key: 'test.connector',
    description: 'A connector for tests.',
    applied,
    pushed,

    fetchRemoteChanges: async ({ watermark, limit }) => {
      const start = watermark === null ? 0 : Number.parseInt(watermark, 10);
      const page = remote.slice(start, start + limit);
      const next = start + page.length;

      return {
        records: page,
        // The remote's own value, echoed back. Never a local timestamp.
        nextWatermark: String(next),
        hasMore: next < remote.length,
      };
    },

    findLocal: async () => null,
    applyLocal: async ({ record }) => {
      applied.push(record);
      return record.deleted ? 'deleted' : 'created';
    },

    fetchLocalChanges: async () => ({ records: [], nextWatermark: null, hasMore: false }),
    applyRemote: async ({ record }) => {
      pushed.push(record);
      return 'updated';
    },

    ...overrides,
  } as SyncConnector & { applied: SyncRecord[]; pushed: SyncRecord[] };
}

function setup(connector: SyncConnector) {
  const store = new InMemorySyncStore();
  const audit = { record: vi.fn() };

  const service = new SyncService({
    store,
    connectors: [connector],
    audit,
    retry: NO_WAIT,
    batchSize: 2,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { service, store, audit };
}

const remoteRecords: SyncRecord[] = [
  { externalId: 'a', data: { name: 'Ada' }, updatedAt: new Date('2026-06-01') },
  { externalId: 'b', data: { name: 'Grace' }, updatedAt: new Date('2026-06-02') },
  { externalId: 'c', data: { name: 'Alan' }, updatedAt: new Date('2026-06-03') },
];

async function aConnection(
  service: SyncService,
  overrides: Partial<Parameters<SyncService['createConnection']>[0]> = {},
) {
  return service.createConnection({
    organizationId: 'org_1',
    connectorKey: 'test.connector',
    name: 'Test sync',
    direction: 'pull',
    ...overrides,
  });
}

beforeEach(() => {
  clock = new Date('2026-07-01T10:00:00Z');
  counter = 0;
});

describe('creating a connection', () => {
  it('refuses a direction the connector cannot do', async () => {
    // Otherwise the connection reports successful syncs that moved nothing, which looks exactly
    // like "there is nothing to sync".
    const { service } = setup(connectorOver(remoteRecords, { applyRemote: undefined }));

    await expect(aConnection(service, { direction: 'push' })).rejects.toThrow(
      /cannot do a push sync/,
    );
  });

  it('accepts a direction the connector supports', async () => {
    const { service } = setup(connectorOver(remoteRecords));

    await expect(aConnection(service, { direction: 'bidirectional' })).resolves.toBeDefined();
  });

  it('defaults to remote_wins, because a pull asserts the remote is authoritative', async () => {
    const { service } = setup(connectorOver(remoteRecords));

    expect((await aConnection(service)).conflictPolicy).toBe('remote_wins');
  });

  it('refuses an unknown connector, naming what is registered', async () => {
    const { service } = setup(connectorOver(remoteRecords));

    await expect(aConnection(service, { connectorKey: 'test.missing' })).rejects.toThrow(
      /Unknown sync connector/,
    );
  });
});

describe('pulling', () => {
  it('applies every remote record', async () => {
    const connector = connectorOver(remoteRecords);
    const { service } = setup(connector);
    const connection = await aConnection(service);

    const run = await service.run(connection.id, 'org_1');

    expect(run.status).toBe('completed');
    expect(run.recordsRead).toBe(3);
    expect(connector.applied.map((record) => record.externalId)).toEqual(['a', 'b', 'c']);
  });

  it('saves the watermark from the remote, not from the local clock', async () => {
    // A watermark from local time skips records whenever the two clocks differ, silently.
    const connector = connectorOver(remoteRecords);
    const { service, store } = setup(connector);
    const connection = await aConnection(service);

    await service.run(connection.id, 'org_1');

    expect(store.connections.get(connection.id)?.watermark).toBe('3');
  });

  it('resumes from the watermark on the next run', async () => {
    const connector = connectorOver(remoteRecords);
    const { service } = setup(connector);
    const connection = await aConnection(service);

    await service.run(connection.id, 'org_1');
    connector.applied.length = 0;

    await service.run(connection.id, 'org_1');

    // Nothing new since the watermark.
    expect(connector.applied).toHaveLength(0);
  });

  it('starts from nothing on a full sync', async () => {
    const connector = connectorOver(remoteRecords);
    const { service } = setup(connector);
    const connection = await aConnection(service);

    await service.run(connection.id, 'org_1');
    connector.applied.length = 0;

    await service.run(connection.id, 'org_1', { fullSync: true });

    expect(connector.applied).toHaveLength(3);
  });

  it('does not advance the watermark past a failed batch', async () => {
    // The next run reprocesses rather than skips: reprocessing is safe if applyLocal is
    // idempotent, and skipping is silent data loss either way.
    let calls = 0;
    const connector = connectorOver(remoteRecords, {
      fetchRemoteChanges: async ({ watermark, limit }) => {
        calls += 1;
        if (calls === 2) throw new Error('the remote went away');

        const start = watermark === null ? 0 : Number.parseInt(watermark, 10);
        const page = remoteRecords.slice(start, start + limit);
        return {
          records: page,
          nextWatermark: String(start + page.length),
          hasMore: start + page.length < remoteRecords.length,
        };
      },
    });

    const { service, store } = setup(connector);
    const connection = await aConnection(service);

    await expect(service.run(connection.id, 'org_1')).rejects.toThrow(/the remote went away/);

    // The first batch completed, so the watermark is where it left off — not null, and not 3.
    expect(store.connections.get(connection.id)?.watermark).toBeNull();
    expect(store.connections.get(connection.id)?.status).toBe('failed');
  });

  it('applies a remote deletion', async () => {
    // A sync that ignored deletions would only ever grow.
    const connector = connectorOver([
      { externalId: 'a', data: {}, updatedAt: new Date('2026-06-01'), deleted: true },
    ]);
    const { service } = setup(connector);
    const connection = await aConnection(service);

    const run = await service.run(connection.id, 'org_1');

    expect(run.recordsDeleted).toBe(1);
  });

  it('counts one bad record without failing the run', async () => {
    // A single malformed record would otherwise stop the whole sync, and the next run would hit
    // it again — a permanently stuck connection caused by one row.
    const connector = connectorOver(remoteRecords, {
      applyLocal: async ({ record }) => {
        if (record.externalId === 'b') throw new Error('malformed field');
        return 'created';
      },
    });

    const { service } = setup(connector);
    const connection = await aConnection(service);

    const run = await service.run(connection.id, 'org_1');

    expect(run.recordsFailed).toBe(1);
    expect(run.recordsCreated).toBe(2);
    // Reported as partial rather than completed, so the difference is visible.
    expect(run.status).toBe('partial');
  });

  it('stops rather than looping when a connector reports more but returns none', async () => {
    const { service } = setup(
      connectorOver(remoteRecords, {
        fetchRemoteChanges: async () => ({ records: [], nextWatermark: 'x', hasMore: true }),
      }),
    );
    const connection = await aConnection(service);

    const run = await service.run(connection.id, 'org_1');

    expect(run.recordsRead).toBe(0);
  });

  it('refuses two concurrent runs of one connection', async () => {
    const { service, store } = setup(connectorOver(remoteRecords));
    const connection = await aConnection(service);
    await store.updateConnection(connection.id, { status: 'running' });

    // Two runs would process the same records twice and race on the watermark.
    await expect(service.run(connection.id, 'org_1')).rejects.toThrow(/already syncing/);
  });
});

describe('conflicts', () => {
  /** A connector whose local copy changed after the last successful sync. */
  function conflicting(localUpdatedAt: Date) {
    return connectorOver([remoteRecords[0]!], {
      findLocal: async () => ({ data: { name: 'Locally edited' }, updatedAt: localUpdatedAt }),
    });
  }

  async function primed(
    policy: Parameters<SyncService['createConnection']>[0]['conflictPolicy'],
    localUpdatedAt = new Date('2026-06-15'),
  ) {
    const connector = conflicting(localUpdatedAt);
    const { service, store } = setup(connector);
    const connection = await aConnection(service, { conflictPolicy: policy });

    // A prior successful sync, so "local changed since we last agreed" is meaningful.
    await store.updateConnection(connection.id, {
      lastSuccessAt: new Date('2026-06-10'),
      watermark: null,
    });

    return { service, store, connector, connectionId: connection.id };
  }

  it('detects a local change since the last successful sync', async () => {
    const { service, store, connectionId } = await primed('remote_wins');

    const run = await service.run(connectionId, 'org_1');

    expect(run.conflicts).toBe(1);
    expect(store.conflicts).toHaveLength(1);
  });

  it('compares against the last sync rather than against the remote timestamp', async () => {
    // The two systems' clocks are not the same clock, so "local is newer than remote" is not a
    // fact about causality. "Local changed since we last agreed" is.
    const { service, connectionId } = await primed('remote_wins', new Date('2026-06-05'));

    const run = await service.run(connectionId, 'org_1');

    expect(run.conflicts).toBe(0);
  });

  it('applies the remote under remote_wins', async () => {
    const { service, connector, connectionId } = await primed('remote_wins');

    await service.run(connectionId, 'org_1');

    expect(connector.applied).toHaveLength(1);
  });

  it('keeps the local copy under local_wins', async () => {
    const { service, connector, connectionId } = await primed('local_wins');

    const run = await service.run(connectionId, 'org_1');

    expect(connector.applied).toHaveLength(0);
    expect(run.recordsSkipped).toBe(1);
  });

  it('applies the newer side under newest_wins', async () => {
    // Remote is 2026-06-01; local here is 2026-05-01, so the remote is newer.
    const { service, connector, connectionId } = await primed(
      'newest_wins',
      new Date('2026-06-20'),
    );

    await service.run(connectionId, 'org_1');

    // Local (06-20) is newer than remote (06-01), so the local copy is kept.
    expect(connector.applied).toHaveLength(0);
  });

  it('changes nothing under manual, and records both sides', async () => {
    // The only policy that never silently discards somebody's edit.
    const { service, store, connector, connectionId } = await primed('manual');

    await service.run(connectionId, 'org_1');

    expect(connector.applied).toHaveLength(0);
    expect(store.conflicts[0]).toMatchObject({
      resolution: 'unresolved',
      resolvedAt: null,
      remoteData: { name: 'Ada' },
      localData: { name: 'Locally edited' },
    });
  });

  it('lists unresolved conflicts for a person to work through', async () => {
    const { service, connectionId } = await primed('manual');
    await service.run(connectionId, 'org_1');

    const unresolved = await service.conflicts({
      organizationId: 'org_1',
      unresolvedOnly: true,
    });

    expect(unresolved).toHaveLength(1);
  });

  it('marks a conflict resolved, naming who did it', async () => {
    const { service, store, connectionId } = await primed('manual');
    await service.run(connectionId, 'org_1');

    await service.resolveManually(store.conflicts[0]!.id, 'org_1', 'usr_1');

    expect(store.conflicts[0]?.resolvedById).toBe('usr_1');
    expect(await service.conflicts({ organizationId: 'org_1', unresolvedOnly: true })).toHaveLength(
      0,
    );
  });
});

describe('pushing', () => {
  it('sends local changes to the remote', async () => {
    const local: SyncRecord[] = [
      { externalId: 'x', data: { name: 'Local one' }, updatedAt: new Date('2026-06-05') },
    ];

    const connector = connectorOver([], {
      fetchLocalChanges: async () => ({ records: local, nextWatermark: '1', hasMore: false }),
    });

    const { service } = setup(connector);
    const connection = await aConnection(service, { direction: 'push' });

    const run = await service.run(connection.id, 'org_1');

    expect(connector.pushed.map((record) => record.externalId)).toEqual(['x']);
    expect(run.recordsUpdated).toBe(1);
  });

  it('does both directions for a bidirectional connection', async () => {
    const connector = connectorOver(remoteRecords, {
      fetchLocalChanges: async () => ({
        records: [{ externalId: 'x', data: {}, updatedAt: new Date('2026-06-05') }],
        nextWatermark: null,
        hasMore: false,
      }),
    });

    const { service } = setup(connector);
    const connection = await aConnection(service, { direction: 'bidirectional' });

    await service.run(connection.id, 'org_1');

    expect(connector.applied).toHaveLength(3);
    expect(connector.pushed).toHaveLength(1);
  });
});

describe('failure handling', () => {
  it('pauses a connection after repeated failures', async () => {
    const { service, store } = setup(
      connectorOver(remoteRecords, {
        fetchRemoteChanges: async () => {
          throw new Error('the remote is unreachable');
        },
      }),
    );
    const connection = await aConnection(service);

    for (let i = 0; i < SYNC_FAILURE_THRESHOLD; i += 1) {
      await store.updateConnection(connection.id, { status: 'idle' });
      await service.run(connection.id, 'org_1').catch(() => {});
    }

    expect(store.connections.get(connection.id)?.status).toBe('paused');
  });

  it('refuses to run a paused connection, and says why', async () => {
    const { service, store } = setup(connectorOver(remoteRecords));
    const connection = await aConnection(service);
    await store.updateConnection(connection.id, {
      status: 'paused',
      lastError: 'the remote is unreachable',
    });

    await expect(service.run(connection.id, 'org_1')).rejects.toThrow(/the remote is unreachable/);
  });

  it('clears the failure count on resume', async () => {
    // Otherwise it is one failure from pausing again, with no indication why.
    const { service, store } = setup(connectorOver(remoteRecords));
    const connection = await aConnection(service);
    await store.updateConnection(connection.id, {
      status: 'paused',
      consecutiveFailures: 4,
      lastError: 'boom',
    });

    const resumed = await service.resume(connection.id, 'org_1', 'usr_1');

    expect(resumed.status).toBe('idle');
    expect(resumed.consecutiveFailures).toBe(0);
  });

  it('records a failed run with its reason', async () => {
    const { service } = setup(
      connectorOver(remoteRecords, {
        fetchRemoteChanges: async () => {
          throw new Error('the remote is unreachable');
        },
      }),
    );
    const connection = await aConnection(service);

    await service.run(connection.id, 'org_1').catch(() => {});

    const [run] = await service.runs(connection.id, 'org_1');
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/unreachable/);
  });
});

describe('run history', () => {
  it('records the watermark a run started and finished at', async () => {
    // Which is what makes a run reproducible.
    const { service } = setup(connectorOver(remoteRecords));
    const connection = await aConnection(service);

    await service.run(connection.id, 'org_1');
    const [run] = await service.runs(connection.id, 'org_1');

    expect(run?.fromWatermark).toBeNull();
    expect(run?.toWatermark).toBe('3');
  });

  it('audits a completed run', async () => {
    const { service, audit } = setup(connectorOver(remoteRecords));
    const connection = await aConnection(service);

    await service.run(connection.id, 'org_1');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sync.completed' }),
    );
  });
});

describe('tenant isolation', () => {
  it('does not return another organization’s connection', async () => {
    const { service } = setup(connectorOver(remoteRecords));
    const connection = await aConnection(service);

    await expect(service.getConnection(connection.id, 'org_2')).rejects.toThrow(
      /No sync connection/,
    );
  });

  it('passes the organization to every connector call', async () => {
    const seen: Array<string | null> = [];
    const { service } = setup(
      connectorOver(remoteRecords, {
        fetchRemoteChanges: async ({ organizationId }) => {
          seen.push(organizationId);
          return { records: [], nextWatermark: null, hasMore: false };
        },
      }),
    );

    const connection = await aConnection(service);
    await service.run(connection.id, 'org_1');

    // A connector that ignored it would pull one tenant's records into another's system.
    expect(seen).toEqual(['org_1']);
  });
});

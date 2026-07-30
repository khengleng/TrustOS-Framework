import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import { RETRY_PRESETS, withRetry, type RetryPolicy } from '@trustos/retry';

/**
 * Synchronization.
 *
 * Keeping two systems agreeing about the same records. The framework provides the loop, the
 * bookkeeping and the conflict rules; **it integrates with no external provider**. A deployment
 * supplies a `SyncConnector` and the loop drives it.
 *
 * The two hard parts, and what is done about each:
 *
 * **1. Knowing what changed.** A full sync every time does not scale past a few thousand records.
 * Incremental sync uses a watermark — the timestamp or cursor of the last record seen — and asks
 * only for what is newer. The trap is that a watermark taken from *local* time will silently skip
 * records when the two systems' clocks differ, so the watermark is always the remote's own value,
 * echoed back to it. Never `new Date()`.
 *
 * **2. Both sides changed.** That is a conflict, and there is no universally right answer — which
 * is why the policy is explicit and `manual` exists. The default is `remote_wins` for a pull,
 * because a pull is an assertion that the remote is authoritative; if it is not, a pull is the
 * wrong direction.
 *
 * A third trap worth stating: **the watermark advances only after a successful batch**. Advancing
 * it as records are read means a mid-batch failure loses everything since the last save, silently
 * — the next run asks for changes after a point it never actually processed.
 */

export const SYNC_DIRECTIONS = ['pull', 'push', 'bidirectional'] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

export const SYNC_STATUSES = ['idle', 'running', 'failed', 'paused'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/**
 * What to do when both sides changed the same record.
 *
 *   * `remote_wins` — the remote is authoritative. The default for a pull.
 *   * `local_wins` — the local copy is authoritative.
 *   * `newest_wins` — most recent `updatedAt`. Sounds sensible and depends on two clocks agreeing,
 *     which across systems they do not. Available, and rarely the right choice.
 *   * `manual` — record the conflict and change nothing. The honest option when the answer is a
 *     judgement, and the only one that never silently discards somebody's edit.
 */
export const CONFLICT_POLICIES = ['remote_wins', 'local_wins', 'newest_wins', 'manual'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];

export interface SyncRecord {
  /** The remote's identifier. The join key between the two systems. */
  externalId: string;
  /** The record itself, in whatever shape the connector produces. */
  data: Record<string, unknown>;
  /**
   * The remote's own timestamp for this record.
   *
   * The remote's value, not the local clock. A watermark from local time skips records whenever
   * the two systems' clocks differ, and does so silently.
   */
  updatedAt: Date;
  /** True when the remote reports it deleted. A sync that ignored deletions would only ever grow. */
  deleted?: boolean;
}

export interface SyncBatch {
  records: SyncRecord[];
  /**
   * The watermark to resume from.
   *
   * Supplied by the connector, from the remote's own data. Saved only after the batch is
   * processed — see the header.
   */
  nextWatermark: string | null;
  hasMore: boolean;
}

/**
 * What a deployment implements. The framework ships none of these.
 *
 * Every method takes `organizationId`, and it is not decorative: a connector that ignored it
 * would pull one tenant's records into another's system.
 */
export interface SyncConnector<TLocal = unknown> {
  key: string;
  description: string;

  /** Fetches records changed since the watermark. Null means a full sync. */
  fetchRemoteChanges?(input: {
    organizationId: string | null;
    watermark: string | null;
    limit: number;
  }): Promise<SyncBatch>;

  /** Local records changed since the watermark, to push. */
  fetchLocalChanges?(input: {
    organizationId: string | null;
    watermark: string | null;
    limit: number;
  }): Promise<SyncBatch>;

  /** The local copy of a remote record, for conflict detection. */
  findLocal?(input: {
    organizationId: string | null;
    externalId: string;
  }): Promise<{ data: TLocal; updatedAt: Date } | null>;

  /** Writes a remote record locally. */
  applyLocal?(input: {
    organizationId: string | null;
    record: SyncRecord;
  }): Promise<'created' | 'updated' | 'deleted' | 'skipped'>;

  /** Writes a local record to the remote. */
  applyRemote?(input: {
    organizationId: string | null;
    record: SyncRecord;
  }): Promise<'created' | 'updated' | 'deleted' | 'skipped'>;
}

export interface SyncConnection {
  id: string;
  organizationId: string | null;
  connectorKey: string;
  name: string;
  direction: SyncDirection;
  conflictPolicy: ConflictPolicy;
  status: SyncStatus;

  /** Where to resume. The remote's own value. */
  watermark: string | null;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export interface SyncRun {
  id: string;
  connectionId: string;
  organizationId: string | null;
  direction: SyncDirection;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'completed' | 'failed' | 'partial';

  recordsRead: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsDeleted: number;
  recordsSkipped: number;
  recordsFailed: number;
  conflicts: number;

  /** The watermark this run started from. Makes a run reproducible. */
  fromWatermark: string | null;
  toWatermark: string | null;
  error: string | null;
}

export interface SyncConflict {
  id: string;
  connectionId: string;
  organizationId: string | null;
  runId: string;
  externalId: string;
  policy: ConflictPolicy;
  resolution: 'remote_applied' | 'local_kept' | 'newest_applied' | 'unresolved';
  remoteUpdatedAt: Date;
  localUpdatedAt: Date;
  /** Both sides, so a person resolving it can see what they are choosing between. */
  remoteData: unknown;
  localData: unknown;
  resolvedAt: Date | null;
  resolvedById: string | null;
  detectedAt: Date;
}

export interface SyncStore {
  createConnection(connection: SyncConnection): Promise<SyncConnection>;
  findConnection(id: string, organizationId: string | null): Promise<SyncConnection | null>;
  updateConnection(id: string, patch: Partial<SyncConnection>): Promise<void>;
  listConnections(organizationId: string | null): Promise<SyncConnection[]>;

  createRun(run: SyncRun): Promise<SyncRun>;
  updateRun(id: string, patch: Partial<SyncRun>): Promise<void>;
  listRuns(connectionId: string, organizationId: string | null, limit?: number): Promise<SyncRun[]>;

  recordConflict(conflict: SyncConflict): Promise<void>;
  listConflicts(filter: {
    organizationId: string | null;
    connectionId?: string;
    unresolvedOnly?: boolean;
    limit?: number;
  }): Promise<SyncConflict[]>;
  resolveConflict(id: string, organizationId: string | null, resolvedById: string): Promise<void>;
}

export interface SyncServiceOptions {
  store: SyncStore;
  connectors?: SyncConnector[];
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  retry?: RetryPolicy;
  batchSize?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

/** Consecutive failures before a connection pauses itself. */
export const SYNC_FAILURE_THRESHOLD = 5;

export class SyncService {
  private readonly connectors = new Map<string, SyncConnector>();
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: SyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    for (const connector of options.connectors ?? []) this.register(connector);
  }

  register(connector: SyncConnector): this {
    if (this.connectors.has(connector.key)) {
      throw ApiError.conflict(`A sync connector for "${connector.key}" is already registered.`, {
        reason: 'sync_connector_conflict',
        key: connector.key,
      });
    }
    this.connectors.set(connector.key, connector);
    return this;
  }

  private connector(key: string): SyncConnector {
    const connector = this.connectors.get(key);

    if (!connector) {
      const known = [...this.connectors.keys()].sort().join(', ') || '(none)';
      throw ApiError.validation(
        [
          {
            path: 'connectorKey',
            message: `No sync connector for "${key}". Registered: ${known}.`,
          },
        ],
        `Unknown sync connector "${key}".`,
      );
    }

    return connector;
  }

  async createConnection(input: {
    organizationId: string | null;
    connectorKey: string;
    name: string;
    direction: SyncDirection;
    conflictPolicy?: ConflictPolicy;
  }): Promise<SyncConnection> {
    const connector = this.connector(input.connectorKey);

    /*
     * The connector must implement the direction it is asked for.
     *
     * Checked at creation, not at the first run: a connection configured to push against a
     * connector with no `applyRemote` would otherwise sit there reporting successful syncs that
     * moved nothing, which looks exactly like "there is nothing to sync".
     */
    this.assertSupportsDirection(connector, input.direction);

    const now = this.now();
    const connection: SyncConnection = {
      id: this.newId('sync'),
      organizationId: input.organizationId,
      connectorKey: input.connectorKey,
      name: input.name,
      direction: input.direction,
      conflictPolicy: input.conflictPolicy ?? 'remote_wins',
      status: 'idle',
      watermark: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    return this.options.store.createConnection(connection);
  }

  private assertSupportsDirection(connector: SyncConnector, direction: SyncDirection): void {
    const missing: string[] = [];

    if (direction === 'pull' || direction === 'bidirectional') {
      if (!connector.fetchRemoteChanges) missing.push('fetchRemoteChanges');
      if (!connector.applyLocal) missing.push('applyLocal');
    }

    if (direction === 'push' || direction === 'bidirectional') {
      if (!connector.fetchLocalChanges) missing.push('fetchLocalChanges');
      if (!connector.applyRemote) missing.push('applyRemote');
    }

    if (missing.length > 0) {
      throw ApiError.validation(
        missing.map((method) => ({
          path: 'direction',
          message: `The "${connector.key}" connector does not implement ${method}, which a ${direction} sync needs.`,
        })),
        `This connector cannot do a ${direction} sync.`,
      );
    }
  }

  /**
   * Runs one sync.
   *
   * Batch by batch, saving the watermark only after each batch is processed. A run that fails
   * halfway keeps the watermark from the last completed batch, so the next run reprocesses that
   * batch rather than skipping it — reprocessing is safe if `applyLocal` is idempotent, and
   * skipping is silent data loss either way.
   */
  async run(
    connectionId: string,
    organizationId: string | null,
    options: { fullSync?: boolean; maxBatches?: number; signal?: AbortSignal } = {},
  ): Promise<SyncRun> {
    const connection = await this.getConnection(connectionId, organizationId);

    if (connection.status === 'running') {
      throw ApiError.conflict(
        'This connection is already syncing. Two runs at once would process the same records ' +
          'twice and race on the watermark.',
        { reason: 'sync_already_running', connectionId },
      );
    }

    if (connection.status === 'paused') {
      throw ApiError.conflict(
        `This connection is paused: ${connection.lastError ?? 'no reason recorded'}. Resume it first.`,
        { reason: 'sync_paused', connectionId },
      );
    }

    const connector = this.connector(connection.connectorKey);
    const startedAt = this.now();
    // A full sync starts from nothing. The watermark is not cleared on the connection until the
    // run succeeds — a failed full sync must not leave the connection thinking it is up to date.
    const fromWatermark = options.fullSync ? null : connection.watermark;

    const run: SyncRun = {
      id: this.newId('srun'),
      connectionId,
      organizationId,
      direction: connection.direction,
      startedAt,
      finishedAt: null,
      status: 'running',
      recordsRead: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsDeleted: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
      conflicts: 0,
      fromWatermark,
      toWatermark: null,
      error: null,
    };

    await this.options.store.createRun(run);
    await this.options.store.updateConnection(connectionId, {
      status: 'running',
      lastSyncAt: startedAt,
    });

    try {
      let watermark = fromWatermark;

      if (connection.direction === 'pull' || connection.direction === 'bidirectional') {
        watermark = await this.pull(connection, connector, run, watermark, options);
      }

      if (connection.direction === 'push' || connection.direction === 'bidirectional') {
        await this.push(connection, connector, run, watermark, options);
      }

      const status = run.recordsFailed > 0 ? 'partial' : 'completed';
      const finishedAt = this.now();

      await this.options.store.updateRun(run.id, {
        ...run,
        status,
        finishedAt,
        toWatermark: watermark,
      });

      await this.options.store.updateConnection(connectionId, {
        status: 'idle',
        watermark,
        lastSuccessAt: finishedAt,
        consecutiveFailures: 0,
        lastError: null,
      });

      await this.options.audit?.record({
        action: 'sync.completed',
        entityType: 'SyncConnection',
        entityId: connectionId,
        actorId: null,
        organizationId,
        after: {
          runId: run.id,
          direction: connection.direction,
          recordsRead: run.recordsRead,
          recordsFailed: run.recordsFailed,
          conflicts: run.conflicts,
        },
      });

      return { ...run, status, finishedAt, toWatermark: watermark };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const consecutiveFailures = connection.consecutiveFailures + 1;
      const shouldPause = consecutiveFailures >= SYNC_FAILURE_THRESHOLD;

      await this.options.store.updateRun(run.id, {
        ...run,
        status: 'failed',
        finishedAt: this.now(),
        error: message,
      });

      await this.options.store.updateConnection(connectionId, {
        // Not `watermark` — it stays where the last successful batch left it, so the next run
        // reprocesses rather than skips.
        status: shouldPause ? 'paused' : 'failed',
        consecutiveFailures,
        lastError: message.slice(0, 2000),
      });

      this.options.logger?.error(
        {
          connectionId,
          connectorKey: connection.connectorKey,
          consecutiveFailures,
          error: message,
        },
        shouldPause ? 'sync connection paused after repeated failures' : 'sync run failed',
      );

      throw error;
    }
  }

  /** Pulls remote changes into the local system. Returns the watermark reached. */
  private async pull(
    connection: SyncConnection,
    connector: SyncConnector,
    run: SyncRun,
    startWatermark: string | null,
    options: { maxBatches?: number; signal?: AbortSignal },
  ): Promise<string | null> {
    const batchSize = this.options.batchSize ?? 200;
    const maxBatches = options.maxBatches ?? 1000;

    let watermark = startWatermark;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (options.signal?.aborted) break;

      const result = await withRetry(
        () =>
          connector.fetchRemoteChanges!({
            organizationId: connection.organizationId,
            watermark,
            limit: batchSize,
          }),
        {
          operation: `sync.${connector.key}.fetch`,
          policy: this.options.retry ?? RETRY_PRESETS.background,
          signal: options.signal,
        },
      );

      const page = result.value;
      run.recordsRead += page.records.length;

      for (const record of page.records) {
        await this.applyPulled(connection, connector, run, record);
      }

      // Advanced only now, after the whole batch is processed. Advancing as records are read
      // means a mid-batch failure silently skips everything since the last save.
      watermark = page.nextWatermark;

      if (!page.hasMore) break;

      // A connector reporting more but returning nothing would loop until `maxBatches`.
      if (page.records.length === 0) {
        this.options.logger?.warn(
          { connectionId: connection.id, connectorKey: connector.key },
          'sync connector reported more records but returned none; stopping',
        );
        break;
      }
    }

    return watermark;
  }

  /** Applies one pulled record, resolving a conflict if there is one. */
  private async applyPulled(
    connection: SyncConnection,
    connector: SyncConnector,
    run: SyncRun,
    record: SyncRecord,
  ): Promise<void> {
    try {
      const local = connector.findLocal
        ? await connector.findLocal({
            organizationId: connection.organizationId,
            externalId: record.externalId,
          })
        : null;

      /*
       * A conflict is when the local copy changed *after* the last successful sync.
       *
       * Compared against `lastSuccessAt` rather than against the remote's timestamp: the two
       * systems' clocks are not the same clock, so "local is newer than remote" is not a fact
       * about causality. "Local changed since we last agreed" is.
       */
      const locallyChanged =
        local !== null &&
        connection.lastSuccessAt !== null &&
        local.updatedAt > connection.lastSuccessAt;

      if (locallyChanged) {
        run.conflicts += 1;
        const resolution = await this.resolveConflict(connection, run, record, local);

        if (resolution === 'skip') {
          run.recordsSkipped += 1;
          return;
        }
      }

      const outcome = await connector.applyLocal!({
        organizationId: connection.organizationId,
        record,
      });

      if (outcome === 'created') run.recordsCreated += 1;
      else if (outcome === 'updated') run.recordsUpdated += 1;
      else if (outcome === 'deleted') run.recordsDeleted += 1;
      else run.recordsSkipped += 1;
    } catch (error) {
      /*
       * One bad record does not fail the run.
       *
       * A single record with a malformed field would otherwise stop the whole sync, and the next
       * run would hit it again — a permanently stuck connection caused by one row. It is counted,
       * and a run with failures is reported as `partial` rather than `completed`.
       */
      run.recordsFailed += 1;
      this.options.logger?.warn(
        {
          connectionId: connection.id,
          externalId: record.externalId,
          error: error instanceof Error ? error.message : String(error),
        },
        'sync record failed',
      );
    }
  }

  /** Applies the conflict policy. Returns whether to write the remote record. */
  private async resolveConflict(
    connection: SyncConnection,
    run: SyncRun,
    record: SyncRecord,
    local: { data: unknown; updatedAt: Date },
  ): Promise<'apply' | 'skip'> {
    const resolution: SyncConflict['resolution'] =
      connection.conflictPolicy === 'remote_wins'
        ? 'remote_applied'
        : connection.conflictPolicy === 'local_wins'
          ? 'local_kept'
          : connection.conflictPolicy === 'newest_wins'
            ? record.updatedAt > local.updatedAt
              ? 'newest_applied'
              : 'local_kept'
            : 'unresolved';

    await this.options.store.recordConflict({
      id: this.newId('sconf'),
      connectionId: connection.id,
      organizationId: connection.organizationId,
      runId: run.id,
      externalId: record.externalId,
      policy: connection.conflictPolicy,
      resolution,
      remoteUpdatedAt: record.updatedAt,
      localUpdatedAt: local.updatedAt,
      // Both sides are kept, so somebody resolving it can see what they are choosing between.
      remoteData: record.data,
      localData: local.data,
      resolvedAt: resolution === 'unresolved' ? null : this.now(),
      resolvedById: null,
      detectedAt: this.now(),
    });

    // `manual` changes nothing — the only policy that never silently discards somebody's edit.
    return resolution === 'remote_applied' || resolution === 'newest_applied' ? 'apply' : 'skip';
  }

  /** Pushes local changes to the remote. */
  private async push(
    connection: SyncConnection,
    connector: SyncConnector,
    run: SyncRun,
    watermark: string | null,
    options: { maxBatches?: number; signal?: AbortSignal },
  ): Promise<void> {
    const batchSize = this.options.batchSize ?? 200;
    const maxBatches = options.maxBatches ?? 1000;

    let cursor = watermark;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (options.signal?.aborted) break;

      const page = await connector.fetchLocalChanges!({
        organizationId: connection.organizationId,
        watermark: cursor,
        limit: batchSize,
      });

      run.recordsRead += page.records.length;

      for (const record of page.records) {
        try {
          const outcome = await connector.applyRemote!({
            organizationId: connection.organizationId,
            record,
          });

          if (outcome === 'created') run.recordsCreated += 1;
          else if (outcome === 'updated') run.recordsUpdated += 1;
          else if (outcome === 'deleted') run.recordsDeleted += 1;
          else run.recordsSkipped += 1;
        } catch (error) {
          run.recordsFailed += 1;
          this.options.logger?.warn(
            {
              connectionId: connection.id,
              externalId: record.externalId,
              error: error instanceof Error ? error.message : String(error),
            },
            'sync push failed for a record',
          );
        }
      }

      cursor = page.nextWatermark;
      if (!page.hasMore || page.records.length === 0) break;
    }
  }

  async getConnection(id: string, organizationId: string | null): Promise<SyncConnection> {
    const connection = await this.options.store.findConnection(id, organizationId);
    if (!connection) throw ApiError.notFound(`No sync connection with id "${id}".`);
    return connection;
  }

  async listConnections(organizationId: string | null): Promise<SyncConnection[]> {
    return this.options.store.listConnections(organizationId);
  }

  async runs(connectionId: string, organizationId: string | null, limit = 50): Promise<SyncRun[]> {
    await this.getConnection(connectionId, organizationId);
    return this.options.store.listRuns(connectionId, organizationId, limit);
  }

  async conflicts(filter: Parameters<SyncStore['listConflicts']>[0]): Promise<SyncConflict[]> {
    return this.options.store.listConflicts(filter);
  }

  /** Marks a manually-recorded conflict resolved. */
  async resolveManually(
    conflictId: string,
    organizationId: string | null,
    resolvedById: string,
  ): Promise<void> {
    await this.options.store.resolveConflict(conflictId, organizationId, resolvedById);

    await this.options.audit?.record({
      action: 'sync.conflict.resolved',
      entityType: 'SyncConflict',
      entityId: conflictId,
      actorId: resolvedById,
      organizationId,
    });
  }

  /**
   * Resumes a paused connection.
   *
   * Clears the failure count. Without that it is one failure from pausing again, with no
   * indication of why.
   */
  async resume(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<SyncConnection> {
    const connection = await this.getConnection(id, organizationId);

    await this.options.store.updateConnection(id, {
      status: 'idle',
      consecutiveFailures: 0,
      lastError: null,
    });

    await this.options.audit?.record({
      action: 'sync.connection.resumed',
      entityType: 'SyncConnection',
      entityId: id,
      actorId,
      organizationId,
      before: { status: connection.status, lastError: connection.lastError },
      after: { status: 'idle' },
    });

    return this.getConnection(id, organizationId);
  }

  async pause(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<SyncConnection> {
    await this.getConnection(id, organizationId);
    await this.options.store.updateConnection(id, { status: 'paused' });

    await this.options.audit?.record({
      action: 'sync.connection.paused',
      entityType: 'SyncConnection',
      entityId: id,
      actorId,
      organizationId,
    });

    return this.getConnection(id, organizationId);
  }

  connectorKeys(): string[] {
    return [...this.connectors.keys()].sort();
  }
}

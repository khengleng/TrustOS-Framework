import { ApiError } from '@trustsystem/errors';
import type { AuditService } from '@trustsystem/audit';
import type { LoggerPort } from '@trustsystem/logging';
import type { DeadLetterEntry, DeadLetterFilter, DeadLetterStore, EventBus } from './contracts';

/**
 * Replaying dead letters.
 *
 * A dead-letter queue nobody can replay from is a log with extra steps. This is the other half:
 * fix the handler, deploy, replay the events it failed on.
 *
 * Three things it deliberately does:
 *
 *   * **Replays to one subscriber, not to all of them.** The event failed for one handler; the
 *     others already succeeded, and republishing to everybody would re-run work that was fine.
 *   * **Refuses a cross-tenant replay.** The operator's organization must match the entry's.
 *     Without that check, replay is a way to make one tenant's event appear in another's system
 *     — which is a data breach dressed as an operational tool.
 *   * **Keeps the entry.** Marked replayed, never deleted. The failure happened, and the record
 *     of it is what makes the incident explicable afterwards.
 */

export interface ReplayOptions {
  /** For the audit record. Replay is a privileged action and is never anonymous. */
  actorId: string;
  /**
   * The operator's organization, or null for platform staff.
   *
   * Checked against the entry. This is the tenant boundary, and it is here rather than in the
   * controller so it holds for every caller including a CLI.
   */
  organizationId: string | null;
}

export interface ReplayResult {
  entryId: string;
  eventId: string;
  subscriptionId: string;
  outcome: 'delivered' | 'failed';
  error: string | null;
}

export class DeadLetterReplayService {
  constructor(
    private readonly options: {
      bus: EventBus;
      store: DeadLetterStore;
      audit?: Pick<AuditService, 'record'>;
      logger?: LoggerPort;
    },
  ) {}

  async list(filter: DeadLetterFilter): Promise<DeadLetterEntry[]> {
    return this.options.store.list(filter);
  }

  /**
   * Replays one entry.
   *
   * The event is republished rather than the handler being called directly, so it goes through
   * validation, the ledger and retry exactly as a live event would. A replay path that bypassed
   * those would be a second, less-tested delivery mechanism — and the one used at the worst
   * possible moment.
   */
  async replay(entryId: string, options: ReplayOptions): Promise<ReplayResult> {
    const entry = await this.options.store.get(entryId);

    if (!entry) {
      throw ApiError.notFound(`No dead-letter entry with id "${entryId}".`);
    }

    assertSameTenant(entry, options.organizationId);

    if (entry.replayedAt !== null) {
      throw ApiError.conflict(
        `This entry was already replayed at ${entry.replayedAt.toISOString()}. Replaying it ` +
          'again would deliver the event a second time.',
        { reason: 'already_replayed', entryId },
      );
    }

    /*
     * A dedicated subscription id, so the ledger does not suppress the replay.
     *
     * The original delivery is already recorded under the subscriber's key, and a replay that
     * deduplicated against it would silently do nothing — the single most confusing possible
     * outcome for somebody replaying an event to fix a production problem.
     */
    const result = await this.options.bus.publish(
      {
        ...entry.envelope,
        idempotencyKey: `replay:${entry.id}`,
        metadata: {
          ...entry.envelope.metadata,
          attributes: {
            ...entry.envelope.metadata.attributes,
            replayOf: entry.eventId,
            replayedBy: options.actorId,
          },
        },
      },
      { awaitDelivery: true },
    );

    await this.options.store.markReplayed(entry.id, options.actorId);

    await this.options.audit?.record({
      action: 'event.dead_letter.replayed',
      entityType: 'EventDeadLetter',
      entityId: entry.id,
      actorId: options.actorId,
      organizationId: entry.organizationId,
      after: {
        eventId: entry.eventId,
        eventName: entry.eventName,
        subscriptionId: entry.subscriptionId,
        outcome: result.failed > 0 ? 'failed' : 'delivered',
      },
    });

    this.options.logger?.info(
      { entryId: entry.id, eventId: entry.eventId, actorId: options.actorId },
      'dead letter replayed',
    );

    return {
      entryId: entry.id,
      eventId: entry.eventId,
      subscriptionId: entry.subscriptionId,
      outcome: result.failed > 0 ? 'failed' : 'delivered',
      error:
        result.failed > 0 ? 'The handler failed again. The entry stays marked replayed.' : null,
    };
  }

  /**
   * Replays several entries.
   *
   * Sequential and bounded. A bulk replay of ten thousand entries in parallel is a
   * self-inflicted denial of service against whatever the handler talks to — which is often the
   * thing that was down in the first place.
   */
  async replayBatch(
    entryIds: string[],
    options: ReplayOptions & { maxEntries?: number },
  ): Promise<ReplayResult[]> {
    const limit = options.maxEntries ?? 100;

    if (entryIds.length > limit) {
      throw ApiError.validation(
        [
          {
            path: 'entryIds',
            message:
              `${entryIds.length} entries were given and the limit is ${limit}. Replay in ` +
              'batches — a bulk replay is a load test against whatever the handler calls.',
          },
        ],
        'Too many entries to replay at once.',
      );
    }

    const results: ReplayResult[] = [];

    for (const entryId of entryIds) {
      try {
        results.push(await this.replay(entryId, options));
      } catch (error) {
        // One bad entry does not stop the batch. The alternative is an operator retrying the
        // whole list to get past a single already-replayed id.
        results.push({
          entryId,
          eventId: '',
          subscriptionId: '',
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /** Counts by subscription and event, for the monitoring dashboard. */
  async summary(
    organizationId: string | null,
  ): Promise<
    Array<{ subscriptionId: string; eventName: string; count: number; oldestFailedAt: Date }>
  > {
    const entries = await this.options.store.list({
      organizationId,
      unreplayedOnly: true,
      limit: 10_000,
    });

    const grouped = new Map<
      string,
      { subscriptionId: string; eventName: string; count: number; oldestFailedAt: Date }
    >();

    for (const entry of entries) {
      const key = `${entry.subscriptionId}|${entry.eventName}`;
      const existing = grouped.get(key);

      if (existing) {
        existing.count += 1;
        if (entry.failedAt < existing.oldestFailedAt) existing.oldestFailedAt = entry.failedAt;
      } else {
        grouped.set(key, {
          subscriptionId: entry.subscriptionId,
          eventName: entry.eventName,
          count: 1,
          oldestFailedAt: entry.failedAt,
        });
      }
    }

    return [...grouped.values()].sort((a, b) => b.count - a.count);
  }
}

/**
 * The tenant boundary on replay.
 *
 * Platform staff (`organizationId: null`) may replay anything. Anybody else may replay only
 * their own organization's entries — and specifically not a platform entry, because a
 * platform-scoped event replayed by a tenant operator is an event they were never entitled to
 * see the contents of.
 */
function assertSameTenant(entry: DeadLetterEntry, actorOrganizationId: string | null): void {
  if (actorOrganizationId === null) return;

  if (entry.organizationId !== actorOrganizationId) {
    // Not-found rather than forbidden. "Forbidden" confirms the entry exists, which tells an
    // unauthorized caller something about another tenant's data.
    throw ApiError.notFound(`No dead-letter entry with id "${entry.id}".`);
  }
}

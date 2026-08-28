import type {
  DeadLetterEntry,
  DeadLetterFilter,
  DeadLetterStore,
  DeliveryLedger,
} from './contracts';

/**
 * In-memory implementations of the two ports.
 *
 * For tests, and for a development process where losing a dead letter on restart is fine. Not
 * for production, and the names say so rather than leaving somebody to find out.
 */

export class InMemoryDeadLetterStore implements DeadLetterStore {
  private readonly entries = new Map<string, DeadLetterEntry>();

  async record(entry: DeadLetterEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async list(filter: DeadLetterFilter): Promise<DeadLetterEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => {
        // `undefined` means "do not filter"; `null` means "platform events only" — and the
        // difference matters, so the check is `!== undefined` rather than a truthiness test.
        if (filter.organizationId !== undefined && entry.organizationId !== filter.organizationId) {
          return false;
        }
        if (filter.subscriptionId && entry.subscriptionId !== filter.subscriptionId) return false;
        if (filter.eventName && entry.eventName !== filter.eventName) return false;
        if (filter.unreplayedOnly && entry.replayedAt !== null) return false;
        return true;
      })
      .sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime())
      .slice(0, filter.limit ?? 100);
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async markReplayed(id: string, replayedById: string | null): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Updated, never deleted. A dead letter is a record of a failure that happened, and a
    // successful replay does not unmake it.
    this.entries.set(id, { ...entry, replayedAt: new Date(), replayedById });
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * An in-memory delivery ledger with a bounded size.
 *
 * The bound is the interesting part: an unbounded set of every key ever seen is a memory leak
 * with a long fuse. Oldest-first eviction means a very old duplicate could slip through, which
 * is the right trade — the duplicates that actually happen arrive seconds apart, as retries.
 */
export class InMemoryDeliveryLedger implements DeliveryLedger {
  private readonly seen = new Map<string, Date>();

  constructor(private readonly maxEntries = 100_000) {}

  async markHandled(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;

    // Single-threaded JavaScript makes this atomic between the check and the set. A database
    // implementation must not assume the same: there it is an insert against a unique
    // constraint, letting the database decide the winner.
    this.seen.set(key, new Date());

    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }

    return true;
  }

  async forgetOlderThan(cutoff: Date): Promise<number> {
    let removed = 0;
    for (const [key, at] of this.seen) {
      if (at < cutoff) {
        this.seen.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }
}

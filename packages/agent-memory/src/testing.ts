import type { MemoryEntry, MemoryQuery, MemoryScope, MemoryStore } from './memory';

/** An in-memory memory store, for tests and development. */
export class InMemoryMemoryStore implements MemoryStore {
  readonly entries = new Map<string, MemoryEntry>();

  async put(entry: MemoryEntry): Promise<MemoryEntry> {
    this.entries.set(entry.id, entry);
    return entry;
  }

  async get(id: string, organizationId: string | null): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    if (!entry || entry.organizationId !== organizationId) return null;
    return entry;
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    const search = query.search?.toLowerCase();

    return (
      [...this.entries.values()]
        // The tenant filter is first and unconditional.
        .filter((entry) => entry.organizationId === query.organizationId)
        .filter((entry) => !query.scopes || query.scopes.includes(entry.scope))
        .filter((entry) => {
          /*
           * A scoped entry only matches when its subject matches.
           *
           * A `user` entry must not come back for a different user, and a `conversation` entry must
           * not come back for a different conversation — which is the whole point of the scope.
           */
          if (entry.scope === 'user' || entry.scope === 'long_term') {
            return query.userId !== undefined && entry.userId === query.userId;
          }
          if (entry.scope === 'conversation') {
            return (
              query.conversationId !== undefined && entry.conversationId === query.conversationId
            );
          }
          if (entry.scope === 'session') {
            return query.sessionId !== undefined && entry.sessionId === query.sessionId;
          }
          // Organization scope needs no further subject: the tenant filter above is the scope.
          return true;
        })
        .filter(
          (entry) => !query.agentId || entry.agentId === null || entry.agentId === query.agentId,
        )
        .filter(
          (entry) =>
            !search ||
            entry.key.toLowerCase().includes(search) ||
            entry.value.toLowerCase().includes(search),
        )
        // Most recently used first: memory competes with the conversation for context, so the
        // things being used should win.
        .sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime())
        .slice(0, query.limit ?? 50)
    );
  }

  async delete(id: string, organizationId: string | null): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.organizationId !== organizationId) return false;
    return this.entries.delete(id);
  }

  async deleteScope(input: {
    organizationId: string | null;
    scope: MemoryScope;
    conversationId?: string;
    sessionId?: string;
    userId?: string;
  }): Promise<number> {
    let removed = 0;

    for (const [id, entry] of this.entries) {
      if (entry.organizationId !== input.organizationId) continue;
      if (entry.scope !== input.scope) continue;
      if (input.conversationId && entry.conversationId !== input.conversationId) continue;
      if (input.sessionId && entry.sessionId !== input.sessionId) continue;
      if (input.userId && entry.userId !== input.userId) continue;

      this.entries.delete(id);
      removed += 1;
    }

    return removed;
  }

  async purgeExpired(now: Date): Promise<number> {
    let removed = 0;

    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        removed += 1;
      }
    }

    return removed;
  }

  async touch(ids: string[], now: Date): Promise<void> {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.entries.set(id, { ...entry, lastAccessedAt: now, accessCount: entry.accessCount + 1 });
    }
  }
}

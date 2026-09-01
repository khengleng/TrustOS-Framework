import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import { DEFAULT_TTL_MS, MemoryService, memoryPolicySchema } from './memory';
import { InMemoryMemoryStore } from './testing';

/**
 * The tests that matter here are the tenant and subject ones.
 *
 * A memory system that recalls the wrong person's fact does not throw, does not log anything
 * unusual, and produces an answer that reads perfectly well. So the leak paths are tested
 * directly rather than inferred from the happy path working.
 */

const detailsOf = (error: unknown): string[] =>
  ((error as { details?: Array<{ message: string }> }).details ?? []).map((d) => d.message);

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function service(policy: Record<string, unknown> = {}) {
  const store = new InMemoryMemoryStore();

  const memory = new MemoryService({
    store,
    policy: memoryPolicySchema.parse({
      writableScopes: ['conversation', 'session', 'user', 'organization', 'long_term'],
      ...policy,
    }),
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { store, memory };
}

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('tenant isolation', () => {
  it('does not recall another tenant’s memory', async () => {
    const { memory } = service();

    await memory.remember({
      scope: 'organization',
      organizationId: 'org_a',
      key: 'escalation-contact',
      value: 'Sokha in operations',
    });

    expect(await memory.recall({ organizationId: 'org_b' })).toEqual([]);
    expect(await memory.recall({ organizationId: 'org_a' })).toHaveLength(1);
  });

  it('treats the platform tenant as its own tenant, not as everybody', async () => {
    // Null organization is the platform, not a wildcard. A platform memory leaking into every
    // tenant's recall is the same bug with a friendlier-looking cause.
    const { memory } = service();

    await memory.remember({
      scope: 'organization',
      organizationId: null,
      key: 'platform-note',
      value: 'Maintenance window is Sunday.',
    });

    expect(await memory.recall({ organizationId: 'org_a' })).toEqual([]);
    expect(await memory.recall({ organizationId: null })).toHaveLength(1);
  });

  it('does not return one user’s memory to another inside the same tenant', async () => {
    const { memory } = service();

    await memory.remember({
      scope: 'user',
      organizationId: 'org_a',
      userId: 'usr_1',
      key: 'language',
      value: 'Prefers Khmer.',
    });

    expect(await memory.recall({ organizationId: 'org_a', userId: 'usr_2' })).toEqual([]);
    expect(await memory.recall({ organizationId: 'org_a', userId: 'usr_1' })).toHaveLength(1);
  });

  it('does not return a user memory when no user was given', async () => {
    // The dangerous default. A recall that omits the user and gets user-scoped memories back is
    // how one customer's detail reaches another customer's answer.
    const { memory } = service();

    await memory.remember({
      scope: 'user',
      organizationId: 'org_a',
      userId: 'usr_1',
      key: 'account',
      value: 'Account ends 4471.',
    });

    expect(await memory.recall({ organizationId: 'org_a' })).toEqual([]);
  });

  it('keeps conversation memory to its conversation', async () => {
    const { memory } = service();

    await memory.remember({
      scope: 'conversation',
      organizationId: 'org_a',
      conversationId: 'conv_1',
      key: 'topic',
      value: 'A missing transfer.',
    });

    expect(await memory.recall({ organizationId: 'org_a', conversationId: 'conv_2' })).toEqual([]);
  });
});

describe('scope identifiers', () => {
  it('refuses a user memory with no user id', async () => {
    const { memory } = service();

    await expect(
      memory.remember({
        scope: 'user',
        organizationId: 'org_a',
        key: 'language',
        value: 'Prefers Khmer.',
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('says which identifier is missing', async () => {
    const { memory } = service();

    const error = await memory
      .remember({
        scope: 'conversation',
        organizationId: 'org_a',
        key: 'topic',
        value: 'x',
      })
      .catch((caught: unknown) => caught);

    expect(detailsOf(error).join(' ')).toMatch(/conversationId/);
  });
});

describe('write policy', () => {
  it('refuses a user-scope write when the policy does not allow it', async () => {
    const { memory } = service({ writableScopes: ['conversation'] });

    await expect(
      memory.remember({
        scope: 'user',
        organizationId: 'org_a',
        userId: 'usr_1',
        key: 'language',
        value: 'Prefers Khmer.',
      }),
    ).rejects.toThrow(/may not write user memory/);
  });

  it('allows reading a scope it may not write', async () => {
    // The useful asymmetry: an agent can use a user fact somebody else recorded without being
    // able to invent one.
    const writer = service({ writableScopes: ['user'] });

    await writer.memory.remember({
      scope: 'user',
      organizationId: 'org_a',
      userId: 'usr_1',
      key: 'language',
      value: 'Prefers Khmer.',
    });

    const reader = new MemoryService({
      store: writer.store,
      policy: memoryPolicySchema.parse({ writableScopes: ['conversation'] }),
      now: () => clock,
    });

    expect(await reader.recall({ organizationId: 'org_a', userId: 'usr_1' })).toHaveLength(1);
  });

  it('refuses to store personal data when the policy says so', async () => {
    const { memory } = service({ writableScopes: ['conversation'], rejectPii: true });

    const withDetector = new MemoryService({
      store: new InMemoryMemoryStore(),
      policy: memoryPolicySchema.parse({ writableScopes: ['conversation'], rejectPii: true }),
      detectPii: () => ({ found: true, types: ['card number'] }),
      now: () => clock,
    });

    await expect(
      withDetector.remember({
        scope: 'conversation',
        organizationId: 'org_a',
        conversationId: 'conv_1',
        key: 'card',
        value: '4111 1111 1111 1111',
      }),
    ).rejects.toThrow(/cannot be stored/);

    // Without a detector wired, the policy flag cannot act — and does not pretend to.
    await expect(
      memory.remember({
        scope: 'conversation',
        organizationId: 'org_a',
        conversationId: 'conv_1',
        key: 'card',
        value: '4111 1111 1111 1111',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('expiry', () => {
  it('gives every scope a default lifetime', async () => {
    const { memory } = service();

    const entry = await memory.remember({
      scope: 'conversation',
      organizationId: 'org_a',
      conversationId: 'conv_1',
      key: 'topic',
      value: 'x',
    });

    expect(entry.expiresAt.getTime()).toBe(clock.getTime() + DEFAULT_TTL_MS.conversation);
  });

  it('does not recall an expired memory even before it is purged', async () => {
    // Purging is a background job. Recall cannot depend on it having run.
    const { memory, store } = service();

    await memory.remember({
      scope: 'conversation',
      organizationId: 'org_a',
      conversationId: 'conv_1',
      key: 'topic',
      value: 'x',
      ttlMs: 1000,
    });

    clock = new Date(clock.getTime() + 5000);

    expect(await memory.recall({ organizationId: 'org_a', conversationId: 'conv_1' })).toEqual([]);
    // Still stored — recall filtered it, the store did not lose it.
    expect(store.entries.size).toBe(1);

    expect(await memory.purgeExpired()).toBe(1);
    expect(store.entries.size).toBe(0);
  });
});

describe('bounds', () => {
  it('evicts the least recently used when a scope is full', async () => {
    const { memory } = service({ maxEntriesPerScope: 3 });

    for (const key of ['a', 'b', 'c']) {
      await memory.remember({
        scope: 'conversation',
        organizationId: 'org_a',
        conversationId: 'conv_1',
        key,
        value: key,
      });
      clock = new Date(clock.getTime() + 1000);
    }

    // Touches 'a', making 'b' the oldest use.
    await memory.recall({ organizationId: 'org_a', conversationId: 'conv_1', search: 'a' });
    clock = new Date(clock.getTime() + 1000);

    await memory.remember({
      scope: 'conversation',
      organizationId: 'org_a',
      conversationId: 'conv_1',
      key: 'd',
      value: 'd',
    });

    const remaining = (
      await memory.recall({ organizationId: 'org_a', conversationId: 'conv_1', limit: 50 })
    ).map((entry) => entry.key);

    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain('b');
  });

  it('bounds a recall to the policy limit', async () => {
    const { memory } = service({ maxRecall: 2 });

    for (const key of ['a', 'b', 'c', 'd']) {
      await memory.remember({
        scope: 'conversation',
        organizationId: 'org_a',
        conversationId: 'conv_1',
        key,
        value: key,
      });
    }

    expect(await memory.recall({ organizationId: 'org_a', conversationId: 'conv_1' })).toHaveLength(
      2,
    );
  });
});

describe('formatting', () => {
  it('marks an inferred memory as inferred', async () => {
    // A model given a flat list asserts an inference as a fact.
    const { memory } = service();

    const entries = [
      await memory.remember({
        scope: 'conversation',
        organizationId: 'org_a',
        conversationId: 'conv_1',
        key: 'language',
        value: 'Prefers Khmer.',
        confidence: 'inferred',
      }),
      await memory.remember({
        scope: 'conversation',
        organizationId: 'org_a',
        conversationId: 'conv_1',
        key: 'name',
        value: 'Called Dara.',
        confidence: 'stated',
      }),
    ];

    const formatted = memory.format(entries);

    expect(formatted).toMatch(/Prefers Khmer\.\s*\(inferred, may be wrong\)/);
    expect(formatted).toMatch(/Called Dara\.$/m);
  });

  it('returns nothing for no memories, rather than an empty heading', async () => {
    const { memory } = service();
    expect(memory.format([])).toBe('');
  });
});

describe('forgetting', () => {
  it('forgets a conversation without touching another', async () => {
    const { memory } = service();

    for (const conversationId of ['conv_1', 'conv_2']) {
      await memory.remember({
        scope: 'conversation',
        organizationId: 'org_a',
        conversationId,
        key: 'topic',
        value: conversationId,
      });
    }

    expect(await memory.forgetConversation('conv_1', 'org_a')).toBe(1);
    expect(await memory.recall({ organizationId: 'org_a', conversationId: 'conv_2' })).toHaveLength(
      1,
    );
  });

  it('does not forget on behalf of another tenant', async () => {
    const { memory, store } = service();

    await memory.remember({
      scope: 'conversation',
      organizationId: 'org_a',
      conversationId: 'conv_1',
      key: 'topic',
      value: 'x',
    });

    expect(await memory.forgetConversation('conv_1', 'org_b')).toBe(0);
    expect(store.entries.size).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildEvent, type EventActor } from '@trustsystem/event-sdk';
import { EventRegistry, findSchemaConflicts, type EventSchemaDefinition } from './registry';
import { STANDARD_EVENTS, STANDARD_EVENT_NAMES } from './standard-events';

const actor: EventActor = { id: 'usr_1', type: 'user', roles: [] };

function event(name: string, version: string, payload: unknown) {
  return buildEvent({
    name,
    version,
    payload,
    organizationId: 'org_1',
    actor,
    source: 'test-app',
  });
}

const userCreated: EventSchemaDefinition = {
  name: 'test.user.created',
  version: '1',
  description: 'A test user was created.',
  payload: z.object({ userId: z.string(), email: z.string().email() }).strict(),
};

function messagesOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const details = (error as { details?: Array<{ path: string; message: string }> }).details ?? [];
    // The path is joined in too: it is what names the offending field, and a message alone
    // ("Required") is not something a publisher can act on.
    return [
      (error as Error).message,
      ...details.map((entry) => `${entry.path}: ${entry.message}`),
    ].join(' | ');
  }
  throw new Error('Expected the call to throw, and it did not.');
}

describe('registration', () => {
  it('refuses a duplicate name and version rather than letting import order decide', () => {
    const registry = new EventRegistry([userCreated]);

    expect(messagesOf(() => registry.register(userCreated))).toMatch(/already registered/);
  });

  it('allows two versions of one event side by side', () => {
    const registry = new EventRegistry([
      userCreated,
      { ...userCreated, version: '2', payload: z.object({ userId: z.string() }).strict() },
    ]);

    expect(registry.size).toBe(2);
    expect(registry.latestVersion('test.user.created')).toBe('2');
  });

  it('tracks the highest version numerically, not alphabetically', () => {
    // '10' sorts before '9' as a string. A registry that got this wrong would send every
    // publisher that omits a version to the wrong schema once an event reached ten versions.
    const registry = new EventRegistry([
      { ...userCreated, version: '9' },
      { ...userCreated, version: '10' },
    ]);

    expect(registry.latestVersion('test.user.created')).toBe('10');
  });

  it('rejects an invalid event name', () => {
    const registry = new EventRegistry();

    expect(
      messagesOf(() => registry.register({ ...userCreated, name: 'TestUserCreated' })),
    ).toMatch(/lowercase/);
  });

  it.each(['1.0', 'v1', 'one', ''])('rejects the version %j', (version) => {
    const registry = new EventRegistry();
    expect(() => registry.register({ ...userCreated, version })).toThrow();
  });

  it('rejects an example that does not satisfy its own schema', () => {
    const registry = new EventRegistry();

    expect(
      messagesOf(() =>
        registry.register({ ...userCreated, example: { userId: 'usr_1', email: 'not-an-email' } }),
      ),
    ).toMatch(/does not satisfy its own schema/);
  });

  it('accepts a valid example', () => {
    const registry = new EventRegistry();

    expect(() =>
      registry.register({ ...userCreated, example: { userId: 'usr_1', email: 'a@b.com' } }),
    ).not.toThrow();
  });
});

describe('validation', () => {
  it('refuses an unregistered event and says what to do', () => {
    const registry = new EventRegistry([userCreated]);

    expect(messagesOf(() => registry.validate(event('test.unknown.thing', '1', {})))).toMatch(
      /not registered is never published/,
    );
  });

  it('lists the registered versions when only the version is wrong', () => {
    const registry = new EventRegistry([userCreated, { ...userCreated, version: '2' }]);

    // The usual cause of "unknown event" is a version mismatch, not a typo — so the message
    // names the versions rather than sending somebody to grep a name they spelled correctly.
    expect(messagesOf(() => registry.validate(event('test.user.created', '3', {})))).toMatch(
      /Registered: 1, 2/,
    );
  });

  it('refuses a payload that does not match, naming the field', () => {
    const registry = new EventRegistry([userCreated]);

    expect(
      messagesOf(() => registry.validate(event('test.user.created', '1', { userId: 'usr_1' }))),
    ).toMatch(/payload\.email/);
  });

  it('refuses an unknown payload field, so a rename is caught at the publisher', () => {
    const registry = new EventRegistry([userCreated]);

    expect(() =>
      registry.validate(
        event('test.user.created', '1', { userId: 'u', email: 'a@b.com', extra: 1 }),
      ),
    ).toThrow();
  });

  it('returns the parsed payload, so defaults reach the consumer', () => {
    const registry = new EventRegistry([
      {
        ...userCreated,
        payload: z.object({ userId: z.string(), active: z.boolean().default(true) }),
      },
    ]);

    const validated = registry.validate(event('test.user.created', '1', { userId: 'usr_1' }));

    expect((validated.payload as { active: boolean }).active).toBe(true);
  });

  it('does not mutate the envelope it was given', () => {
    const registry = new EventRegistry([userCreated]);
    const original = event('test.user.created', '1', { userId: 'u', email: 'a@b.com' });
    const before = JSON.stringify(original);

    registry.validate(original);

    expect(JSON.stringify(original)).toBe(before);
  });
});

describe('warnings', () => {
  it('warns on a deprecated version but still validates it', () => {
    // Refusing would break a running consumer at the moment somebody marked it deprecated —
    // which is exactly when nothing should break.
    const registry = new EventRegistry([
      { ...userCreated, stability: 'deprecated', supersededBy: '2' },
      { ...userCreated, version: '2' },
    ]);

    const envelope = event('test.user.created', '1', { userId: 'u', email: 'a@b.com' });

    expect(() => registry.validate(envelope)).not.toThrow();
    expect(registry.warningsFor(envelope).join(' ')).toMatch(/deprecated.*use version 2/);
  });

  it('warns when a newer version exists', () => {
    const registry = new EventRegistry([userCreated, { ...userCreated, version: '2' }]);
    const envelope = event('test.user.created', '1', { userId: 'u', email: 'a@b.com' });

    expect(registry.warningsFor(envelope).join(' ')).toMatch(/newer version/);
  });

  it('warns that an experimental event may change', () => {
    const registry = new EventRegistry([{ ...userCreated, stability: 'experimental' }]);
    const envelope = event('test.user.created', '1', { userId: 'u', email: 'a@b.com' });

    expect(registry.warningsFor(envelope).join(' ')).toMatch(/experimental/);
  });

  it('says nothing about the current stable version', () => {
    const registry = new EventRegistry([userCreated]);
    const envelope = event('test.user.created', '1', { userId: 'u', email: 'a@b.com' });

    expect(registry.warningsFor(envelope)).toEqual([]);
  });
});

describe('unregister', () => {
  it('moves the latest pointer back rather than leaving it dangling', () => {
    const registry = new EventRegistry([userCreated, { ...userCreated, version: '2' }]);

    registry.unregister('test.user.created', '2');

    expect(registry.latestVersion('test.user.created')).toBe('1');
  });

  it('clears the pointer when the last version goes', () => {
    const registry = new EventRegistry([userCreated]);

    registry.unregister('test.user.created', '1');

    expect(registry.latestVersion('test.user.created')).toBeNull();
    expect(registry.has('test.user.created')).toBe(false);
  });
});

describe('the catalog', () => {
  it('marks exactly one version of each event as latest', () => {
    const registry = new EventRegistry([userCreated, { ...userCreated, version: '2' }]);
    const latest = registry.describeCatalog().filter((entry) => entry.isLatest);

    expect(latest).toHaveLength(1);
    expect(latest[0]?.version).toBe('2');
  });

  it('sorts by name then by version numerically', () => {
    const registry = new EventRegistry([
      { ...userCreated, name: 'test.b.happened', version: '10' },
      { ...userCreated, name: 'test.b.happened', version: '2' },
      { ...userCreated, name: 'test.a.happened' },
    ]);

    expect(registry.describeCatalog().map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      'test.a.happened@1',
      'test.b.happened@2',
      'test.b.happened@10',
    ]);
  });
});

describe('findSchemaConflicts', () => {
  it('reports every conflict at once rather than one per restart', () => {
    const conflicts = findSchemaConflicts([
      { source: 'billing', definitions: [userCreated, { ...userCreated, name: 'test.a.b' }] },
      { source: 'crm', definitions: [userCreated] },
    ]);

    expect(conflicts).toEqual([{ event: 'test.user.created@1', sources: ['billing', 'crm'] }]);
  });

  it('is empty when two modules define different events', () => {
    expect(
      findSchemaConflicts([
        { source: 'a', definitions: [userCreated] },
        { source: 'b', definitions: [{ ...userCreated, version: '2' }] },
      ]),
    ).toEqual([]);
  });
});

describe('the standard events', () => {
  it('all register without conflict', () => {
    const registry = new EventRegistry(STANDARD_EVENTS);

    expect(registry.size).toBe(STANDARD_EVENTS.length);
  });

  it('carries no business event, because those belong to the product', () => {
    const forbidden = ['payment', 'ledger', 'settlement', 'loan', 'merchant', 'khqr', 'bakong'];

    for (const name of STANDARD_EVENT_NAMES) {
      for (const term of forbidden) {
        expect(name.toLowerCase()).not.toContain(term);
      }
    }
  });

  it('names every event in the past tense of something that happened', () => {
    // A name in the imperative is a command masquerading as an event, and that is how a bus
    // turns into an RPC mechanism nobody intended.
    const imperative = /\.(create|update|delete|send|process|handle|do)$/;

    for (const name of STANDARD_EVENT_NAMES) {
      expect(name).not.toMatch(imperative);
    }
  });

  it('scopes every payload to an organization', () => {
    // A tenant event the bus cannot scope is one it cannot safely deliver.
    const registry = new EventRegistry(STANDARD_EVENTS);

    for (const entry of registry.describeCatalog()) {
      const schema = registry.get(entry.name, entry.version);
      const shape = (schema.payload as unknown as { shape?: Record<string, unknown> }).shape ?? {};

      expect(Object.keys(shape)).toContain('organizationId');
    }
  });

  it('refuses a payload carrying a secret-looking field name', () => {
    // A structural guard on the catalog itself: no standard event should have a field that the
    // redactor would strip, because an event that needs redacting is one carrying the wrong data.
    const banned = /password|secret|token(?!Id)|credential|privatekey|apikey(?!id)/i;
    const registry = new EventRegistry(STANDARD_EVENTS);

    for (const entry of registry.describeCatalog()) {
      const schema = registry.get(entry.name, entry.version);
      const shape = (schema.payload as unknown as { shape?: Record<string, unknown> }).shape ?? {};

      for (const field of Object.keys(shape)) {
        expect(field, `${entry.name} carries "${field}"`).not.toMatch(banned);
      }
    }
  });

  it('validates its own examples', () => {
    const registry = new EventRegistry(STANDARD_EVENTS);

    for (const entry of registry.describeCatalog()) {
      if (entry.example === null) continue;
      const schema = registry.get(entry.name, entry.version);

      expect(schema.payload.safeParse(entry.example).success).toBe(true);
    }
  });
});

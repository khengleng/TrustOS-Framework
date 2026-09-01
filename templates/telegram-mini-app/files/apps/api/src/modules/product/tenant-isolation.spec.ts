import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import type { ApiError } from '@trustsystem/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { ProductService } from './product.service';
import { validateInitData } from './telegram-init-data';

/**
 * Isolation tests plus the initData validation suite.
 *
 * `validateInitData` is the entire authentication boundary of a Mini App, so
 * its negative cases matter more than its positive one. Each test below maps
 * to a way real Mini Apps have been broken.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';
const BOT_TOKEN = '123456:TEST-BOT-TOKEN-not-a-real-one';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

/** Builds correctly signed initData, the way Telegram would. */
function signInitData(params: Record<string, string>, botToken: string = BOT_TOKEN): string {
  const pairs = Object.entries(params)
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');

  const search = new URLSearchParams(params);
  search.set('hash', hash);
  return search.toString();
}

function launchParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAEtest',
    user: JSON.stringify({ id: 987654321, first_name: 'Ada', username: 'ada' }),
    ...overrides,
  };
}

function buildService(): { service: ProductService; sink: InMemoryAuditSink } {
  const prisma = {
    telegramProfile: new FakeModelDelegate([
      {
        id: 'tp_acme',
        organizationId: ACME,
        telegramUserId: '111',
        userId: 'user_1',
        username: 'acme_user',
        firstName: 'Acme',
        languageCode: 'en',
        lastSeenAt: null,
        ...timestamps,
      },
      {
        id: 'tp_rival',
        organizationId: RIVAL,
        telegramUserId: '222',
        userId: 'user_2',
        username: 'rival_user',
        firstName: 'Rival',
        languageCode: 'en',
        lastSeenAt: null,
        ...timestamps,
      },
    ]),
    task: new FakeModelDelegate([
      {
        id: 'task_acme',
        organizationId: ACME,
        telegramProfileId: 'tp_acme',
        title: 'Acme task',
        status: 'TODO',
        completedAt: null,
        ...timestamps,
      },
      {
        id: 'task_rival',
        organizationId: RIVAL,
        telegramProfileId: 'tp_rival',
        title: 'Rival task',
        status: 'TODO',
        completedAt: null,
        ...timestamps,
      },
    ]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new ProductService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

describe('mini app tenant isolation', () => {
  let service: ProductService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization profiles and tasks', async () => {
    expect((await asAcme(() => service.listProfiles())).map((row) => row.username)).toEqual([
      'acme_user',
    ]);
    expect((await asAcme(() => service.listTasks())).map((row) => row.title)).toEqual([
      'Acme task',
    ]);
  });

  it('refuses to create a task against another organization profile', async () => {
    await expect(
      asAcme(() => service.createTask({ telegramProfileId: 'tp_rival', title: 'Sneaky' }, ACME)),
    ).rejects.toThrow();
  });

  it('reports another organization task as not_found', async () => {
    try {
      await asAcme(() => service.updateTaskStatus('task_rival', 'DONE', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('refuses to read tasks for another organization profile', async () => {
    await expect(asAcme(() => service.tasksForProfile('tp_rival', ACME))).rejects.toThrow();
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(service.listTasks()).rejects.toThrow(/Organization context is required/);
  });

  it('audits mutations and never writes initData into the trail', async () => {
    const initData = signInitData(launchParams());
    await asAcme(() => service.openSession(initData, BOT_TOKEN, ACME, 'user_1'));

    const serialized = JSON.stringify(sink.records);
    expect(serialized).not.toContain('hash=');
    expect(serialized).not.toContain(initData);
    expect(sink.records.every((record) => record.organizationId === ACME)).toBe(true);
  });
});

describe('validateInitData', () => {
  it('accepts correctly signed, fresh launch data', () => {
    const result = validateInitData(signInitData(launchParams()), { botToken: BOT_TOKEN });

    expect(result.user.id).toBe('987654321');
    expect(result.user.username).toBe('ada');
    expect(result.user.isPremium).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const initData = signInitData(launchParams());
    // Swap the user for someone else, keeping the original signature.
    const tampered = initData.replace(
      encodeURIComponent(JSON.stringify({ id: 987654321, first_name: 'Ada', username: 'ada' })),
      encodeURIComponent(JSON.stringify({ id: 1, first_name: 'Mallory', username: 'mallory' })),
    );

    expect(() => validateInitData(tampered, { botToken: BOT_TOKEN })).toThrowError(
      /signature is invalid/,
    );
  });

  it('rejects data signed with a different bot token', () => {
    const initData = signInitData(launchParams(), '999999:SOMEONE-ELSES-TOKEN');
    expect(() => validateInitData(initData, { botToken: BOT_TOKEN })).toThrowError(
      /signature is invalid/,
    );
  });

  it('rejects an unsigned payload', () => {
    const search = new URLSearchParams(launchParams());
    expect(() => validateInitData(search.toString(), { botToken: BOT_TOKEN })).toThrowError(
      /not signed/,
    );
  });

  it('rejects empty initData', () => {
    expect(() => validateInitData('', { botToken: BOT_TOKEN })).toThrowError(/Missing/);
  });

  it('rejects a stale launch, so a captured URL is not a permanent credential', () => {
    const dayOld = String(Math.floor(Date.now() / 1000) - 60 * 60 * 25);
    const initData = signInitData(launchParams({ auth_date: dayOld }));

    expect(() => validateInitData(initData, { botToken: BOT_TOKEN })).toThrowError(/expired/);
  });

  it('honours a custom maximum age', () => {
    const tenMinutesAgo = String(Math.floor(Date.now() / 1000) - 600);
    const initData = signInitData(launchParams({ auth_date: tenMinutesAgo }));

    expect(() => validateInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 300 })).toThrow();
    expect(() =>
      validateInitData(initData, { botToken: BOT_TOKEN, maxAgeSeconds: 900 }),
    ).not.toThrow();
  });

  it('rejects a launch stamped far in the future', () => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const initData = signInitData(launchParams({ auth_date: future }));

    expect(() => validateInitData(initData, { botToken: BOT_TOKEN })).toThrowError(/future/);
  });

  it('rejects a payload with no auth_date at all', () => {
    const params = launchParams();
    delete (params as Record<string, string>).auth_date;
    const initData = signInitData(params);

    expect(() => validateInitData(initData, { botToken: BOT_TOKEN })).toThrowError(/auth_date/);
  });

  it('rejects a payload with no user, or an unparseable one', () => {
    const noUser = launchParams();
    delete (noUser as Record<string, string>).user;
    expect(() => validateInitData(signInitData(noUser), { botToken: BOT_TOKEN })).toThrowError(
      /no user/,
    );

    const badUser = signInitData(launchParams({ user: 'not-json' }));
    expect(() => validateInitData(badUser, { botToken: BOT_TOKEN })).toThrowError(/valid JSON/);
  });

  it('keeps the Telegram id exact, beyond the safe integer range', () => {
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2; parsing it as a number
    // would silently round it and authenticate the wrong account.
    const bigId = '9007199254740993';
    const initData = signInitData(launchParams({ user: `{"id":${bigId},"first_name":"Big"}` }));

    expect(validateInitData(initData, { botToken: BOT_TOKEN }).user.id).toBe(bigId);
  });

  it('is not confused by parameter order', () => {
    // Telegram does not promise an order; the check string is sorted, so a
    // reordered payload must still validate.
    const params = launchParams();
    const reordered = Object.fromEntries(Object.entries(params).reverse());

    expect(() => validateInitData(signInitData(reordered), { botToken: BOT_TOKEN })).not.toThrow();
  });
});

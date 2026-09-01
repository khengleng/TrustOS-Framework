import { describe, expect, it, vi } from 'vitest';
import { consoleCatalogFor, type InternalApplication } from '@trustos/governance-tool-core';
import type { PrismaService } from '@trustos/database';
import type { LoggerPort } from '@trustos/logging';
import { PersistentAppCatalog } from './persistent-app-catalog';

/**
 * A stand-in for the one Prisma model this class touches.
 *
 * Deliberately enforces the unique constraint, because the constraint is the control: without it
 * the conflict path here would pass while the real table rejected the write, and the test would
 * be asserting the absence of a guard rather than its presence.
 */
function fakePrisma(
  seedRows: Array<{ appId: string; environment: string; definition: unknown }> = [],
) {
  const rows = [...seedRows];

  const prisma = {
    internalApplication: {
      findMany: vi.fn(async ({ where }: { where: { environment: string } }) =>
        rows
          .filter((row) => row.environment === where.environment)
          .sort((left, right) => left.appId.localeCompare(right.appId)),
      ),
      create: vi.fn(async ({ data }: { data: (typeof rows)[number] }) => {
        const clash = rows.some(
          (row) => row.environment === data.environment && row.appId === data.appId,
        );
        if (clash) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        rows.push(data);
        return data;
      }),
    },
  };

  return { prisma: prisma as unknown as PrismaService, rows };
}

function fakeLogger(): LoggerPort {
  const logger: LoggerPort = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return logger;
}

const seedFor = (environment: 'dev' | 'prod'): InternalApplication[] =>
  consoleCatalogFor(environment).list(environment);

describe('PersistentAppCatalog', () => {
  it('seeds an empty environment and records every seeded application', async () => {
    const { prisma, rows } = fakePrisma();
    const seed = seedFor('dev');

    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed,
      logger: fakeLogger(),
    });

    expect(rows).toHaveLength(seed.length);
    expect(catalog.size()).toBe(seed.length);
    expect(catalog.list('dev').map((app) => app.appId)).toEqual(
      seed.map((app) => app.appId).sort((left, right) => left.localeCompare(right)),
    );
  });

  it('loads from the table instead of reseeding when rows already exist', async () => {
    const seed = seedFor('dev');
    const stored = seed.slice(0, 2).map((app) => ({
      appId: app.appId,
      environment: 'dev',
      definition: app as unknown,
    }));
    const { prisma, rows } = fakePrisma(stored);

    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed,
      logger: fakeLogger(),
    });

    // Two rows in, two applications out — the seed is not applied over existing state.
    expect(rows).toHaveLength(2);
    expect(catalog.size()).toBe(2);
  });

  it('reads only its own environment', async () => {
    const dev = seedFor('dev');
    const stored = [
      { appId: dev[0].appId, environment: 'dev', definition: dev[0] as unknown },
      { appId: dev[1].appId, environment: 'prod', definition: dev[1] as unknown },
    ];
    const { prisma } = fakePrisma(stored);

    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed: [],
      logger: fakeLogger(),
    });

    expect(catalog.size()).toBe(1);
    expect(catalog.find('dev', dev[0].appId)).toBeDefined();
  });

  it('refuses a stored definition that no longer validates, and says which', async () => {
    const dev = seedFor('dev');
    const stored = [
      { appId: dev[0].appId, environment: 'dev', definition: dev[0] as unknown },
      { appId: 'corrupted', environment: 'dev', definition: { appId: 'corrupted' } },
    ];
    const { prisma } = fakePrisma(stored);
    const logger = fakeLogger();

    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed: [],
      logger,
    });

    // The good row still loads — one bad definition must not take the gateway down with it.
    expect(catalog.size()).toBe(1);
    expect(catalog.find('dev', 'corrupted')).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: ['corrupted'] }),
      expect.stringContaining('no longer validate'),
    );
  });

  it('records an application before serving it', async () => {
    const { prisma, rows } = fakePrisma();
    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed: [],
      logger: fakeLogger(),
    });

    const draft = { ...seedFor('dev')[0], appId: 'new-console' };
    const created = await catalog.create(draft);

    expect(created.appId).toBe('new-console');
    expect(rows.map((row) => row.appId)).toContain('new-console');
    expect(catalog.find('dev', 'new-console')).toBeDefined();
  });

  it('does not serve an application whose row could not be written', async () => {
    const { prisma } = fakePrisma();
    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed: [],
      logger: fakeLogger(),
    });

    vi.mocked(prisma.internalApplication.create).mockRejectedValueOnce(new Error('disk on fire'));

    const draft = { ...seedFor('dev')[0], appId: 'never-stored' };
    await expect(catalog.create(draft)).rejects.toThrow('disk on fire');

    // The defect this class exists to remove: servable but not recorded.
    expect(catalog.find('dev', 'never-stored')).toBeUndefined();
  });

  it('reports a duplicate as a conflict rather than a raw database error', async () => {
    const { prisma } = fakePrisma();
    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed: [],
      logger: fakeLogger(),
    });

    const draft = { ...seedFor('dev')[0], appId: 'twice' };
    await catalog.create(draft);

    await expect(catalog.create(draft)).rejects.toThrow(/already registered/);
  });

  it('refuses an application declaring another environment', async () => {
    const { prisma } = fakePrisma();
    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed: [],
      logger: fakeLogger(),
    });

    const prodDraft = seedFor('prod')[0];
    await expect(catalog.create(prodDraft)).rejects.toThrow(/promotion/);
  });

  it('refuses the in-memory register once built, naming the durable method instead', async () => {
    const { prisma } = fakePrisma();
    const catalog = await PersistentAppCatalog.load({
      prisma,
      environment: 'dev',
      seed: [],
      logger: fakeLogger(),
    });

    expect(() => catalog.register(seedFor('dev')[0])).toThrow(/create\(\)/);
  });

  it('tolerates another container seeding the same environment concurrently', async () => {
    const { prisma } = fakePrisma();
    const seed = seedFor('dev');

    // Every seed write loses the race. Start-up must still succeed.
    vi.mocked(prisma.internalApplication.create).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(
      PersistentAppCatalog.load({ prisma, environment: 'dev', seed, logger: fakeLogger() }),
    ).resolves.toBeInstanceOf(PersistentAppCatalog);
  });

  it('does not swallow a seed failure that is not a constraint collision', async () => {
    const { prisma } = fakePrisma();
    vi.mocked(prisma.internalApplication.create).mockRejectedValue(new Error('connection refused'));

    await expect(
      PersistentAppCatalog.load({
        prisma,
        environment: 'dev',
        seed: seedFor('dev'),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow('connection refused');
  });
});

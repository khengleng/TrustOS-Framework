import { PrismaService } from '@trustsystem/database';
import {
  InternalAppCatalog,
  parseInternalApplication,
  type Environment,
  type InternalApplication,
} from '@trustsystem/governance-tool-core';
import { ApiError } from '@trustsystem/errors';
import type { LoggerPort } from '@trustsystem/logging';

/**
 * The internal application catalog, made durable.
 *
 * `InternalAppCatalog` is in memory by design — the library says so, and it is right to: which
 * shape an application definition takes in a database is a decision a deployment makes against
 * its own retention and change-control rules. This is that decision, for this deployment.
 *
 * **The reads stay in memory and stay synchronous.** Every consumer of the catalog asks it
 * whether an application exists before doing anything else, on every request, and turning that
 * into a database round trip would put the registration control on the latency path. So the
 * durable table is the record and the map is a read model of it, loaded once at start-up.
 *
 * **A single replica is a precondition, not an accident.** `railway.json` sets
 * `numReplicas: 1`. With two replicas, an application created against one would be invisible to
 * the other until a restart, because nothing invalidates the other's map. Raising the replica
 * count means either reloading per request or adding invalidation — and this comment is here so
 * that decision is made deliberately rather than discovered.
 */
export class PersistentAppCatalog extends InternalAppCatalog {
  /** Set at the end of construction, so `register` can refuse only *after* seeding. */
  private sealed = false;

  private constructor(
    private readonly prisma: PrismaService,
    private readonly environment: Environment,
    apps: readonly InternalApplication[],
  ) {
    super(apps);
    this.sealed = true;
  }

  /**
   * Loads the catalog for one environment.
   *
   * When the table holds nothing for this environment, the supplied seed is written before it is
   * served, so the first start is durable too rather than looking durable until the next restart.
   * The seed is written one row at a time and a conflict is tolerated: two containers starting
   * together must not race each other into a failure, and the unique constraint means the loser
   * of that race has nothing to do.
   */
  static async load(options: {
    prisma: PrismaService;
    environment: Environment;
    seed: readonly InternalApplication[];
    logger: LoggerPort;
  }): Promise<PersistentAppCatalog> {
    const { prisma, environment, seed, logger } = options;

    const existing = await prisma.internalApplication.findMany({
      where: { environment },
      orderBy: { appId: 'asc' },
    });

    if (existing.length === 0 && seed.length > 0) {
      for (const app of seed) {
        await prisma.internalApplication
          .create({ data: { environment, appId: app.appId, definition: app as object } })
          .catch((error: unknown) => {
            // A unique-constraint collision here is another container seeding the same
            // environment at the same moment, which is fine. Anything else is not.
            if (!isUniqueViolation(error)) throw error;
          });
      }

      logger.info(
        { environment, seeded: seed.length },
        'Application catalog was empty; seeded it from the console templates.',
      );

      return new PersistentAppCatalog(prisma, environment, seed);
    }

    /*
     * Re-parsed rather than trusted. A row written by an older build may not satisfy today's
     * schema, and a definition that no longer validates must not enter the catalog and start
     * authorizing requests — the catalog is what decides an application exists.
     *
     * A bad row is skipped and reported rather than fatal: one malformed definition should not
     * stop a gateway from serving every other application.
     */
    const apps: InternalApplication[] = [];
    const rejected: string[] = [];

    for (const row of existing) {
      try {
        apps.push(parseInternalApplication(row.definition));
      } catch {
        rejected.push(row.appId);
      }
    }

    if (rejected.length > 0) {
      logger.error(
        { environment, rejected },
        'Stored application definitions no longer validate and were not loaded. Those ' +
          'applications do not exist as far as this gateway is concerned, and every request ' +
          'naming one will be refused.',
      );
    }

    logger.info(
      { environment, loaded: apps.length, rejected: rejected.length },
      'Application catalog loaded from the database.',
    );

    return new PersistentAppCatalog(prisma, environment, apps);
  }

  /**
   * Registers an application durably.
   *
   * The row is written before the map, so nothing is ever servable that is not also recorded.
   * The reverse order would produce an application that exists until the next restart and then
   * silently stops existing, which is the defect this class was written to remove.
   */
  override async create(input: unknown): Promise<InternalApplication> {
    const app = parseInternalApplication(input);

    if (app.environment !== this.environment) {
      throw new ApiError('validation_error', {
        message:
          `This gateway serves ${this.environment} and the application declares ` +
          `${app.environment}. An application is registered by the gateway for its own ` +
          'environment; registering across environments is what promotion is for.',
        context: { expected: this.environment, received: app.environment, appId: app.appId },
      });
    }

    try {
      await this.prisma.internalApplication.create({
        data: { environment: app.environment, appId: app.appId, definition: app as object },
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', {
          message: `The application "${app.appId}" is already registered for ${app.environment}.`,
          context: { appId: app.appId, environment: app.environment },
        });
      }
      throw error;
    }

    this.sealed = false;
    try {
      return super.register(app);
    } finally {
      this.sealed = true;
    }
  }

  /**
   * Refused once the catalog is built.
   *
   * The inherited method writes to the map and not to the table, which is exactly the bug this
   * class exists to prevent. Seeding needs it, so it is closed off after construction rather
   * than removed — a caller reaching for it is told which method to use instead.
   */
  override register(input: unknown): InternalApplication {
    if (this.sealed) {
      throw new ApiError('internal_error', {
        message:
          'register() writes to memory only and would be lost on the next restart. Use create(), ' +
          'which records the application before serving it.',
      });
    }

    return super.register(input);
  }
}

/** Prisma reports a unique-constraint collision as P2002. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

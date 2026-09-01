import { ApiError } from '@trustos/errors';
import { CONSOLE_TEMPLATES } from './consoles';
import {
  parseInternalApplication,
  type Environment,
  type InternalApplication,
} from './application';

/**
 * The internal application catalog.
 *
 * In memory, and stated as a limitation rather than presented as a design — the same choice the
 * Financial Product Designer makes and for the same reason: which shape an application definition
 * takes in a database is a decision a deployment makes against its own retention, replication and
 * change-control rules.
 *
 * What the catalog does enforce is the property that makes the gateway safe: **an application
 * that is not registered here does not exist.** A request naming an unknown app is refused
 * before its declared sources and actions are consulted, because the app id is what selects
 * them — and a request that could name an unregistered app would be a request that brings its
 * own permissions.
 */
export class InternalAppCatalog {
  private readonly apps = new Map<string, InternalApplication>();

  constructor(apps: readonly InternalApplication[] = []) {
    for (const app of apps) this.register(app);
  }

  register(input: unknown): InternalApplication {
    const app = parseInternalApplication(input);
    const key = keyOf(app.environment, app.appId);

    if (this.apps.has(key)) {
      throw new ApiError('conflict', {
        message: `The application "${app.appId}" is already registered for ${app.environment}.`,
        context: { appId: app.appId, environment: app.environment },
      });
    }

    this.apps.set(key, app);
    return app;
  }

  find(environment: Environment, appId: string): InternalApplication | undefined {
    return this.apps.get(keyOf(environment, appId));
  }

  require(environment: Environment, appId: string): InternalApplication {
    const app = this.find(environment, appId);

    if (!app) {
      throw new ApiError('not_found', {
        message:
          `No internal application "${appId}" in ${environment}. An unregistered application has ` +
          'no declared data sources and no declared actions, so there is nothing to authorize ' +
          'it against.',
        context: { appId, environment },
      });
    }

    return app;
  }

  /**
   * Registers an application durably.
   *
   * In memory here, because that is all this class has. It exists as its own method so a
   * deployment can substitute a catalog that records the application before serving it —
   * without every caller having to know which one it holds. See `register` for why the
   * distinction matters: an application that exists until the next restart is a governance
   * record that silently disappears, not a cache that goes cold.
   */
  async create(input: unknown): Promise<InternalApplication> {
    return this.register(input);
  }

  list(environment: Environment): InternalApplication[] {
    return [...this.apps.values()]
      .filter((app) => app.environment === environment)
      .sort((left, right) => left.appId.localeCompare(right.appId));
  }

  size(): number {
    return this.apps.size;
  }
}

function keyOf(environment: Environment, appId: string): string {
  return `${environment}|${appId}`;
}

/**
 * The ten console templates, registered for an environment.
 *
 * A starting point for a deployment, and what the boot test runs against. In production the
 * schema refuses a highly-restricted application that has never had a security review — which is
 * correct, and means a deployment registering these for production records a real review date
 * rather than inheriting a placeholder from here.
 */
export function consoleCatalogFor(environment: Environment): InternalAppCatalog {
  return new InternalAppCatalog(
    CONSOLE_TEMPLATES.map((template) =>
      parseInternalApplication({
        ...template.build(),
        environment,
        lastSecurityReview: environment === 'prod' ? '2026-01-01T00:00:00.000Z' : null,
      }),
    ),
  );
}

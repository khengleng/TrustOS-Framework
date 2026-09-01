import { ApiError } from '@trustsystem/errors';
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
 * The console templates, registered for an environment.
 *
 * A starting point for a deployment, and what the boot test runs against.
 *
 * **No review date is invented here.** The schema refuses a highly-restricted application in
 * production that has never had a security review, and this function used to satisfy that check
 * by stamping a hardcoded date — so the one highly-restricted console passed a governance
 * control on the strength of a constant in library code. That is the control reporting a
 * fiction, which is worse than the control failing.
 *
 * A template that cannot be registered honestly is now withheld instead. An application that is
 * not registered does not exist, every request naming it is refused, and that is the truthful
 * state until someone registers it with a real review date. Ask
 * {@link templatesWithheldFrom} which ones, and say so at start-up rather than letting a
 * console go quietly missing.
 */
export function consoleCatalogFor(environment: Environment): InternalAppCatalog {
  return new InternalAppCatalog(
    CONSOLE_TEMPLATES.map((template) => ({ ...template.build(), environment }))
      .filter((app) => !requiresReviewNobodyHasDone(app, environment))
      .map((app) => parseInternalApplication({ ...app, lastSecurityReview: null })),
  );
}

/**
 * Which templates this environment cannot honestly register, and why.
 *
 * Empty for every environment but production. Reported at start-up so a withheld console is a
 * stated fact rather than an absence someone notices later.
 */
export function templatesWithheldFrom(environment: Environment): string[] {
  return CONSOLE_TEMPLATES.map((template) => ({ ...template.build(), environment }))
    .filter((app) => requiresReviewNobodyHasDone(app, environment))
    .map((app) => app.appId);
}

/**
 * A production application whose classification demands a security review that no one has
 * recorded. The classification is the reason the review is required, so the classification is
 * what decides this.
 */
function requiresReviewNobodyHasDone(
  app: { dataClassification: string },
  environment: Environment,
): boolean {
  return environment === 'prod' && app.dataClassification === 'highly_restricted';
}

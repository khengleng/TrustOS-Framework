import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { DEPENDENCY_KINDS, type DependencyKind, type ServiceRegistry } from '@trustos/sre-core';

/**
 * Dependency health.
 *
 * Four states, and the fourth is the one this package exists for.
 *
 * `UNKNOWN` is not a placeholder for "probably fine". It is the state of a dependency whose last
 * probe is older than its own staleness budget, and it is treated as a **failure to observe**
 * rather than an observation of success. The alternative — carrying the last known-good state
 * forward — means a monitoring outage renders as a healthy estate, which is exactly backwards:
 * the moment you can no longer see is the moment you should be most concerned.
 *
 * The second rule is that **the worst state wins** when rolling up. Averaging health produces a
 * green dashboard during a partial outage, because most things are usually fine.
 */

export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/**
 * Severity order for rolling up.
 *
 * `UNKNOWN` sits above `DEGRADED` and below `UNAVAILABLE`: not knowing is worse than knowing
 * something is impaired, and better than knowing it is gone.
 */
const SEVERITY: Record<HealthState, number> = {
  HEALTHY: 0,
  DEGRADED: 1,
  UNKNOWN: 2,
  UNAVAILABLE: 3,
};

export function worst(states: readonly HealthState[]): HealthState {
  if (states.length === 0) return 'UNKNOWN';
  return states.reduce((left, right) => (SEVERITY[right] > SEVERITY[left] ? right : left));
}

export const healthProbeSchema = z
  .object({
    dependencyId: z.string().min(1).max(64),
    serviceId: z.string().min(3).max(64),
    kind: z.enum(DEPENDENCY_KINDS),
    state: z.enum(HEALTH_STATES),
    observedAt: z.string().datetime(),
    /** Round-trip of the probe itself. A slow probe is a signal even when it succeeds. */
    latencyMs: z.number().int().nonnegative().max(600_000).nullable().default(null),
    /**
     * Operator-facing detail. Must not contain credentials or connection strings — a health
     * dashboard is one of the least access-controlled surfaces in most deployments.
     */
    detail: z.string().max(500).nullable().default(null),
    /** How long this probe stays meaningful. After it, the dependency reads UNKNOWN. */
    freshnessSeconds: z.number().int().positive().max(86_400).default(120),
  })
  .strict();

export type HealthProbe = z.infer<typeof healthProbeSchema>;

export interface DependencyHealth {
  readonly dependencyId: string;
  readonly serviceId: string;
  readonly kind: DependencyKind;
  readonly state: HealthState;
  readonly critical: boolean;
  readonly observedAt: string | null;
  readonly latencyMs: number | null;
  readonly detail: string | null;
  /** True when the last probe aged out — the state is UNKNOWN because nobody looked recently. */
  readonly stale: boolean;
}

export interface ServiceHealth {
  readonly serviceId: string;
  /** The roll-up: worst critical dependency, with non-critical ones capped at DEGRADED. */
  readonly state: HealthState;
  readonly dependencies: readonly DependencyHealth[];
  readonly reason: string;
}

/**
 * The health board.
 *
 * Probes are pushed in; state is derived on read against the clock. Deriving on read is what makes
 * staleness work — a stored state never becomes stale by itself, because nothing runs to change it.
 */
export class DependencyHealthBoard {
  private readonly probes = new Map<string, HealthProbe>();

  constructor(
    private readonly registry: Pick<ServiceRegistry, 'require' | 'list' | 'dependents'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private static key(serviceId: string, dependencyId: string): string {
    return `${serviceId}::${dependencyId}`;
  }

  /** Record a probe. The dependency must be one the service declared. */
  record(probe: HealthProbe): void {
    const service = this.registry.require(probe.serviceId);
    const declared = service.dependencies.find((d) => d.dependencyId === probe.dependencyId);

    if (!declared) {
      throw ApiError.notFound(
        `Service ${probe.serviceId} did not declare a dependency called ${probe.dependencyId}. ` +
          'An undeclared dependency is invisible to the graph and to incident impact.',
      );
    }

    this.probes.set(DependencyHealthBoard.key(probe.serviceId, probe.dependencyId), probe);
  }

  private stateOf(probe: HealthProbe | undefined): { state: HealthState; stale: boolean } {
    if (!probe) return { state: 'UNKNOWN', stale: false };

    const ageSeconds = (this.now().getTime() - Date.parse(probe.observedAt)) / 1000;
    if (ageSeconds > probe.freshnessSeconds) return { state: 'UNKNOWN', stale: true };

    return { state: probe.state, stale: false };
  }

  /** Health of one service, rolled up from its declared dependencies. */
  serviceHealth(serviceId: string): ServiceHealth {
    const service = this.registry.require(serviceId);

    const dependencies: DependencyHealth[] = service.dependencies.map((declared) => {
      const probe = this.probes.get(DependencyHealthBoard.key(serviceId, declared.dependencyId));
      const { state, stale } = this.stateOf(probe);

      return {
        dependencyId: declared.dependencyId,
        serviceId,
        kind: declared.kind,
        state,
        critical: declared.critical,
        observedAt: probe?.observedAt ?? null,
        latencyMs: probe?.latencyMs ?? null,
        detail: probe?.detail ?? null,
        stale,
      };
    });

    if (dependencies.length === 0) {
      return {
        serviceId,
        state: 'HEALTHY',
        dependencies,
        reason: 'The service declares no dependencies, so nothing external can take it down.',
      };
    }

    /*
     * A non-critical dependency being gone degrades the service; it does not take it down. That is
     * exactly what `critical: false` claimed, and the declaration is only meaningful if the
     * roll-up honours it.
     */
    const contributions = dependencies.map((dependency) =>
      dependency.critical
        ? dependency.state
        : dependency.state === 'HEALTHY'
          ? 'HEALTHY'
          : ('DEGRADED' as HealthState),
    );

    const state = worst(contributions);
    const drivers = dependencies.filter(
      (dependency, index) => contributions[index] === state && state !== 'HEALTHY',
    );

    return {
      serviceId,
      state,
      dependencies,
      reason:
        state === 'HEALTHY'
          ? 'Every declared dependency answered, recently.'
          : drivers
              .map((driver) =>
                driver.stale
                  ? `${driver.dependencyId} has not been probed recently, so its state is unknown.`
                  : `${driver.dependencyId} is ${driver.state}.`,
              )
              .join(' '),
    };
  }

  /**
   * Everything affected by one dependency being down.
   *
   * Reads the registry's dependency graph rather than the probe table, so a service that has not
   * yet noticed the outage still appears. During an incident the question is "what is affected",
   * not "what has already alerted".
   */
  blastRadius(input: { serviceId: string; dependencyId: string }): {
    directlyAffected: string;
    transitivelyAffected: string[];
    criticalFor: string[];
  } {
    const service = this.registry.require(input.serviceId);
    const declared = service.dependencies.find((d) => d.dependencyId === input.dependencyId);

    if (!declared) {
      throw ApiError.notFound(
        `Dependency ${input.dependencyId} is not declared by ${input.serviceId}.`,
      );
    }

    const transitive = this.registry.dependents(input.serviceId);
    const criticalFor = declared.critical ? [input.serviceId] : [];

    for (const dependentId of transitive) {
      const dependent = this.registry.require(dependentId);
      const link = dependent.dependencies.find((d) => d.targetServiceId === input.serviceId);
      if (link?.critical) criticalFor.push(dependentId);
    }

    return { directlyAffected: input.serviceId, transitivelyAffected: transitive, criticalFor };
  }

  /** The board, for the operations console. */
  board(filter: { environment?: string; organizationId?: string | null } = {}): ServiceHealth[] {
    return this.registry
      .list(filter)
      .map((service) => this.serviceHealth(service.serviceId))
      .sort((left, right) => SEVERITY[right.state] - SEVERITY[left.state]);
  }

  /**
   * Dependencies whose state is unknown because nobody is looking.
   *
   * Surfaced separately from unhealthy ones, because the remedy is different: an unhealthy
   * dependency needs an engineer, an unobserved one needs a probe.
   */
  unobserved(): DependencyHealth[] {
    return this.board()
      .flatMap((service) => service.dependencies)
      .filter((dependency) => dependency.state === 'UNKNOWN');
  }
}

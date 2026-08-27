import { z } from 'zod';
import { ApiError } from '@trustos/errors';

/**
 * The SRE registry.
 *
 * Everything else in this domain — indicators, objectives, error budgets, incidents — refers to a
 * service by id. This package is where a service becomes a thing that exists, along with the four
 * facts an on-call engineer needs at 3am and cannot derive from code: what it depends on, how
 * important it is, what to do when it breaks, and who to wake.
 *
 * The single structural rule is that **a service with no owner cannot be registered**. An
 * unowned service is one whose alerts route nowhere; it is better for that to fail at
 * registration, in daylight, than during the incident.
 */

export const SERVICE_TIERS = ['tier_1', 'tier_2', 'tier_3'] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/**
 * What a tier means, so "tier 1" is a commitment rather than a label somebody applied optimistically.
 *
 * These are framework defaults. A deployment overrides them; it does not get to leave them
 * undefined, because an undefined tier is how everything becomes tier 1.
 */
export const TIER_EXPECTATIONS: Record<
  ServiceTier,
  {
    readonly description: string;
    /** Below this, an objective is not meaningfully a tier-N objective. */
    readonly minimumAvailability: number;
    readonly requiresRunbook: boolean;
    readonly requiresOnCall: boolean;
    /** A tier-1 service depending on a tier-3 one is a finding, not a preference. */
    readonly rank: number;
  }
> = {
  tier_1: {
    description: 'Customer-facing or money-moving. An outage is an incident before anyone asks.',
    minimumAvailability: 99.9,
    requiresRunbook: true,
    requiresOnCall: true,
    rank: 1,
  },
  tier_2: {
    description: 'Internal or supporting. Degradation is tolerable for minutes, not hours.',
    minimumAvailability: 99.5,
    requiresRunbook: true,
    requiresOnCall: false,
    rank: 2,
  },
  tier_3: {
    description: 'Batch, reporting or development. Nobody is woken for it.',
    minimumAvailability: 99.0,
    requiresRunbook: false,
    requiresOnCall: false,
    rank: 3,
  },
};

export const DEPENDENCY_KINDS = [
  'api',
  'database',
  'provider',
  'ai_model',
  'queue',
  'integration',
  'workflow',
  'storage',
] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/, 'Lowercase dotted or dashed identifier.');

/**
 * A dependency declaration.
 *
 * `critical` is the field that decides whether the dependency being down means this service is
 * down or merely degraded. Getting it wrong in the safe direction (marking something critical that
 * is not) costs a false page; getting it wrong the other way means the service reports healthy
 * while it cannot do its job.
 */
export const serviceDependencySchema = z
  .object({
    dependencyId: idSchema,
    kind: z.enum(DEPENDENCY_KINDS),
    description: z.string().min(10).max(500),
    /** True when this service cannot serve its purpose while the dependency is unavailable. */
    critical: z.boolean(),
    /** Another registered service, when the dependency is internal. */
    targetServiceId: idSchema.nullable().default(null),
    /**
     * What this service does when the dependency is unavailable. `none` is a legitimate answer
     * and is worth stating: it tells the reader the outage propagates.
     */
    degradedBehaviour: z.string().min(10).max(500),
    runbookId: idSchema.nullable().default(null),
  })
  .strict();

export type ServiceDependency = z.infer<typeof serviceDependencySchema>;

export const runbookStepSchema = z
  .object({
    title: z.string().min(3).max(200),
    /** What to actually do. A step nobody can follow at 3am is decoration. */
    action: z.string().min(10).max(2000),
    /** How the responder knows the step worked. */
    verification: z.string().min(5).max(500).nullable().default(null),
  })
  .strict();

export const runbookSchema = z
  .object({
    runbookId: idSchema,
    title: z.string().min(5).max(200),
    /** The situation this runbook is for, in the words an alert would use. */
    trigger: z.string().min(10).max(500),
    severityHint: z.enum(['SEV1', 'SEV2', 'SEV3', 'SEV4']),
    steps: z.array(runbookStepSchema).min(1),
    /** When the steps do not work. Escalation is part of the procedure, not the absence of one. */
    escalateTo: z.string().min(3).max(200),
    lastReviewedAt: z.string().datetime(),
    ownerId: z.string().min(3).max(64),
  })
  .strict();

export type Runbook = z.infer<typeof runbookSchema>;

/**
 * A maintenance window.
 *
 * Its purpose is arithmetic, not courtesy: minutes inside an approved window are excluded from
 * availability, so planned work does not consume the error budget that exists to absorb unplanned
 * failure. That makes the window a governed object — approved by someone, bounded in time, and
 * attached to specific services — rather than a note in a calendar.
 */
export const maintenanceWindowSchema = z
  .object({
    windowId: idSchema,
    title: z.string().min(5).max(200),
    serviceIds: z.array(idSchema).min(1),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    /** Whether minutes in this window are excluded from SLI measurement. */
    excludeFromSlo: z.boolean().default(true),
    approvedBy: z.string().min(3).max(64),
    approvedAt: z.string().datetime(),
    description: z.string().min(10).max(1000),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (Date.parse(window.endsAt) <= Date.parse(window.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'A maintenance window ends after it starts.',
      });
    }
  });

export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>;

export const serviceSchema = z
  .object({
    serviceId: idSchema,
    name: z.string().min(3).max(120),
    description: z.string().min(10).max(1000),
    tier: z.enum(SERVICE_TIERS),
    /**
     * The owning team. Required, and this is the point of the package: a service without an owner
     * has alerts that route to nobody.
     */
    ownerTeam: z.string().min(2).max(120),
    /** Who is woken. Null is only permitted for tiers that do not require on-call. */
    onCallRotation: z.string().min(2).max(120).nullable().default(null),
    dependencies: z.array(serviceDependencySchema).default([]),
    runbookIds: z.array(idSchema).default([]),
    /** Products or capabilities that stop working when this does — used to state impact. */
    supportsProducts: z.array(z.string().min(1).max(120)).default([]),
    /** Where the code lives, so an incident responder can find it. */
    repository: z.string().min(3).max(300).nullable().default(null),
    environment: z.enum(['development', 'staging', 'production']),
    organizationId: z.string().min(1).max(64).nullable().default(null),
    registeredAt: z.string().datetime(),
  })
  .strict()
  .superRefine((service, ctx) => {
    const expectation = TIER_EXPECTATIONS[service.tier];

    if (expectation.requiresOnCall && service.onCallRotation === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['onCallRotation'],
        message: `A ${service.tier} service names the rotation that is woken for it.`,
      });
    }

    if (expectation.requiresRunbook && service.runbookIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runbookIds'],
        message: `A ${service.tier} service references at least one runbook.`,
      });
    }

    const seen = new Set<string>();
    for (const [index, dependency] of service.dependencies.entries()) {
      if (seen.has(dependency.dependencyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dependencies', index, 'dependencyId'],
          message: 'Dependency ids are unique within a service.',
        });
      }
      seen.add(dependency.dependencyId);

      if (dependency.targetServiceId === service.serviceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dependencies', index, 'targetServiceId'],
          message: 'A service does not depend on itself.',
        });
      }
    }
  });

export type Service = z.infer<typeof serviceSchema>;

export interface ServiceGraphFinding {
  readonly kind:
    | 'unregistered_dependency'
    | 'tier_inversion'
    | 'missing_runbook'
    | 'dependency_cycle'
    | 'critical_without_degraded_behaviour';
  readonly serviceId: string;
  readonly detail: string;
  readonly severity: 'high' | 'medium' | 'low';
}

/**
 * The registry.
 *
 * Deliberately in-memory and synchronous: this is a description of the estate, loaded from
 * configuration at start-up, not a live datastore. A deployment persists the documents wherever it
 * keeps configuration and rebuilds the registry from them.
 */
export class ServiceRegistry {
  private readonly services = new Map<string, Service>();
  private readonly runbooks = new Map<string, Runbook>();
  private readonly windows = new Map<string, MaintenanceWindow>();

  constructor(
    input: {
      services?: readonly Service[];
      runbooks?: readonly Runbook[];
      maintenanceWindows?: readonly MaintenanceWindow[];
    } = {},
  ) {
    for (const runbook of input.runbooks ?? []) this.registerRunbook(runbook);
    for (const service of input.services ?? []) this.register(service);
    for (const window of input.maintenanceWindows ?? []) this.scheduleMaintenance(window);
  }

  register(service: Service): void {
    if (this.services.has(service.serviceId)) {
      throw ApiError.conflict(`Service ${service.serviceId} is already registered.`);
    }

    for (const runbookId of service.runbookIds) {
      if (!this.runbooks.has(runbookId)) {
        throw ApiError.notFound(
          `Service ${service.serviceId} references runbook ${runbookId}, which is not registered.`,
        );
      }
    }

    this.services.set(service.serviceId, service);
  }

  registerRunbook(runbook: Runbook): void {
    if (this.runbooks.has(runbook.runbookId)) {
      throw ApiError.conflict(`Runbook ${runbook.runbookId} is already registered.`);
    }
    this.runbooks.set(runbook.runbookId, runbook);
  }

  scheduleMaintenance(window: MaintenanceWindow): void {
    for (const serviceId of window.serviceIds) {
      if (!this.services.has(serviceId)) {
        throw ApiError.notFound(
          `Maintenance window ${window.windowId} covers ${serviceId}, which is not registered.`,
        );
      }
    }
    this.windows.set(window.windowId, window);
  }

  get(serviceId: string): Service | null {
    return this.services.get(serviceId) ?? null;
  }

  require(serviceId: string): Service {
    const service = this.get(serviceId);
    if (!service) throw ApiError.notFound(`Service ${serviceId} is not registered.`);
    return service;
  }

  runbook(runbookId: string): Runbook | null {
    return this.runbooks.get(runbookId) ?? null;
  }

  /** Every runbook that could apply to this service, including its dependencies' runbooks. */
  runbooksFor(serviceId: string): Runbook[] {
    const service = this.require(serviceId);
    const ids = new Set(service.runbookIds);
    for (const dependency of service.dependencies) {
      if (dependency.runbookId) ids.add(dependency.runbookId);
    }
    return [...ids].map((id) => this.runbooks.get(id)).filter((r): r is Runbook => r !== undefined);
  }

  list(
    filter: { tier?: ServiceTier; environment?: string; organizationId?: string | null } = {},
  ): Service[] {
    return [...this.services.values()].filter((service) => {
      if (filter.tier && service.tier !== filter.tier) return false;
      if (filter.environment && service.environment !== filter.environment) return false;
      if (filter.organizationId !== undefined && service.organizationId !== filter.organizationId) {
        return false;
      }
      return true;
    });
  }

  /**
   * Whether a moment falls inside an approved, SLO-excluded window for this service.
   *
   * The SLI package calls this so that planned work does not spend the error budget.
   */
  inMaintenance(serviceId: string, at: Date): MaintenanceWindow | null {
    const moment = at.getTime();
    for (const window of this.windows.values()) {
      if (!window.excludeFromSlo) continue;
      if (!window.serviceIds.includes(serviceId)) continue;
      if (moment >= Date.parse(window.startsAt) && moment < Date.parse(window.endsAt))
        return window;
    }
    return null;
  }

  maintenanceWindows(): MaintenanceWindow[] {
    return [...this.windows.values()];
  }

  /**
   * Everything that transitively depends on this service.
   *
   * The question asked during an incident — "who else is affected?" — which nobody can answer
   * accurately from memory once there are more than a dozen services.
   */
  dependents(serviceId: string): string[] {
    const found = new Set<string>();
    const queue = [serviceId];

    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const service of this.services.values()) {
        if (found.has(service.serviceId) || service.serviceId === serviceId) continue;
        const dependsOnCurrent = service.dependencies.some(
          (dependency) => dependency.targetServiceId === current,
        );
        if (dependsOnCurrent) {
          found.add(service.serviceId);
          queue.push(service.serviceId);
        }
      }
    }

    return [...found].sort();
  }

  /**
   * Transitive internal dependencies, nearest first.
   *
   * A service in a cycle appears in its own dependency list. That is not a quirk to filter out —
   * it is the truthful answer, and `participatesInCycle` reads it rather than repeating the walk.
   */
  dependenciesOf(serviceId: string): string[] {
    const found = new Set<string>();
    const queue = [serviceId];

    while (queue.length > 0) {
      const current = queue.shift() as string;
      const service = this.services.get(current);
      if (!service) continue;
      for (const dependency of service.dependencies) {
        const target = dependency.targetServiceId;
        if (target && !found.has(target)) {
          found.add(target);
          queue.push(target);
        }
      }
    }

    return [...found];
  }

  /** True when the service transitively depends on itself. */
  participatesInCycle(serviceId: string): boolean {
    return this.dependenciesOf(serviceId).includes(serviceId);
  }

  /**
   * Findings across the whole graph.
   *
   * The two that matter most:
   *
   * **Tier inversion** — a tier-1 service critically depending on a tier-3 one. The dependent
   * service's availability is bounded by its dependency's, so the tier-1 commitment is arithmetic
   * fiction. This is the single most common way a well-intentioned SLO becomes undeliverable.
   *
   * **Dependency cycles** — two services each critically depending on the other cannot be
   * recovered independently, so neither has a working recovery procedure.
   */
  analyse(): ServiceGraphFinding[] {
    const findings: ServiceGraphFinding[] = [];

    for (const service of this.services.values()) {
      const expectation = TIER_EXPECTATIONS[service.tier];

      for (const dependency of service.dependencies) {
        if (dependency.targetServiceId) {
          const target = this.services.get(dependency.targetServiceId);

          if (!target) {
            findings.push({
              kind: 'unregistered_dependency',
              serviceId: service.serviceId,
              severity: 'medium',
              detail: `Depends on ${dependency.targetServiceId}, which is not in the registry — its health is unmonitored.`,
            });
            continue;
          }

          if (dependency.critical && TIER_EXPECTATIONS[target.tier].rank > expectation.rank) {
            findings.push({
              kind: 'tier_inversion',
              serviceId: service.serviceId,
              severity: 'high',
              detail:
                `${service.serviceId} (${service.tier}) critically depends on ${target.serviceId} ` +
                `(${target.tier}). Its availability cannot exceed its dependency's.`,
            });
          }
        }

        if (dependency.critical && !dependency.runbookId && expectation.requiresRunbook) {
          findings.push({
            kind: 'missing_runbook',
            serviceId: service.serviceId,
            severity: 'medium',
            detail: `Critical dependency ${dependency.dependencyId} has no runbook for its outage.`,
          });
        }
      }

      if (this.participatesInCycle(service.serviceId)) {
        findings.push({
          kind: 'dependency_cycle',
          serviceId: service.serviceId,
          severity: 'high',
          detail: 'Participates in a dependency cycle, so it cannot be recovered independently.',
        });
      }
    }

    return findings;
  }
}

/** A registry with unresolved high-severity findings is not one to build objectives on. */
export function assertGraphSound(registry: ServiceRegistry): void {
  const high = registry.analyse().filter((finding) => finding.severity === 'high');
  if (high.length === 0) return;

  throw ApiError.conflict('The service graph has unresolved high-severity findings.', {
    context: { findings: high.map((finding) => `${finding.serviceId}: ${finding.detail}`) },
  });
}

import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { ENVIRONMENTS, type Environment } from '@trustsystem/governance-tool-core';

/**
 * Environments, and the promotion between them.
 *
 * Three, ordered: DEV, UAT, PROD. Each has its own resources, its own credentials, its own
 * endpoints and its own access policy, and the single most important rule in this package is the
 * one that sounds obvious until it is violated: **a lower-environment credential must never
 * authenticate to production.**
 *
 * It is violated the same way every time. Somebody copies a `.env` to debug something, the
 * development console starts answering with production data, and it works — so nobody notices
 * until an export. `assertNoCrossEnvironmentCredential` refuses a configuration where a
 * credential reference is shared across environments, and it refuses at *load* rather than at
 * first use, because at first use it has already worked once.
 *
 * Promotion is governed the same way a product version is: a plan, a reviewer, evidence, and an
 * approval that is not the author's.
 */

export const ENVIRONMENT_ORDER: readonly Environment[] = ENVIRONMENTS;

export function environmentRank(environment: Environment): number {
  return ENVIRONMENT_ORDER.indexOf(environment);
}

export const environmentConfigSchema = z
  .object({
    environment: z.enum(ENVIRONMENTS),
    /** Human name, for the banner every console renders. */
    label: z.string().min(1).max(40),
    /**
     * The gateway this environment's consoles call.
     *
     * A reference resolved by the deployment, never a URL. A URL here is an environment leaking
     * into a document that gets promoted — which is the exact failure this file exists to stop.
     */
    gatewayRef: z.string().min(1).max(120),
    /** Credential references, by resource id. References, never credentials. */
    credentialRefs: z.record(z.string().min(1).max(200)),
    /** Whether an internal application may be edited in this environment. */
    editable: z.boolean(),
    /** Whether real customer data is present. Drives masking defaults and export ceilings. */
    carriesProductionData: z.boolean(),
    /** Approvals required to promote *into* this environment. */
    promotionApprovals: z.array(z.string().min(1).max(60)).max(10),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.environment === 'prod' && config.editable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['editable'],
        message:
          'Production is not editable. An internal application is promoted into production, not ' +
          'written there — otherwise the reviewed artefact and the running one are different.',
      });
    }

    if (config.environment === 'prod' && config.promotionApprovals.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promotionApprovals'],
        message: 'Promotion into production needs at least one approval.',
      });
    }

    if (config.environment !== 'prod' && config.carriesProductionData) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['carriesProductionData'],
        message:
          'A non-production environment carrying production data is a production environment ' +
          'with weaker controls. If the data is real, the environment is PROD.',
      });
    }
  });

export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;

/**
 * Refuses a credential reference shared across environments.
 *
 * The check that catches the copied `.env`. It compares references rather than values — this
 * package never sees a credential — and a shared reference is the observable symptom of a shared
 * credential.
 *
 * Refused at load rather than at first use: by first use it has already worked once, and a thing
 * that works is a thing somebody depends on by the afternoon.
 */
export function assertNoCrossEnvironmentCredential(configs: readonly EnvironmentConfig[]): void {
  const seen = new Map<string, Environment>();

  for (const config of configs) {
    for (const [resourceId, credentialRef] of Object.entries(config.credentialRefs)) {
      const previous = seen.get(credentialRef);

      if (previous && previous !== config.environment) {
        throw new ApiError('validation_error', {
          message:
            `The credential reference "${credentialRef}" is used by both ${previous} and ` +
            `${config.environment} (resource "${resourceId}"). A lower-environment credential ` +
            'that reaches production is the copied .env, and it works — which is why nobody ' +
            'notices until an export.',
          context: { credentialRef, environments: `${previous},${config.environment}` },
        });
      }

      seen.set(credentialRef, config.environment);
    }
  }
}

export class EnvironmentRegistry {
  private readonly configs = new Map<Environment, EnvironmentConfig>();

  constructor(configs: readonly EnvironmentConfig[]) {
    for (const config of configs) {
      const parsed = environmentConfigSchema.parse(config);
      this.configs.set(parsed.environment, parsed);
    }

    assertNoCrossEnvironmentCredential([...this.configs.values()]);
  }

  get(environment: Environment): EnvironmentConfig {
    const config = this.configs.get(environment);

    if (!config) {
      throw new ApiError('validation_error', {
        message: `No configuration for ${environment}.`,
        context: { environment },
      });
    }

    return config;
  }

  has(environment: Environment): boolean {
    return this.configs.has(environment);
  }

  all(): EnvironmentConfig[] {
    return ENVIRONMENT_ORDER.filter((environment) => this.configs.has(environment)).map(
      (environment) => this.get(environment),
    );
  }
}

// --- promotion --------------------------------------------------------------

export interface PromotionPlan {
  appId: string;
  fromEnvironment: Environment;
  toEnvironment: Environment;
  /** Approvals this promotion needs, from the target environment's configuration. */
  requiredApprovals: string[];
  /** What a reviewer reads before approving. */
  effects: string[];
  /** Everything that would block it. */
  blockers: string[];
  allowed: boolean;
}

export interface PlanPromotionInput {
  appId: string;
  appVersion: string;
  fromEnvironment: Environment;
  toEnvironment: Environment;
  registry: EnvironmentRegistry;
  /** Whether the app validates in the target environment: every resource registered and approved. */
  resourcesResolved: boolean;
  /** Unregistered resources, named. */
  unregisteredResources: readonly string[];
  /** Whether test evidence has been recorded for this version. */
  hasTestEvidence: boolean;
  /** Whether a security review has been completed, where the classification demands one. */
  securityReviewed: boolean;
  /** Whether the app declares a rollback target. */
  rollbackTarget: string | null;
}

/**
 * Plans a promotion.
 *
 * Refuses a **skip**: DEV to PROD is not a promotion, it is a deployment that missed a stage, and
 * the stage it missed is the one where somebody would have used it.
 *
 * Refuses a **demotion** too. Moving an application from PROD to UAT sounds harmless and is how a
 * production console is quietly replaced by whatever was in UAT.
 */
export function planPromotion(input: PlanPromotionInput): PromotionPlan {
  const target = input.registry.get(input.toEnvironment);
  const blockers: string[] = [];

  const fromRank = environmentRank(input.fromEnvironment);
  const toRank = environmentRank(input.toEnvironment);

  if (toRank <= fromRank) {
    blockers.push(
      `${input.fromEnvironment} to ${input.toEnvironment} is not a promotion. Moving an ` +
        'application backwards replaces the running one with whatever was in the lower ' +
        'environment.',
    );
  }

  if (toRank - fromRank > 1) {
    blockers.push(
      `${input.fromEnvironment} to ${input.toEnvironment} skips ${
        ENVIRONMENT_ORDER[fromRank + 1]
      }. The stage it skips is the one where somebody would have used it.`,
    );
  }

  if (!input.resourcesResolved) {
    blockers.push(
      `These resources are not registered and approved in ${input.toEnvironment}: ` +
        `${input.unregisteredResources.join(', ') || 'unknown'}. A console promoted with an ` +
        'unregistered source renders empty and looks broken.',
    );
  }

  if (!input.hasTestEvidence) {
    blockers.push('No test evidence is recorded for this version.');
  }

  if (input.toEnvironment === 'prod' && !input.securityReviewed) {
    blockers.push('A production promotion needs a completed security review.');
  }

  if (input.toEnvironment === 'prod' && !input.rollbackTarget) {
    blockers.push(
      'No rollback target. A production change with no way back is a change nobody can undo at ' +
        'the moment they most need to.',
    );
  }

  return {
    appId: input.appId,
    fromEnvironment: input.fromEnvironment,
    toEnvironment: input.toEnvironment,
    requiredApprovals: [...target.promotionApprovals],
    effects: [
      `${input.appId} ${input.appVersion} becomes the ${input.toEnvironment} version.`,
      `It will read ${input.toEnvironment} resources with ${input.toEnvironment} credentials.`,
      target.editable
        ? `${input.toEnvironment} is editable, so the promoted version can be changed in place.`
        : `${input.toEnvironment} is not editable. The next change is another promotion.`,
      input.rollbackTarget
        ? `Rollback target: ${input.rollbackTarget}.`
        : 'No rollback target recorded.',
    ],
    blockers,
    allowed: blockers.length === 0,
  };
}

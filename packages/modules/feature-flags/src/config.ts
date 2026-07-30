import { z } from 'zod';

/**
 * Feature flag configuration.
 *
 * `rolloutSalt` has a default so the module installs with no configuration, and
 * the default is a constant rather than a random value — a salt that changed on
 * every process start would reshuffle every rollout on every deploy, which is the
 * one thing a rollout must not do. Set it once per environment and leave it.
 */
export const featureFlagsConfigSchema = z
  .object({
    rolloutSalt: z.string().min(1).max(120).default('trustos-default-salt'),

    /**
     * Write an audit record for every evaluation.
     *
     * Off by default: evaluations are hot — several per request — and the volume
     * would drown the trail that the rest of the framework writes to.
     */
    auditEvaluations: z.boolean().default(false),

    /** Largest expiry a flag may be given, in days. */
    maxExpiryDays: z.number().int().min(1).max(3650).default(365),
  })
  .strict();

export type FeatureFlagsConfig = z.infer<typeof featureFlagsConfigSchema>;

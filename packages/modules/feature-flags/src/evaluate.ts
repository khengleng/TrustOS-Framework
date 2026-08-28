import { createHash } from 'node:crypto';
import type { ModuleEnvironment } from '@trustos/module-sdk';

/**
 * Flag evaluation.
 *
 * The rules are applied in a fixed order and every one of them can only turn a
 * flag **off**, never on. That is the whole safety property: a flag that is
 * misconfigured, expired, out of environment, or impossible to bucket evaluates
 * to off, and the feature stays behind the gate rather than shipping to everyone.
 *
 * Order, and why each step is where it is:
 *
 *   1. **Unknown flag → off.** A typo in a flag key must not enable a feature.
 *   2. **Expired → off.** An expiry that had to be honoured by remembering to
 *      delete the flag is not an expiry.
 *   3. **Wrong environment → off.** Checked before overrides, so a per-subject
 *      allow-list in staging cannot leak a feature into production.
 *   4. **Subject override → its value.** A deliberate, per-subject decision beats
 *      a percentage. This is the one step that can return true against a rollout,
 *      and it is stored as a row someone had to create.
 *   5. **Disabled → off.** The master switch.
 *   6. **Rollout.** 100 is on, 0 is off, anything between buckets the subject.
 *   7. **No subject → off.** A partial rollout cannot be evaluated without
 *      something to bucket, and guessing would make the flag flap per request.
 */

export interface FlagDefinition {
  key: string;
  enabled: boolean;
  /** 0..100. 100 with `enabled` means on for everyone. */
  rolloutPercentage: number;
  /** Empty means every environment. */
  environments: string[];
  expiresAt: Date | null;
}

export interface EvaluationInput {
  flag: FlagDefinition | null;
  /** Stable identifier for the thing being bucketed: a user id, a device id. */
  subjectId?: string | null;
  environment: ModuleEnvironment;
  now: Date;
  /** Per-environment salt, so one rollout's buckets are not another's. */
  salt: string;
}

export type EvaluationReason =
  | 'unknown_flag'
  | 'expired'
  | 'environment_excluded'
  | 'subject_override'
  | 'disabled'
  | 'full_rollout'
  | 'no_rollout'
  | 'in_rollout'
  | 'out_of_rollout'
  | 'no_subject';

export interface Evaluation {
  enabled: boolean;
  /** Why. Returned to callers and recorded when evaluation audit is on. */
  reason: EvaluationReason;
  /** The subject's bucket, 0..99.99, when one was computed. */
  bucket: number | null;
}

/** Evaluates a flag. Pure: same inputs, same answer, in any process. */
export function evaluateFlag(input: EvaluationInput, override: boolean | null = null): Evaluation {
  const { flag, environment, now, salt } = input;

  if (!flag) return { enabled: false, reason: 'unknown_flag', bucket: null };

  if (flag.expiresAt && flag.expiresAt.getTime() <= now.getTime()) {
    return { enabled: false, reason: 'expired', bucket: null };
  }

  if (flag.environments.length > 0 && !flag.environments.includes(environment)) {
    return { enabled: false, reason: 'environment_excluded', bucket: null };
  }

  if (override !== null) {
    return { enabled: override, reason: 'subject_override', bucket: null };
  }

  if (!flag.enabled) return { enabled: false, reason: 'disabled', bucket: null };

  if (flag.rolloutPercentage >= 100) {
    return { enabled: true, reason: 'full_rollout', bucket: null };
  }
  if (flag.rolloutPercentage <= 0) {
    return { enabled: false, reason: 'no_rollout', bucket: null };
  }

  if (!input.subjectId) {
    return { enabled: false, reason: 'no_subject', bucket: null };
  }

  const bucket = bucketOf(salt, flag.key, input.subjectId);
  return bucket < flag.rolloutPercentage
    ? { enabled: true, reason: 'in_rollout', bucket }
    : { enabled: false, reason: 'out_of_rollout', bucket };
}

/**
 * The subject's bucket for one flag, in [0, 100).
 *
 * SHA-256 of `salt:key:subject`, taking the first four bytes. Three properties
 * follow, and a rollout is only usable if all three hold:
 *
 *   * **Stable.** The same subject gets the same answer on every request and in
 *     every process. A random draw per request would flicker the feature in and
 *     out mid-session, which reads as a broken product rather than a rollout.
 *   * **Independent per flag.** The key is in the hash, so the first 10% of one
 *     rollout is not the same people as the first 10% of the next — otherwise the
 *     same unlucky cohort receives every experiment.
 *   * **Monotonic.** Raising a percentage only adds subjects; nobody who had the
 *     feature loses it.
 */
export function bucketOf(salt: string, flagKey: string, subjectId: string): number {
  const digest = createHash('sha256').update(`${salt}:${flagKey}:${subjectId}`).digest();
  // Four bytes is 32 bits of entropy — far more than the 10,000 buckets need, and
  // reading a fixed width keeps the result independent of digest length.
  const value = digest.readUInt32BE(0);
  return (value % 10_000) / 100;
}

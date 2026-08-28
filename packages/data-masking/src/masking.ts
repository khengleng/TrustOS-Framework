import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { obligationsFor, type DataClassificationLevel } from '@trustos/data-classification';
import {
  MASK_STRATEGIES,
  MaskPolicy,
  mask,
  maskRuleSchema,
  type MaskRule,
  type MaskStrategy,
} from '@trustos/governance-pii-policy';

/**
 * Platform-wide masking.
 *
 * The display strategies and the reveal ceremony are `@trustos/governance-pii-policy`'s, and are
 * **reused rather than restated** — a second `mask()` in this repository would be a second set of
 * rules about how many digits of an account number a person sees, and the two would diverge.
 * That package landed first because the Governance Tool needed it; the layering is legal in both
 * directions and this is the one that avoids the duplicate.
 *
 * What this package adds is the part that is about *data* rather than about a screen:
 *
 * **Tokenization** — replacing a value with a surrogate that can be reversed by something that
 * holds the vault. Modelled as a port with no implementation, because a tokenization vault is a
 * piece of infrastructure with its own key management, and one shipped here would be a wrong one.
 *
 * **Pseudonymization** — replacing a value with a stable, non-reversible surrogate, so records
 * can still be joined without the identifier being present. This one *is* implemented, because it
 * is a keyed hash and getting it wrong is easy in a specific way: an unsalted hash of a phone
 * number is reversible by anybody with a list of phone numbers, which is everybody.
 *
 * **Classification-driven defaults** — which fields are masked follows from what the catalog says
 * they are, rather than from a rule somebody remembered to write.
 */

export { MASK_STRATEGIES, MaskPolicy, mask, maskRuleSchema };
export type { MaskRule, MaskStrategy };

/**
 * A tokenization vault.
 *
 * A port. The framework ships no implementation, and the reason is the same one it ships no
 * secrets manager: a vault holds the mapping from surrogate to value, which makes it the most
 * sensitive store in the platform, and it needs key rotation, split knowledge and an HSM
 * conversation that belongs to a deployment.
 *
 * `detokenize` takes an actor and a reason because detokenizing **is** a reveal — the same
 * ceremony, the same audit record, the same expiry. A vault whose `detokenize` took only a token
 * would be a vault where a service account can read every card number it has ever seen.
 */
export interface TokenVault {
  tokenize(input: { value: string; purpose: string }): Promise<string>;
  detokenize(input: {
    token: string;
    actorId: string;
    reason: string;
    caseRef?: string;
  }): Promise<string>;
}

/**
 * A vault that refuses everything.
 *
 * The default. An unconfigured platform that silently returned the token unchanged would be a
 * platform where tokenization appears to work and nothing is tokenized.
 */
export function refusingTokenVault(): TokenVault {
  /*
   * Rejects rather than throwing synchronously.
   *
   * Both methods are declared `Promise`-returning, and a synchronous throw from one is a footgun:
   * a caller using `.catch()` rather than `try`/`await` never sees it, and the error escapes the
   * request handler that was carefully wrapping the call.
   */
  const refuse = async (): Promise<never> => {
    throw new ApiError('internal_error', {
      message:
        'No tokenization vault is configured. The framework ships none — a vault holds the ' +
        'mapping from surrogate to value, which makes it the most sensitive store in the ' +
        'platform, and its key management belongs to a deployment.',
    });
  };

  return { tokenize: refuse, detokenize: refuse };
}

/**
 * Pseudonymization: a stable, non-reversible surrogate.
 *
 * A keyed hash, truncated. Two properties matter and both are easy to lose:
 *
 * **It must be keyed.** An unsalted SHA-256 of a phone number is reversible by anybody with a
 * list of phone numbers, which is everybody — there are only so many phone numbers, and a
 * rainbow table over them is minutes of work. The key is a deployment secret.
 *
 * **It must be stable within a scope and different across scopes.** Stable, so two records about
 * the same person still join. Different across scopes, so a pseudonym shared between the
 * analytics warehouse and the marketing extract cannot be used to re-identify by joining them —
 * which is the standard attack on pseudonymized data and the reason `scope` is required.
 */
export function pseudonymize(input: {
  value: string;
  /** A deployment secret. Rotating it breaks joins, deliberately — see the note in the docs. */
  key: string;
  /** The purpose this pseudonym is for. Different scopes must not produce the same surrogate. */
  scope: string;
  /** Characters of hex to keep. 16 is 64 bits — enough that collisions are not the risk. */
  length?: number;
}): string {
  if (input.key.length < 32) {
    throw new ApiError('validation_error', {
      message:
        'A pseudonymization key must be at least 32 characters. A short key is a key an ' +
        'attacker with a candidate list can brute-force, and the candidate list for a phone ' +
        'number is every phone number.',
    });
  }

  /*
   * Node's crypto, required lazily so this module stays usable in a browser bundle for the
   * type definitions alone. The hash itself never runs in a browser: a pseudonymization key in
   * client code is a published key.
   */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require('node:crypto') as typeof import('node:crypto');

  return createHmac('sha256', input.key)
    .update(`${input.scope}|${input.value}`)
    .digest('hex')
    .slice(0, input.length ?? 16);
}

/**
 * The masking rules a classification implies.
 *
 * Derived from the catalog rather than written per field. A column classified `RESTRICTED` and
 * marked as personal data is masked; a `PUBLIC` one is not. That means a reclassification changes
 * what people see, which is the point — the alternative is a masking configuration that agrees
 * with the classification on the day both were written.
 */
export function rulesForClassification(
  fields: ReadonlyArray<{
    field: string;
    classification: DataClassificationLevel;
    personalData: boolean;
  }>,
): MaskRule[] {
  return fields
    .filter((entry) => entry.personalData || obligationsFor(entry.classification).maskByDefault)
    .map((entry) => {
      const obligations = obligationsFor(entry.classification);

      return maskRuleSchema.parse({
        field: entry.field,
        /*
         * A conservative default.
         *
         * `partial_suffix` for anything personal, because the suffix is what a person reads back;
         * `redact` for the most restrictive level, because a partial mask of something that must
         * not leave the system still leaves part of it.
         */
        strategy: entry.classification === 'HIGHLY_RESTRICTED' ? 'redact' : 'partial_suffix',
        keep: 3,
        revealable: entry.classification !== 'HIGHLY_RESTRICTED',
        revealRequiresApproval: obligations.revealRequiresApproval,
        description: `Derived from the ${entry.classification} classification.`,
      });
    });
}

export const maskingPolicySchema = z
  .object({
    policyId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
    description: z.string().min(10).max(400),
    rules: z.array(maskRuleSchema).max(500),
    /** Fields replaced with a token rather than masked. Needs a vault. */
    tokenizedFields: z.array(z.string().min(1).max(80)).max(100).default([]),
    /** Fields replaced with a stable surrogate. Needs a key and a scope. */
    pseudonymizedFields: z
      .array(
        z.object({ field: z.string().min(1).max(80), scope: z.string().min(1).max(80) }).strict(),
      )
      .max(100)
      .default([]),
    effectiveFrom: z.string().datetime(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const masked = new Set(policy.rules.map((rule) => rule.field.toLowerCase()));

    for (const field of policy.tokenizedFields) {
      if (!masked.has(field.toLowerCase())) continue;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokenizedFields'],
        message:
          `"${field}" is both masked and tokenized. Masking a token displays part of a surrogate, ` +
          'which tells a reader nothing and looks exactly like a partially-masked real value.',
      });
    }
  });

export type MaskingPolicy = z.infer<typeof maskingPolicySchema>;

/** Refuses an unmasked read of something the classification says must be masked. */
export function assertMasked(classification: DataClassificationLevel, masked: boolean): void {
  if (!obligationsFor(classification).maskByDefault || masked) return;

  throw new ApiError('forbidden', {
    message:
      `${classification} data is masked by default and this read is unmasked. An unmasked read ` +
      'needs a reveal, with a reason and an expiry.',
    context: { classification },
  });
}

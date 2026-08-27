import { z } from 'zod';

/**
 * The failure scenarios a product must survive.
 *
 * Section 15 of the specification lists eight; this is those eight plus the two the runtime's own
 * behaviour makes worth exercising (`duplicate_request` and `compensation_failure`).
 *
 * The point of a scenario catalog rather than ad-hoc mocking: a product owner who has to *write*
 * a provider timeout will write a provider timeout, and will not write a settlement failure or a
 * reconciliation mismatch, because those are not the failures they are thinking about. A closed
 * list turns "did you test the failure paths" from a conversation into a checklist with a result.
 *
 * A scenario is data. It says which block it fires at and what happens; it does not contain
 * behaviour, because a scenario that could run code would be a way to put code into a sandbox
 * that exists precisely to run products without any.
 */

export const SANDBOX_SCENARIOS = [
  'success',
  'provider_timeout',
  'provider_failure',
  'insufficient_balance',
  'limit_exceeded',
  'risk_rejection',
  'kyc_rejection',
  'settlement_failure',
  'reconciliation_mismatch',
  'duplicate_request',
  'compensation_failure',
  'review_required',
] as const;

export type SandboxScenario = (typeof SANDBOX_SCENARIOS)[number];

export const SCENARIO_DESCRIPTIONS: Record<SandboxScenario, string> = {
  success: 'Everything answers. The path a product is designed around and the least informative to run.',
  provider_timeout: 'The provider does not answer within the block’s timeout. Retryable.',
  provider_failure: 'The provider answers with a failure. Not retryable — retrying a refusal is noise.',
  insufficient_balance: 'The available balance is below the amount. A refusal, not a failure.',
  limit_exceeded: 'A configured limit refuses the amount. The control working.',
  risk_rejection: 'A risk check refuses. The most common legitimate refusal in a live product.',
  kyc_rejection: 'The customer’s verification level is below the product’s minimum.',
  settlement_failure: 'The settlement instruction is refused after the money has already moved.',
  reconciliation_mismatch: 'The external statement disagrees with the ledger.',
  duplicate_request: 'The same idempotency key arrives twice. Exercises the replay path.',
  compensation_failure:
    'A block fails and its compensation fails too. The state that needs a person, and the one ' +
    'most products have never run.',
  review_required: 'A block demands a human decision and the execution holds.',
};

/**
 * How a scenario manifests.
 *
 * Mapped to the runtime's outcome union rather than to an exception, because the distinction
 * between a refusal and a failure is the thing the sandbox most needs to exercise — a product
 * whose author believes a limit refusal is a failure has written the wrong failure path.
 */
export const SCENARIO_OUTCOMES: Record<
  SandboxScenario,
  { outcome: 'success' | 'refused' | 'failed' | 'review_required'; code: string; retryable: boolean }
> = {
  success: { outcome: 'success', code: 'ok', retryable: false },
  provider_timeout: { outcome: 'failed', code: 'provider_timeout', retryable: true },
  provider_failure: { outcome: 'failed', code: 'provider_failure', retryable: false },
  insufficient_balance: { outcome: 'refused', code: 'insufficient_balance', retryable: false },
  limit_exceeded: { outcome: 'refused', code: 'limit_exceeded', retryable: false },
  risk_rejection: { outcome: 'refused', code: 'risk_rejected', retryable: false },
  kyc_rejection: { outcome: 'refused', code: 'kyc_insufficient', retryable: false },
  settlement_failure: { outcome: 'failed', code: 'settlement_failed', retryable: false },
  reconciliation_mismatch: { outcome: 'refused', code: 'reconciliation_mismatch', retryable: false },
  duplicate_request: { outcome: 'success', code: 'ok', retryable: false },
  compensation_failure: { outcome: 'failed', code: 'compensation_failed', retryable: false },
  review_required: { outcome: 'review_required', code: 'review_required', retryable: false },
};

export const scenarioInjectionSchema = z
  .object({
    scenario: z.enum(SANDBOX_SCENARIOS),
    /** The block key this fires at. Omitted means the first block that could produce it. */
    atBlock: z.string().max(60).optional(),
    /**
     * How many times it fires before the block behaves normally.
     *
     * `1` with a retry policy exercises the retry succeeding on the second attempt, which is the
     * behaviour most products assume and few have run.
     */
    times: z.number().int().min(1).max(10).default(1),
  })
  .strict();

export type ScenarioInjection = z.infer<typeof scenarioInjectionSchema>;

/**
 * Tracks which injections have fired.
 *
 * Stateful, and reset per sandbox run. A scenario that fired on a previous execution and stayed
 * armed would make the second run of an identical product behave differently from the first,
 * which defeats the point of a deterministic sandbox.
 */
export class ScenarioPlan {
  private readonly remaining = new Map<string, { scenario: SandboxScenario; left: number }>();

  constructor(injections: readonly ScenarioInjection[] = []) {
    for (const injection of injections) {
      this.remaining.set(injection.atBlock ?? '*', {
        scenario: injection.scenario,
        left: injection.times,
      });
    }
  }

  /** The scenario to apply at a block, consuming one firing. `success` when nothing is armed. */
  take(blockKey: string): SandboxScenario {
    const entry = this.remaining.get(blockKey) ?? this.remaining.get('*');
    if (!entry || entry.left <= 0) return 'success';

    entry.left -= 1;
    return entry.scenario;
  }

  /** Whether anything is still armed. Reported after a run, because an unfired scenario is a gap. */
  unfired(): SandboxScenario[] {
    return [...this.remaining.values()]
      .filter((entry) => entry.left > 0)
      .map((entry) => entry.scenario);
  }
}

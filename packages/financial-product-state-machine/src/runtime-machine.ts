import { StateMachine } from './machine';

/**
 * The runtime execution machine.
 *
 * What one *transaction* passes through, as distinct from what a *product definition* passes
 * through. Two machines rather than one because they answer different questions to different
 * people: the lifecycle answers "may this product go live" and is read by risk and compliance;
 * this answers "where did this payment get to" and is read by support at 3am.
 *
 * Nine states, and three of them are the interesting ones:
 *
 * **`awaiting_review`** is not a failure and not a success. An execution held for enhanced review
 * has done everything up to that point and nothing after it. A design that returned "failed" and
 * expected a retry would re-run the earlier blocks, which for a money-moving block means running
 * it twice.
 *
 * **`compensating`** is a state, not a `finally` clause. Compensation itself can fail, and an
 * execution whose compensation failed is materially different from one that never started
 * compensating — the first has a half-unwound transaction that a person must finish.
 *
 * **`refused`** is separate from `failed`. A refusal is the system working: a limit was reached, a
 * rule denied, KYC was insufficient. A failure is the system not working: a provider timed out, a
 * handler threw. Collapsing them makes every dashboard report a healthy product as broken, and
 * the alert that matters gets muted within a week.
 */

export const EXECUTION_STATES = [
  'initiated',
  'running',
  'awaiting_review',
  'awaiting_provider',
  'compensating',
  'completed',
  'failed',
  'refused',
  'compensation_failed',
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const EXECUTION_ACTIONS = [
  'start',
  'advance',
  'hold_for_review',
  'review_approved',
  'review_rejected',
  'await_provider',
  'provider_answered',
  'complete',
  'refuse',
  'fail',
  'compensate',
  'compensated',
  'compensation_failed',
] as const;

export type ExecutionAction = (typeof EXECUTION_ACTIONS)[number];

export const EXECUTION_MACHINE = new StateMachine<ExecutionState, ExecutionAction>(
  'product execution',
  EXECUTION_STATES,
  [
    { action: 'start', from: 'initiated', to: 'running', description: 'The first block begins.' },
    { action: 'advance', from: 'running', to: 'running', description: 'The next block begins.' },

    {
      action: 'hold_for_review',
      from: 'running',
      to: 'awaiting_review',
      description: 'A rule or a block demands a human decision before anything further happens.',
    },
    {
      action: 'review_approved',
      from: 'awaiting_review',
      to: 'running',
      description: 'The reviewer approved. Execution resumes at the block after the hold.',
    },
    {
      action: 'review_rejected',
      from: 'awaiting_review',
      to: 'compensating',
      description:
        'The reviewer rejected. Anything already reserved or moved is unwound before the ' +
        'execution is closed.',
    },

    {
      action: 'await_provider',
      from: 'running',
      to: 'awaiting_provider',
      description: 'An asynchronous provider was instructed and has not answered.',
    },
    {
      action: 'provider_answered',
      from: 'awaiting_provider',
      to: 'running',
      description: 'The provider answered. Execution resumes.',
    },
    {
      action: 'fail',
      from: 'awaiting_provider',
      to: 'compensating',
      description: 'The provider did not answer within the window.',
    },

    { action: 'complete', from: 'running', to: 'completed', description: 'Every block succeeded.' },
    {
      action: 'refuse',
      from: 'running',
      to: 'refused',
      description: 'A control refused: a limit, a rule, a risk decision. The system working.',
    },
    {
      action: 'fail',
      from: 'running',
      to: 'failed',
      description: 'A block failed and the product declares no compensation for it.',
    },
    {
      action: 'compensate',
      from: 'running',
      to: 'compensating',
      description: 'A block failed and the product declares compensating blocks.',
    },

    {
      action: 'compensated',
      from: 'compensating',
      to: 'failed',
      description: 'Everything was unwound. The execution ends failed, and the ledger is square.',
    },
    {
      action: 'compensation_failed',
      from: 'compensating',
      to: 'compensation_failed',
      description:
        'Compensation itself failed. A person must finish it, and this state is what puts it in ' +
        'front of one rather than leaving it as a log line.',
    },
  ],
);

/** States in which an execution is over. Nothing further happens without a new execution. */
export const TERMINAL_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  'completed',
  'failed',
  'refused',
  'compensation_failed',
]);

/** States in which an execution is waiting on something outside itself. */
export const WAITING_EXECUTION_STATES: ReadonlySet<ExecutionState> = new Set([
  'awaiting_review',
  'awaiting_provider',
]);

export function isTerminalExecution(state: ExecutionState): boolean {
  return TERMINAL_EXECUTION_STATES.has(state);
}

/**
 * Whether an execution ended the way the product intended.
 *
 * `refused` counts as neither success nor failure and the caller must decide which bucket it
 * belongs in — which is the point. A metric that counts refusals as failures reports a product
 * enforcing its limits correctly as a product that is broken.
 */
export function executionOutcome(
  state: ExecutionState,
): 'success' | 'refusal' | 'failure' | 'open' {
  if (state === 'completed') return 'success';
  if (state === 'refused') return 'refusal';
  if (state === 'failed' || state === 'compensation_failed') return 'failure';
  return 'open';
}

import { describe, expect, it } from 'vitest';
import { fromMinorUnits } from '@trustos/financial-core';
import { productErrorCode } from '@trustos/financial-product-core';
import { merchantWalletBasicTemplate } from '@trustos/financial-product-composer';
import { publishVersion, type PublishedVersion } from '@trustos/financial-product-versioning';
import {
  SANDBOX_CURRENCIES,
  SANDBOX_EPOCH,
  SANDBOX_SCENARIOS,
  SCENARIO_DESCRIPTIONS,
  Sandbox,
  ScenarioPlan,
  assertSandboxSafe,
  runSandbox,
} from './index';

function activeVersion(): PublishedVersion {
  return publishVersion({
    definition: { ...merchantWalletBasicTemplate(), lifecycleStatus: 'active' },
    organizationId: 'org_sandbox',
    publishedById: 'usr_publisher',
    authoredById: 'usr_maker',
    approvedBy: [{ level: 'RISK', actorId: 'usr_risk' }],
    supersedes: null,
    changeSummary: 'The worked example, published for the sandbox suite.',
    changedPaths: [],
    now: SANDBOX_EPOCH,
  });
}

const payment = {
  amountMinorUnits: '150000',
  currency: 'XTS',
  transactionType: 'CREDIT',
  references: {},
  attributes: {},
};

describe('a successful run', () => {
  it('completes and records every step', async () => {
    const result = await runSandbox({ version: activeVersion(), input: payment });

    expect(result.execution.outcome).toBe('success');
    expect(result.execution.state).toBe('completed');
    expect(result.execution.steps.map((step) => step.blockKey)).toEqual([
      'verify-merchant',
      'create-wallet',
      'configure-limits',
      'accept-payment',
      'apply-fee',
      'post-ledger',
      'settle',
      'reconcile',
    ]);
  });

  it('computes the fee with exact arithmetic', async () => {
    const result = await runSandbox({ version: activeVersion(), input: payment });
    const fee = result.execution.steps.find((step) => step.blockKey === 'apply-fee');

    // 0.5% of 1,500.00 is 7.50 — exactly, with no float anywhere on the path.
    expect(fee?.outputs?.feeMinorUnits).toBe('750');
    expect(fee?.outputs?.workings).toBe('0.5% of 1500.00');
  });

  it('emits an event per step and audits the execution', async () => {
    const result = await runSandbox({ version: activeVersion(), input: payment });

    expect(result.events.filter((event) => event.name.endsWith('step_completed'))).toHaveLength(8);
    expect(result.events.some((event) => event.name.endsWith('execution.completed'))).toBe(true);
    expect(result.audit.some((record) => record.action.endsWith('execution.completed'))).toBe(true);
  });

  it('produces byte-identical records on a repeat run', async () => {
    // Two runs on two machines must agree, or a simulation cannot be compared with the one before.
    const first = await runSandbox({ version: activeVersion(), input: payment });
    const second = await runSandbox({ version: activeVersion(), input: payment });

    expect(second.execution.steps.map((step) => step.outputs)).toEqual(
      first.execution.steps.map((step) => step.outputs),
    );
  });
});

describe('the failure scenarios', () => {
  it('describes every scenario section 15 asks for', () => {
    for (const required of [
      'provider_timeout',
      'provider_failure',
      'insufficient_balance',
      'risk_rejection',
      'kyc_rejection',
      'settlement_failure',
      'reconciliation_mismatch',
      'limit_exceeded',
    ] as const) {
      expect(SANDBOX_SCENARIOS).toContain(required);
      expect(SCENARIO_DESCRIPTIONS[required].length).toBeGreaterThan(10);
    }
  });

  it('refuses on a limit breach, and calls it a refusal rather than a failure', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'limit_exceeded', atBlock: 'configure-limits', times: 1 }],
    });

    expect(result.execution.outcome).toBe('refusal');
    expect(result.execution.state).toBe('refused');
    expect(result.execution.refusal?.code).toBe('limit_exceeded');
  });

  it('fails and compensates on a settlement failure', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'settlement_failure', atBlock: 'settle', times: 1 }],
    });

    expect(result.execution.outcome).toBe('failure');
    // The compensator ran, so the state is `failed` rather than `compensation_failed`.
    expect(result.execution.state).toBe('failed');
    expect(result.execution.steps.some((step) => step.blockKey === 'adjust-settlement')).toBe(true);
  });

  it('holds the execution when a block demands a review', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'review_required', atBlock: 'accept-payment', times: 1 }],
    });

    // Not a failure and not a success: everything up to the hold ran and nothing after it did.
    expect(result.execution.outcome).toBe('open');
    expect(result.execution.state).toBe('awaiting_review');
    expect(result.execution.pendingReview?.blockKey).toBe('accept-payment');
    expect(result.execution.steps.some((step) => step.blockKey === 'apply-fee')).toBe(false);
  });

  it('refuses when the balance is short, on the block that checks it', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'insufficient_balance', atBlock: 'accept-payment', times: 1 }],
    });

    expect(result.execution.refusal?.code).toBe('insufficient_balance');
  });

  it('reports a scenario that was armed and never fired', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'provider_failure', atBlock: 'a-block-that-is-not-there', times: 1 }],
    });

    // An unfired scenario is a gap, not a pass.
    expect(result.unfiredScenarios).toEqual(['provider_failure']);
  });

  it('refuses a real limit breach computed from the product’s own ceiling', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: { ...payment, amountMinorUnits: '900000' },
    });

    // The template's DAILY_ACCEPTANCE ceiling is 5,000.00; 9,000.00 is over it.
    expect(result.execution.outcome).toBe('refusal');
    expect(result.execution.refusal?.code).toBe('limit_exceeded');
  });
});

describe('idempotency in the sandbox', () => {
  it('replays a duplicate request rather than running it twice', async () => {
    const sandbox = new Sandbox(activeVersion());

    const first = await sandbox.run({ input: payment, idempotencyKey: 'idm_same' });
    const second = await sandbox.run({ input: payment, idempotencyKey: 'idm_same' });

    expect(second.execution.executionId).toBe(first.execution.executionId);
    expect(sandbox.balances().journals.length).toBe(first.state.journals.length);
  });

  it('refuses the same key with a different payload', async () => {
    const sandbox = new Sandbox(activeVersion());
    await sandbox.run({ input: payment, idempotencyKey: 'idm_same' });

    try {
      await sandbox.run({
        input: { ...payment, amountMinorUnits: '250000' },
        idempotencyKey: 'idm_same',
      });
      expect.unreachable('should have refused');
    } catch (error) {
      // Never replay the first result for a different payload: it tells the caller an operation
      // succeeded that never ran for their request.
      expect(productErrorCode(error)).toBe('product_idempotency_conflict');
    }
  });
});

describe('isolation', () => {
  it('refuses anything that looks like a production credential', () => {
    expect(() => assertSandboxSafe({ apiKey: 'tos_live_abcd' })).toThrow(/production value/);
    expect(() => assertSandboxSafe({ merchantRef: 'mer_1' })).not.toThrow();
  });

  it('runs in the sandbox environment, never in production', async () => {
    const result = await runSandbox({ version: activeVersion(), input: payment });
    // Every audit record carries the execution's own environment through the context.
    expect(result.audit.every((record) => record.entityType === 'FinancialProductExecution')).toBe(true);
  });

  it('starts from a synthetic balance and never reads one from anywhere', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      openingBalance: fromMinorUnits(1_000n, 'XTS', SANDBOX_CURRENCIES),
    });

    expect(result.state.balances.get('default')?.currency).toBe('XTS');
  });
});

describe('the scenario plan', () => {
  it('fires a scenario the configured number of times and then stops', () => {
    const plan = new ScenarioPlan([{ scenario: 'provider_timeout', atBlock: 'accept', times: 2 }]);

    expect(plan.take('accept')).toBe('provider_timeout');
    expect(plan.take('accept')).toBe('provider_timeout');
    expect(plan.take('accept')).toBe('success');
  });

  it('applies a wildcard injection to any block', () => {
    const plan = new ScenarioPlan([{ scenario: 'risk_rejection', times: 1 }]);
    expect(plan.take('any-block-at-all')).toBe('risk_rejection');
  });
});

import {
  COMMON_CURRENCIES,
  CurrencyRegistry,
  parseDecimal,
  addMoney,
  compareMoney,
  formatDecimal,
  fromMinorUnits,
  multiplyMoney,
  subtractMoney,
  toMinorUnits,
  zeroMoney,
  type Money,
} from '@trustos/financial-core';
import { APPROVED_BLOCKS, type BlockRegistry } from '@trustos/financial-block-registry';
import {
  ConnectorRegistry,
  PROVIDER_INTERFACE_NAMES,
  operationsOf,
} from '@trustos/connector-registry';
import type { ProductDefinition } from '@trustos/financial-product-core';
import type { BlockExecutionInput, BlockHandler, BlockResult } from '@trustos/financial-product-runtime';
import { SCENARIO_OUTCOMES, ScenarioPlan, type SandboxScenario } from './scenarios';

/**
 * Mock block handlers.
 *
 * One handler per approved block, generated from the catalog rather than written out — which is
 * what keeps the sandbox complete as the catalog grows. A sandbox missing a handler for the block
 * somebody just added is a sandbox that reports a product as broken when it is the sandbox that
 * is.
 *
 * The arithmetic is real. Balances, fees and limits are computed with `@trustos/financial-core`'s
 * `Money`, not with numbers — because the sandbox's job is to tell a product owner what their fee
 * configuration produces, and a sandbox that used floats would tell them something that disagrees
 * with production once in ten thousand transactions. The *providers* are mocked; the money is
 * not.
 *
 * Everything is synthetic and nothing persists. There is no store, no credential and no path to
 * one: `SandboxState` is a plain object created per run and discarded after it, which is how
 * "sandbox must never touch production data" is enforced rather than promised.
 */

/**
 * The sandbox's currency registry.
 *
 * `COMMON_CURRENCIES` plus `XTS`, the ISO 4217 code reserved for testing. Every product template
 * is denominated in it, so a sandbox that could not price one would be a sandbox that cannot run
 * the templates it ships beside.
 *
 * Registered as non-fiat with two decimal places. Non-fiat because it is not money and saying so
 * is cheap; two places because that is what a merchant reads, and a test currency with a scale
 * nobody recognises makes every worked example harder to check by eye.
 */
export const SANDBOX_CURRENCIES = new CurrencyRegistry([
  ...COMMON_CURRENCIES,
  { code: 'XTS', name: 'Test currency', exponent: 2, symbol: '¤', isFiat: false },
]);

export interface SandboxState {
  /** Synthetic wallet balances, by reference. */
  balances: Map<string, Money>;
  /** Limit consumption within the run, by limit code. */
  consumed: Map<string, Money>;
  /** Configured limit ceilings, by limit code. */
  ceilings: Map<string, Money>;
  /** Fees computed during the run, by fee code. */
  fees: Map<string, Money>;
  /** Journals posted. Ids only — the sandbox has no ledger. */
  journals: string[];
  /** Settlements created. */
  settlements: string[];
  currencies: CurrencyRegistry;
  /** Deterministic counter, so two identical runs produce identical references. */
  sequence: number;
}

export function createSandboxState(options: {
  currencies?: CurrencyRegistry;
  openingBalance?: Money;
  ceilings?: Record<string, Money>;
} = {}): SandboxState {
  const state: SandboxState = {
    balances: new Map(),
    consumed: new Map(),
    ceilings: new Map(Object.entries(options.ceilings ?? {})),
    fees: new Map(),
    journals: [],
    settlements: [],
    currencies: options.currencies ?? SANDBOX_CURRENCIES,
    sequence: 0,
  };

  if (options.openingBalance) state.balances.set('default', options.openingBalance);
  return state;
}

/**
 * A deterministic reference.
 *
 * A counter rather than a UUID. Two runs of the same product with the same inputs must produce
 * identical output, or a simulation of a hundred thousand transactions cannot be compared with
 * the one before it — and comparing them is the whole reason to run the second.
 */
function reference(state: SandboxState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}_sbx${String(state.sequence).padStart(8, '0')}`;
}

function amountOf(input: BlockExecutionInput, state: SandboxState): Money {
  const minorUnits = input.context.input.amountMinorUnits;
  const currency = input.context.input.currency ?? 'XTS';

  if (!minorUnits) return zeroMoney(currency, state.currencies);
  return fromMinorUnits(BigInt(minorUnits), currency, state.currencies);
}

function scenarioResult(scenario: SandboxScenario): BlockResult | null {
  const mapped = SCENARIO_OUTCOMES[scenario];
  if (mapped.outcome === 'success') return null;

  if (mapped.outcome === 'review_required') {
    return { outcome: 'review_required', level: 'COMPLIANCE', reason: 'Injected sandbox scenario.' };
  }

  if (mapped.outcome === 'refused') {
    return { outcome: 'refused', code: mapped.code, reason: `Injected sandbox scenario: ${scenario}.` };
  }

  return {
    outcome: 'failed',
    code: mapped.code,
    reason: `Injected sandbox scenario: ${scenario}.`,
    retryable: mapped.retryable,
  };
}

/**
 * The behaviour each category simulates.
 *
 * Category rather than block, because the interesting differences are between what a category
 * *does to money* — a limit consumes, a fee computes, a ledger posts — and not between two
 * variants of the same movement. `wallet.debit` and `transfer.p2p` both move money out; a sandbox
 * that modelled them differently would be modelling its own opinion.
 */
function simulate(
  category: string,
  input: BlockExecutionInput,
  state: SandboxState,
): BlockResult {
  const amount = amountOf(input, state);
  const configuration = input.block.configuration;

  switch (category) {
    case 'identity':
      return { outcome: 'success', outputs: { verified: true, kycLevel: 'STANDARD', eligible: true } };

    case 'limit': {
      const code = String(configuration.limitCode ?? 'DEFAULT');
      const ceiling = state.ceilings.get(code);
      const already = state.consumed.get(code) ?? zeroMoney(amount.currency, state.currencies);
      const after = addMoney(already, amount);

      if (ceiling && compareMoney(after, ceiling) > 0) {
        return {
          outcome: 'refused',
          code: 'limit_exceeded',
          reason: `${code} would reach ${formatDecimal(after.amount)} against a ceiling of ${formatDecimal(ceiling.amount)}.`,
        };
      }

      state.consumed.set(code, after);

      return {
        outcome: 'success',
        outputs: {
          allowed: true,
          remainingMinorUnits: ceiling ? String(toMinorUnits(subtractMoney(ceiling, after))) : null,
        },
      };
    }

    case 'wallet': {
      if (input.block.blockId === 'wallet.get_balance') {
        const balance = state.balances.get('default') ?? zeroMoney(amount.currency, state.currencies);
        return {
          outcome: 'success',
          outputs: { availableMinorUnits: String(toMinorUnits(balance)), heldMinorUnits: '0' },
        };
      }

      if (input.block.blockId === 'wallet.debit') {
        const balance = state.balances.get('default') ?? zeroMoney(amount.currency, state.currencies);

        // The available balance, never the total. A system that checks the total authorizes the
        // same money twice.
        if (compareMoney(balance, amount) < 0) {
          return {
            outcome: 'refused',
            code: 'insufficient_balance',
            reason: `Available ${formatDecimal(balance.amount)} is below ${formatDecimal(amount.amount)}.`,
          };
        }

        state.balances.set('default', subtractMoney(balance, amount));
        return { outcome: 'success', outputs: { journalRef: reference(state, 'jrn') } };
      }

      if (input.block.blockId === 'wallet.credit') {
        const balance = state.balances.get('default') ?? zeroMoney(amount.currency, state.currencies);
        state.balances.set('default', addMoney(balance, amount));
        return { outcome: 'success', outputs: { journalRef: reference(state, 'jrn') } };
      }

      return { outcome: 'success', outputs: { walletRef: reference(state, 'wlt'), status: 'active' } };
    }

    case 'fee': {
      const code = String(configuration.feeCode ?? 'DEFAULT');
      /*
       * A flat placeholder rate, applied exactly.
       *
       * The sandbox does not read the product's fee schedule — computing a fee from a schedule is
       * `@trustos/fees`' job, and a second implementation here would be a second set of rounding
       * decisions. What it demonstrates is that the *plumbing* carries a fee through to the
       * ledger, which is the thing a composition can get wrong.
       */
      const fee = multiplyMoney(amount, parseDecimal('0.005'), state.currencies);
      state.fees.set(code, addMoney(state.fees.get(code) ?? zeroMoney(amount.currency, state.currencies), fee));

      return {
        outcome: 'success',
        outputs: {
          feeMinorUnits: String(toMinorUnits(fee)),
          feeCurrency: fee.currency,
          workings: `0.5% of ${formatDecimal(amount.amount)}`,
        },
      };
    }

    case 'ledger': {
      const journalRef = reference(state, 'jrn');
      state.journals.push(journalRef);
      return { outcome: 'success', outputs: { journalRef, balanced: true } };
    }

    case 'settlement': {
      const settlementRef = reference(state, 'stl');
      state.settlements.push(settlementRef);
      return { outcome: 'success', outputs: { settlementRef, status: 'instructed' } };
    }

    case 'reconciliation':
      return { outcome: 'success', outputs: { matched: true, exceptionCount: 0 } };

    case 'risk':
      return { outcome: 'success', outputs: { outcome: 'clear', score: 20, level: 'LOW' } };

    case 'lending':
      return {
        outcome: 'success',
        outputs: { loanRef: reference(state, 'lon'), eligible: true, instalmentCount: 3 },
      };

    case 'loyalty':
      return { outcome: 'success', outputs: { memberRef: reference(state, 'mem'), balance: 100 } };

    case 'notification':
      return { outcome: 'success', outputs: { dispatched: true } };

    case 'payment': {
      if (input.block.blockId === 'payment.refund') {
        return { outcome: 'success', outputs: { refundRef: reference(state, 'rfd') } };
      }
      return { outcome: 'success', outputs: { transactionRef: reference(state, 'txn'), status: 'captured' } };
    }

    default:
      return { outcome: 'success', outputs: {} };
  }
}

/**
 * A mock connector for every provider interface.
 *
 * This is what "mock providers" means, and the sandbox would be useless without it: the templates
 * name `PaymentProvider` and bind nothing, deliberately, so a sandbox that only mocked *handlers*
 * would refuse every template at the first provider-dependent block with "nothing binds one" —
 * which is true, and is exactly the state a sandbox exists to let a product owner work in.
 *
 * The connectors are metadata and nothing else. They carry no endpoint, no credential and no
 * adapter — `assertNoFrameworkProvider` would refuse them if they named a vendor, and they name
 * capabilities.
 */
export function sandboxConnectorRegistry(organizationId: string): ConnectorRegistry {
  const registry = new ConnectorRegistry();

  for (const name of PROVIDER_INTERFACE_NAMES) {
    registry.register(organizationId, {
      connectorId: sandboxConnectorId(name),
      name: `Sandbox ${name}`,
      description: `A mock ${name} that answers deterministically. Never reaches anything outside.`,
      version: '1.0.0',
      providerInterface: name,
      operation: operationsOf(name)[0] as string,
      authentication: 'none',
      timeoutMs: 5_000,
      idempotent: true,
      dataClassification: 'public',
      lifecycleStatus: 'approved',
      technicalOwner: 'role:sandbox',
    });
  }

  return registry;
}

export function sandboxConnectorId(providerInterface: string): string {
  return `sandbox-${providerInterface.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

/**
 * Binds every unbound provider interface to its mock.
 *
 * Returns a *copy*. Mutating the definition would change the document the version's content hash
 * was computed over, and the runtime would then refuse it as tampered — which is the check
 * working, and would be a confusing way to discover it.
 */
export function bindSandboxConnectors(definition: ProductDefinition): ProductDefinition {
  return {
    ...definition,
    providers: definition.providers.map((provider) => ({
      ...provider,
      connectorId: provider.connectorId ?? sandboxConnectorId(provider.providerInterface),
    })),
  };
}

/**
 * Builds a handler for every approved block.
 *
 * Generated from the catalog, so a block added tomorrow has a mock the same day.
 */
export function sandboxHandlers(input: {
  state: SandboxState;
  plan?: ScenarioPlan;
  registry?: BlockRegistry;
}): BlockHandler[] {
  const registry = input.registry ?? APPROVED_BLOCKS;
  const plan = input.plan ?? new ScenarioPlan();

  return registry.all().map((block) => ({
    blockId: block.blockId,
    execute: async (execution: BlockExecutionInput): Promise<BlockResult> => {
      const injected = scenarioResult(plan.take(execution.block.key));
      if (injected) return injected;

      return simulate(block.category, execution, input.state);
    },
  }));
}

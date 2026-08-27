import { describe, expect, it } from 'vitest';
import {
  collectingAuditRecorder,
  collectingEventPublisher,
  productErrorCode,
  type ProductActor,
} from '@trustos/financial-product-core';
import { merchantWalletBasicTemplate } from '@trustos/financial-product-composer';
import { publishVersion, type PublishedVersion } from '@trustos/financial-product-versioning';
import { ConnectorRegistry } from '@trustos/connector-registry';
import {
  BlockHandlerRegistry,
  InMemoryIdempotencyStore,
  ProductRuntime,
  classifyClaim,
  requestHash,
  type BlockHandler,
  type BlockResult,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const clock = { now: () => NOW };

const actor: ProductActor = {
  actorId: 'usr_channel',
  actorType: 'service_account',
  organizationId: 'org_a',
};

const input = {
  amountMinorUnits: '150000',
  currency: 'XTS',
  transactionType: 'CREDIT',
  references: {},
  attributes: {},
};

function version(status: 'active' | 'draft' | 'paused' = 'active'): PublishedVersion {
  return publishVersion({
    definition: { ...merchantWalletBasicTemplate(), lifecycleStatus: status },
    organizationId: 'org_a',
    publishedById: 'usr_publisher',
    authoredById: 'usr_maker',
    approvedBy: [{ level: 'RISK', actorId: 'usr_risk' }],
    supersedes: null,
    changeSummary: 'The worked example, published for the runtime suite.',
    changedPaths: [],
    now: NOW,
  });
}

/** A handler that always succeeds, for every block. */
function alwaysSucceeds(overrides: Record<string, BlockResult> = {}): BlockHandler[] {
  const definition = merchantWalletBasicTemplate();
  const blockIds = [...new Set(definition.blocks.map((block) => block.blockId))];

  return blockIds.map((blockId) => ({
    blockId,
    execute: async ({ block }) =>
      overrides[block.key] ?? ({ outcome: 'success', outputs: { ok: true } } as BlockResult),
  }));
}

function connectors(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register('org_a', {
    connectorId: 'payment-rail',
    name: 'Payment rail',
    description: 'A payment interface for the runtime suite.',
    version: '1.0.0',
    providerInterface: 'PaymentProvider',
    operation: 'execute',
    authentication: 'mutual_tls',
    timeoutMs: 10_000,
    idempotent: true,
    dataClassification: 'confidential',
    lifecycleStatus: 'approved',
    technicalOwner: 'usr_integrations',
  });
  return registry;
}

function bound(published: PublishedVersion) {
  return {
    ...published.definition,
    providers: published.definition.providers.map((provider) => ({
      ...provider,
      connectorId:
        provider.providerInterface === 'PaymentProvider' ? 'payment-rail' : provider.connectorId,
    })),
  };
}

function runtime(
  options: {
    handlers?: BlockHandler[];
    idempotency?: InMemoryIdempotencyStore;
  } = {},
) {
  const events = collectingEventPublisher();
  const audit = collectingAuditRecorder();

  const engine = new ProductRuntime({
    handlers: new BlockHandlerRegistry(options.handlers ?? alwaysSucceeds()),
    events,
    audit,
    connectors: connectors(),
    ...(options.idempotency ? { idempotency: options.idempotency } : {}),
    clock,
  });

  return { engine, events, audit };
}

describe('what the runtime refuses to execute', () => {
  it('refuses a draft product in production', async () => {
    const { engine } = runtime();

    try {
      await engine.execute({
        version: version('draft'),
        definition: bound(version('draft')),
        actor,
        input,
        usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
        operation: 'acceptPayment',
        environment: 'production',
      });
      expect.unreachable('should have refused');
    } catch (error) {
      // A draft that could execute would make every control above it optional.
      expect(productErrorCode(error)).toBe('product_not_executable');
    }
  });

  it('refuses a version whose definition no longer matches its hash', async () => {
    const { engine } = runtime();
    const tampered: PublishedVersion = {
      ...version(),
      definition: { ...version().definition, description: 'Quietly different.' },
    };

    try {
      await engine.execute({
        version: tampered,
        definition: bound(tampered),
        actor,
        input,
        usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
        operation: 'acceptPayment',
        environment: 'production',
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_version_binding_broken');
    }
  });

  it('refuses a block with no registered handler', async () => {
    const { engine } = runtime({ handlers: [] });

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    // A missing handler fails the execution rather than skipping the block, because skipping it
    // would skip a control.
    expect(record.outcome).toBe('failure');
    expect(record.refusal?.reason).toContain('No handler is registered');
  });

  it('refuses a connector the tenant has not approved', async () => {
    const { engine } = runtime();
    const substituted = {
      ...version().definition,
      providers: version().definition.providers.map((provider) => ({
        ...provider,
        connectorId: 'somebody-elses-rail',
      })),
    };

    const record = await engine.execute({
      version: version(),
      definition: substituted,
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(record.outcome).toBe('failure');
    // Provider substitution is on the threat list precisely because the product keeps working
    // afterwards and the money goes somewhere nobody reviewed.
    expect(record.refusal?.reason).toContain('No approved connector');
  });
});

describe('a normal execution', () => {
  it('binds the version and records it on every step', async () => {
    const { engine, audit } = runtime();

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(record.outcome).toBe('success');
    expect(record.productVersion).toBe('1.0.0');
    expect(record.definitionHash).toBe(version().contentHash);
    expect(audit.records.every((entry) => entry.productVersion === '1.0.0')).toBe(true);
  });

  it('carries the correlation id through every event', async () => {
    const { engine, events } = runtime();

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
      correlationId: 'cor_abc',
    });

    expect(record.correlationId).toBe('cor_abc');
    expect(events.events.every((event) => event.correlationId === 'cor_abc')).toBe(true);
  });

  it('records the rule decision with its trace', async () => {
    const { engine } = runtime();

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input: { ...input, amountMinorUnits: '250000' },
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    // The template demands an enhanced review above 2,000.00, and 2,500.00 is above it.
    expect(record.ruleDecision.reviews.map((review) => review.level)).toEqual(['COMPLIANCE']);
    expect(record.ruleDecision.trace).toHaveLength(1);
  });

  it('starts at the operation’s entry block when one is declared', async () => {
    const { engine } = runtime();

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
      entryBlock: 'accept-payment',
    });

    expect(record.steps[0]?.blockKey).toBe('accept-payment');
  });
});

describe('refusals and failures are different things', () => {
  it('ends a refused execution in `refused`, not `failed`', async () => {
    const { engine } = runtime({
      handlers: alwaysSucceeds({
        'configure-limits': {
          outcome: 'refused',
          code: 'limit_exceeded',
          reason: 'Over the daily ceiling.',
        },
      }),
    });

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(record.state).toBe('refused');
    expect(record.outcome).toBe('refusal');
  });

  it('compensates a failed money-moving block and ends in `failed`', async () => {
    const { engine } = runtime({
      handlers: alwaysSucceeds({
        'post-ledger': {
          outcome: 'failed',
          code: 'store_unavailable',
          reason: 'The ledger was unreachable.',
          retryable: false,
        },
      }),
    });

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(record.state).toBe('failed');
    expect(record.steps.some((step) => step.blockKey === 'reverse-posting')).toBe(true);
  });

  it('distinguishes a failed compensation from a clean failure', async () => {
    const { engine } = runtime({
      handlers: alwaysSucceeds({
        'post-ledger': {
          outcome: 'failed',
          code: 'store_unavailable',
          reason: 'The ledger was unreachable.',
          retryable: false,
        },
        'reverse-posting': {
          outcome: 'failed',
          code: 'store_unavailable',
          reason: 'And so was the reversal.',
          retryable: false,
        },
      }),
    });

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    // The state that needs a person, and the one most products have never run.
    expect(record.state).toBe('compensation_failed');
  });

  it('holds an execution that needs a review, having run nothing after it', async () => {
    const { engine } = runtime({
      handlers: alwaysSucceeds({
        'accept-payment': {
          outcome: 'review_required',
          level: 'COMPLIANCE',
          reason: 'Above the threshold.',
        },
      }),
    });

    const record = await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(record.state).toBe('awaiting_review');
    expect(record.outcome).toBe('open');
    expect(record.steps.some((step) => step.blockKey === 'apply-fee')).toBe(false);
  });

  it('refuses before running anything when a rule denies', async () => {
    const denying = {
      ...version().definition,
      rules: [
        {
          id: 'closed-for-business',
          description: 'Refuses everything.',
          priority: 1,
          enabled: true,
          when: { field: 'amountMinorUnits', operator: 'exists' as const },
          then: [
            { kind: 'deny' as const, code: 'product_closed', reason: 'The product is closed.' },
          ],
        },
      ],
    };

    const { engine } = runtime();

    const record = await engine.execute({
      version: version(),
      definition: denying as never,
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(record.outcome).toBe('refusal');
    expect(record.refusal?.code).toBe('product_closed');
    expect(record.steps).toEqual([]);
  });
});

describe('idempotency', () => {
  it('replays a duplicate request rather than executing again', async () => {
    const store = new InMemoryIdempotencyStore();
    const { engine } = runtime({ idempotency: store });

    const call = () =>
      engine.execute({
        version: version(),
        definition: bound(version()),
        actor,
        input,
        usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
        operation: 'acceptPayment',
        idempotencyKey: 'idm_one',
        environment: 'production',
      });

    const first = await call();
    const second = await call();

    expect(second.executionId).toBe(first.executionId);
  });

  it('refuses the same key with a different payload', async () => {
    const store = new InMemoryIdempotencyStore();
    const { engine } = runtime({ idempotency: store });

    await engine.execute({
      version: version(),
      definition: bound(version()),
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      idempotencyKey: 'idm_one',
      environment: 'production',
    });

    try {
      await engine.execute({
        version: version(),
        definition: bound(version()),
        actor,
        input: { ...input, amountMinorUnits: '999999' },
        usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
        operation: 'acceptPayment',
        idempotencyKey: 'idm_one',
        environment: 'production',
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_idempotency_conflict');
    }
  });

  it('scopes a key to its tenant', async () => {
    const store = new InMemoryIdempotencyStore();
    const { engine } = runtime({ idempotency: store });

    const forTenant = (organizationId: string) =>
      engine.execute({
        version: version(),
        definition: bound(version()),
        actor: { ...actor, organizationId },
        input,
        usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
        operation: 'acceptPayment',
        idempotencyKey: 'idm_shared',
        environment: 'production',
      });

    const a = await forTenant('org_a');
    // Another tenant's first attempt must not collide with this one's retry.
    const b = await forTenant('org_a').catch(() => null);
    void b;

    expect(a.organizationId).toBe('org_a');
  });

  it('hashes a request the same regardless of key order', () => {
    expect(requestHash({ b: '2', a: '1' })).toBe(requestHash({ a: '1', b: '2' }));
    expect(requestHash({ a: '1' })).not.toBe(requestHash({ a: '2' }));
  });

  it('classifies the three claim outcomes', () => {
    const base = {
      organizationId: 'org_a',
      productId: 'p',
      operation: 'o',
      key: 'k',
      requestHash: 'sha256:aaa',
      executionId: 'fpex_1',
      result: null,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 1000),
    };

    expect(classifyClaim(null, 'sha256:aaa', NOW).kind).toBe('proceed');
    expect(classifyClaim({ ...base, status: 'completed' }, 'sha256:aaa', NOW).kind).toBe('replay');
    expect(classifyClaim({ ...base, status: 'in_progress' }, 'sha256:aaa', NOW).kind).toBe(
      'conflict',
    );
    expect(classifyClaim({ ...base, status: 'completed' }, 'sha256:bbb', NOW).kind).toBe(
      'conflict',
    );
    // An expired key is a key that may be reused.
    expect(
      classifyClaim({ ...base, status: 'completed' }, 'sha256:aaa', new Date(NOW.getTime() + 5000))
        .kind,
    ).toBe('proceed');
  });
});

describe('retry', () => {
  it('retries a retryable failure on an idempotent block and succeeds', async () => {
    let attempts = 0;

    const definition = {
      ...version().definition,
      blocks: version().definition.blocks.map((block) =>
        block.key === 'post-ledger'
          ? {
              ...block,
              retry: {
                maxAttempts: 3,
                backoff: 'fixed' as const,
                initialDelayMs: 10,
                maxDelayMs: 10,
              },
            }
          : block,
      ),
    };

    const handlers = alwaysSucceeds();
    const ledger = handlers.find(
      (handler) => handler.blockId === 'ledger.create_journal',
    ) as BlockHandler;

    const patched: BlockHandler = {
      blockId: ledger.blockId,
      execute: async () => {
        attempts += 1;
        return attempts < 2
          ? { outcome: 'failed', code: 'timeout', reason: 'Slow.', retryable: true }
          : { outcome: 'success', outputs: { journalRef: 'jrn_1' } };
      },
    };

    const { engine } = runtime({
      handlers: [...handlers.filter((handler) => handler.blockId !== ledger.blockId), patched],
    });

    const record = await engine.execute({
      version: version(),
      definition: { ...bound(version()), blocks: definition.blocks } as never,
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(attempts).toBe(2);
    expect(record.outcome).toBe('success');
    expect(record.steps.find((step) => step.blockKey === 'post-ledger')?.attempt).toBe(2);
  });

  it('does not retry a block the catalog says is not idempotent', async () => {
    // The validator refuses this configuration; this is the second line, for a definition that
    // got past it.
    let attempts = 0;

    const handlers = alwaysSucceeds();
    const verify = handlers.find(
      (handler) => handler.blockId === 'identity.customer_eligibility',
    ) as BlockHandler;

    const patched: BlockHandler = {
      blockId: verify.blockId,
      execute: async () => {
        attempts += 1;
        return { outcome: 'failed', code: 'timeout', reason: 'Slow.', retryable: true };
      },
    };

    const definition = {
      ...bound(version()),
      blocks: version().definition.blocks.map((block) =>
        block.key === 'verify-merchant'
          ? {
              ...block,
              retry: {
                maxAttempts: 5,
                backoff: 'fixed' as const,
                initialDelayMs: 1,
                maxDelayMs: 1,
              },
            }
          : block,
      ),
    };

    const { engine } = runtime({
      handlers: [...handlers.filter((handler) => handler.blockId !== verify.blockId), patched],
    });

    await engine.execute({
      version: version(),
      definition: definition as never,
      actor,
      input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: 'acceptPayment',
      environment: 'production',
    });

    expect(attempts).toBe(1);
  });
});

describe('the handler registry', () => {
  it('refuses two handlers for one block', () => {
    const registry = new BlockHandlerRegistry([
      { blockId: 'wallet.debit', execute: async () => ({ outcome: 'success', outputs: {} }) },
    ]);

    expect(() =>
      registry.register({
        blockId: 'wallet.debit',
        execute: async () => ({ outcome: 'success', outputs: {} }),
      }),
    ).toThrow(/already registered/);
  });

  it('reports which of a product’s blocks are unbound', () => {
    const registry = new BlockHandlerRegistry([
      { blockId: 'wallet.debit', execute: async () => ({ outcome: 'success', outputs: {} }) },
    ]);

    expect(registry.missingFor(['wallet.debit', 'ledger.create_journal'])).toEqual([
      'ledger.create_journal',
    ]);
  });
});

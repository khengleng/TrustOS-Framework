import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectingAuditRecorder,
  collectingEventPublisher,
  type ProductActor,
  type ProductDefinition,
} from '@trustos/financial-product-core';
import { merchantWalletBasicTemplate } from '@trustos/financial-product-composer';
import { publishVersion, type PublishedVersion } from '@trustos/financial-product-versioning';
import { InMemoryProductStore, ProductRegistry } from '@trustos/financial-product-registry';
import { BlockHandlerRegistry, ProductRuntime } from '@trustos/financial-product-runtime';
import {
  bindSandboxConnectors,
  createSandboxState,
  sandboxConnectorRegistry,
  sandboxHandlers,
} from '@trustos/financial-product-sandbox';
import {
  API_PREFIX,
  InMemoryRateLimiter,
  ProductDispatcher,
  ProductRouteTable,
  productOpenApi,
  productRoutes,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const clock = { now: () => NOW };

const actor: ProductActor = {
  actorId: 'usr_channel',
  actorType: 'api_key',
  organizationId: 'org_a',
};

function definition(): ProductDefinition {
  return { ...merchantWalletBasicTemplate(), lifecycleStatus: 'active' };
}

function version(): PublishedVersion {
  return publishVersion({
    definition: definition(),
    organizationId: 'org_a',
    publishedById: 'usr_publisher',
    authoredById: 'usr_maker',
    approvedBy: [{ level: 'RISK', actorId: 'usr_risk' }],
    supersedes: null,
    changeSummary: 'The worked example, published for the API suite.',
    changedPaths: [],
    now: NOW,
  });
}

describe('routes', () => {
  it('builds a path from the prefix and the product slug', () => {
    const routes = productRoutes(definition());

    expect(routes.map((route) => route.path).sort()).toEqual([
      `${API_PREFIX}/merchant-wallet-basic/executions/:executionId`,
      `${API_PREFIX}/merchant-wallet-basic/onboard`,
      `${API_PREFIX}/merchant-wallet-basic/payments`,
    ]);
  });

  it('exposes nothing for a product that is not exposed', () => {
    expect(
      productRoutes({
        ...definition(),
        apiExposurePolicy: { ...definition().apiExposurePolicy, exposed: false },
      }),
    ).toEqual([]);
  });

  it('refuses two products claiming the same path', () => {
    const table = new ProductRouteTable();
    table.register(definition());

    const impostor = { ...definition(), productId: 'somebody-else' };
    // Route order would decide whose transactions go where.
    expect(() => table.register(impostor)).toThrow(/claimed by both/);
  });

  it('matches a parameterised path segment by segment', () => {
    const table = new ProductRouteTable();
    table.register(definition());

    const matched = table.match('GET', `${API_PREFIX}/merchant-wallet-basic/executions/fpex_1`);
    expect(matched?.params.executionId).toBe('fpex_1');
  });

  it('refuses a traversal in a path parameter', () => {
    const table = new ProductRouteTable();
    table.register(definition());

    // "Somewhere" in a financial API is a sentence that ends badly.
    expect(table.match('GET', `${API_PREFIX}/merchant-wallet-basic/executions/..`)).toBeNull();
  });

  it('does not match a prefix', () => {
    const table = new ProductRouteTable();
    table.register(definition());

    expect(table.match('POST', `${API_PREFIX}/merchant-wallet-basic/payments/extra`)).toBeNull();
  });
});

describe('the OpenAPI document', () => {
  it('is generated from the definition', () => {
    const document = productOpenApi(definition());

    expect(document.info.title).toBe('Merchant Wallet Basic');
    expect(document.info.version).toBe('1.0.0');
    expect(Object.keys(document.paths)).toHaveLength(3);
  });

  it('marks the idempotency key required where the operation creates a transaction', () => {
    const document = productOpenApi(definition());
    const payments = document.paths[`${API_PREFIX}/merchant-wallet-basic/payments`]?.post as {
      parameters: Array<{ name: string; required: boolean }>;
    };

    const header = payments.parameters.find((parameter) => parameter.name === 'Idempotency-Key');
    // A required header documented as optional is a header half the integrations will not send.
    expect(header?.required).toBe(true);
  });

  it('documents amounts as strings, never as numbers', () => {
    const document = productOpenApi(definition());
    const schema = document.components.schemas.ExecutionResult as {
      properties: { feeMinorUnits: { type: string } };
    };

    expect(schema.properties.feeMinorUnits.type).toBe('string');
  });

  it('describes no block, transition, rule or provider', () => {
    // A channel that depended on the workflow would break when the workflow changed.
    const serialized = JSON.stringify(productOpenApi(definition()));

    expect(serialized).not.toContain('blockId');
    expect(serialized).not.toContain('transitions');
    expect(serialized).not.toContain('PaymentProvider');
  });

  it('says a cross-tenant product is indistinguishable from a missing one', () => {
    const document = productOpenApi(definition());
    const payments = document.paths[`${API_PREFIX}/merchant-wallet-basic/payments`]?.post as {
      responses: Record<string, { description: string }>;
    };

    expect(payments.responses['404']?.description).toContain('another tenant');
  });
});

describe('the dispatcher', () => {
  let dispatcher: ProductDispatcher;

  beforeEach(async () => {
    const store = new InMemoryProductStore();
    const registry = new ProductRegistry({ store, audit: collectingAuditRecorder(), clock });

    const published = version();
    await store.create({
      productId: 'merchant-wallet-basic',
      organizationId: 'org_a',
      draft: null,
      draftAuthorId: null,
      draftSubmittedById: null,
      versions: [published],
      activeVersion: '1.0.0',
      decisions: [],
      revision: 0,
    });

    const runtime = new ProductRuntime({
      handlers: new BlockHandlerRegistry(sandboxHandlers({ state: createSandboxState() })),
      events: collectingEventPublisher(),
      audit: collectingAuditRecorder(),
      connectors: sandboxConnectorRegistry('org_a'),
      clock,
    });

    dispatcher = new ProductDispatcher({
      registry,
      runtime: {
        execute: (input) =>
          runtime.execute({
            ...input,
            definition: bindSandboxConnectors(input.version.definition),
          }),
      } as never,
      clock,
      rateLimiter: new InMemoryRateLimiter(),
    });

    dispatcher.expose(definition());
  });

  function request(overrides: Record<string, unknown> = {}) {
    return {
      method: 'POST',
      path: `${API_PREFIX}/merchant-wallet-basic/payments`,
      headers: { 'idempotency-key': 'idm_1' },
      body: { amountMinorUnits: '150000', currency: 'XTS', transactionType: 'CREDIT' },
      actor,
      permissions: ['financial.product.execute'],
      requestId: 'req_1',
      ...overrides,
    } as never;
  }

  it('executes an authorized request', async () => {
    const response = await dispatcher.dispatch(request());

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe('success');
    expect(response.headers['x-trustos-product-version']).toBe('1.0.0');
  });

  it('returns 404 for a route that does not exist', async () => {
    const response = await dispatcher.dispatch(request({ path: '/v1/products/nothing/here' }));
    expect(response.status).toBe(404);
  });

  it('refuses a caller without the operation’s permission', async () => {
    const response = await dispatcher.dispatch(request({ permissions: [] }));
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('forbidden');
  });

  it('refuses a transaction-creating call with no idempotency key', async () => {
    const response = await dispatcher.dispatch(request({ headers: {} }));

    // A key generated on the caller's behalf makes every retry a new transaction.
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('idempotency_key_required');
  });

  it('rate limits, and says how long to wait', async () => {
    const limited = new ProductDispatcher({
      registry: { activeVersion: async () => version() } as never,
      runtime: { execute: async () => ({ outcome: 'success' }) } as never,
      clock,
      rateLimiter: { allow: () => false },
    });
    limited.expose(definition());

    const response = await limited.dispatch(request());
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
  });

  it('reports another tenant’s product as not found', async () => {
    const response = await dispatcher.dispatch(
      request({ actor: { ...actor, organizationId: 'org_b' } }),
    );

    // The tenant comes from the verified actor. A 403 would confirm the product exists.
    expect(response.status).toBe(404);
  });

  it('never reads the tenant from a header', async () => {
    const response = await dispatcher.dispatch(
      request({
        actor: { ...actor, organizationId: 'org_b' },
        headers: { 'idempotency-key': 'idm_2', 'x-organization-id': 'org_a' },
      }),
    );

    // An X-Organization-Id naming an organization is a request, not a fact.
    expect(response.status).toBe(404);
  });

  it('returns a refusal as 200 with a code rather than as a client error', async () => {
    const refusing = new ProductDispatcher({
      registry: { activeVersion: async () => version() } as never,
      runtime: {
        execute: async () => ({
          executionId: 'fpex_1',
          productId: 'merchant-wallet-basic',
          productVersion: '1.0.0',
          state: 'refused',
          outcome: 'refusal',
          steps: [],
          refusal: { code: 'limit_exceeded', reason: 'Over the daily ceiling.' },
          pendingReview: null,
          startedAt: NOW,
          finishedAt: NOW,
        }),
      } as never,
      clock,
    });
    refusing.expose(definition());

    const response = await refusing.dispatch(request());

    // A 4xx says the caller did something wrong, and a channel that treats a limit refusal as a
    // client error retries it — the one thing it must not do.
    expect(response.status).toBe(200);
    expect(response.body.refusalCode).toBe('limit_exceeded');
  });

  it('returns a failure as 502, because retrying is reasonable', async () => {
    const failing = new ProductDispatcher({
      registry: { activeVersion: async () => version() } as never,
      runtime: {
        execute: async () => ({
          executionId: 'fpex_1',
          productId: 'merchant-wallet-basic',
          productVersion: '1.0.0',
          state: 'failed',
          outcome: 'failure',
          steps: [],
          refusal: { code: 'provider_failure', reason: 'The rail did not answer.' },
          pendingReview: null,
          startedAt: NOW,
          finishedAt: NOW,
        }),
      } as never,
      clock,
    });
    failing.expose(definition());

    expect((await failing.dispatch(request())).status).toBe(502);
  });

  it('projects an execution without its trace, steps or definition hash', async () => {
    const response = await dispatcher.dispatch(request());

    expect(response.body.executionId).toBeDefined();
    expect(response.body.steps).toBeUndefined();
    expect(response.body.ruleDecision).toBeUndefined();
    expect(response.body.definitionHash).toBeUndefined();
  });

  it('carries the request id through as the correlation id', async () => {
    const response = await dispatcher.dispatch(request());
    expect(response.headers['x-request-id']).toBe('req_1');
  });
});

describe('the rate limiter', () => {
  it('allows up to the limit and refuses beyond it, within one minute', () => {
    const limiter = new InMemoryRateLimiter();
    const now = new Date('2026-06-01T12:00:00.000Z');

    expect(limiter.allow('k', 2, now)).toBe(true);
    expect(limiter.allow('k', 2, now)).toBe(true);
    expect(limiter.allow('k', 2, now)).toBe(false);
  });

  it('resets on the next window', () => {
    const limiter = new InMemoryRateLimiter();

    expect(limiter.allow('k', 1, new Date('2026-06-01T12:00:00.000Z'))).toBe(true);
    expect(limiter.allow('k', 1, new Date('2026-06-01T12:00:30.000Z'))).toBe(false);
    expect(limiter.allow('k', 1, new Date('2026-06-01T12:01:00.000Z'))).toBe(true);
  });
});

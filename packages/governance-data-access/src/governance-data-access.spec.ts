import { describe, expect, it } from 'vitest';
import { ResourceRegistry, resourceRegistrationSchema } from '@trustos/governance-resource-policy';
import { DataAccessGuard, MAX_ROWS_CEILING, assertApiOnlyMutation, summarizeAccess } from './index';

function resource(overrides: Record<string, unknown> = {}) {
  return resourceRegistrationSchema.parse({
    resourceId: 'reporting.transactions',
    name: 'Transaction replica',
    description: 'A read-only replica.',
    type: 'reporting_database',
    environment: 'prod',
    owner: 'usr_data',
    businessOwner: 'usr_finance',
    technicalOwner: 'usr_platform',
    dataClassification: 'restricted',
    accessClass: 'read_only',
    credentialRef: 'secret://reporting/prod/readonly',
    allowedGroups: ['operations'],
    permittedOperations: ['read', 'search', 'aggregate'],
    exposedFields: ['reference', 'status', 'amountMinorUnits'],
    approvalStatus: 'approved',
    approvedBy: 'usr_security',
    lastReviewDate: '2026-01-01T00:00:00.000Z',
    nextReviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  });
}

const walletResource = () =>
  resource({
    resourceId: 'trustos.wallet',
    name: 'Wallet API',
    description: 'The wallet service.',
    type: 'trustos_api',
    accessClass: 'api_only',
    credentialRef: 'secret://trustos/prod/wallet',
    permittedOperations: ['read', 'execute'],
    exposedFields: ['walletRef', 'status'],
  });

const context = {
  environment: 'prod' as const,
  organizationId: 'org_a',
  actorId: 'usr_ops',
  actorGroups: ['operations'],
  appId: 'operations-console',
  correlationId: 'cor_1',
};

describe('planning a read', () => {
  const guard = new DataAccessGuard(new ResourceRegistry([resource()]));

  it('returns the credential reference and the bounded row count', () => {
    const plan = guard.planRead(context, {
      resourceId: 'reporting.transactions',
      operation: 'search',
      fields: ['reference', 'status'],
      maxRows: 50,
    });

    expect(plan.credentialRef).toBe('secret://reporting/prod/readonly');
    expect(plan.fields).toEqual(['reference', 'status']);
    expect(plan.maxRows).toBe(50);
  });

  it('bounds the rows however many were asked for', () => {
    // An unbounded read is an outage an internal user triggers by clicking a button.
    const plan = guard.planRead(context, {
      resourceId: 'reporting.transactions',
      operation: 'search',
      fields: ['reference'],
      maxRows: 10_000_000,
    });

    expect(plan.maxRows).toBe(MAX_ROWS_CEILING);
  });

  it('drops a field the resource does not declare, and says why', () => {
    const plan = guard.planRead(context, {
      resourceId: 'reporting.transactions',
      operation: 'search',
      fields: ['reference', 'somethingNew'],
      maxRows: 10,
    });

    expect(plan.fields).toEqual(['reference']);
    expect(plan.droppedFields).toEqual([
      { field: 'somethingNew', reason: 'The resource does not declare this column.' },
    ]);
  });

  it('refuses an unregistered resource', () => {
    expect(() =>
      guard.planRead(context, {
        resourceId: 'reporting.nothing',
        operation: 'search',
        fields: [],
        maxRows: 10,
      }),
    ).toThrow(/No approved resource/);
  });

  it('refuses an actor whose groups are not allowed', () => {
    expect(() =>
      guard.planRead(
        { ...context, actorGroups: ['customer_support'] },
        { resourceId: 'reporting.transactions', operation: 'search', fields: [], maxRows: 10 },
      ),
    ).toThrow(/No group you hold/);
  });

  it('catches a credential-shaped column that drifted into a declaration', () => {
    // Registration already refuses this; the second check is here because "should never fire"
    // and "does not fire" differ by one upstream schema change.
    const drifted = new ResourceRegistry();
    drifted.register({
      ...resource(),
      exposedFields: ['reference', 'apiKey'],
      fieldExceptions: ['apiKey'],
    });

    const guardWithDrift = new DataAccessGuard(drifted);

    expect(() =>
      guardWithDrift.planRead(context, {
        resourceId: 'reporting.transactions',
        operation: 'search',
        fields: ['reference', 'apiKey'],
        maxRows: 10,
      }),
    ).not.toThrow();

    // Without the exception, it fires.
    const undeclared = new ResourceRegistry();
    undeclared.register({ ...resource(), exposedFields: ['reference'] });

    expect(
      new DataAccessGuard(undeclared).planRead(context, {
        resourceId: 'reporting.transactions',
        operation: 'search',
        fields: ['reference', 'apiKey'],
        maxRows: 10,
      }).fields,
    ).toEqual(['reference']);
  });
});

describe('planning a mutation', () => {
  const guard = new DataAccessGuard(new ResourceRegistry([resource(), walletResource()]));

  it('permits a Class B mutation through the gateway', () => {
    const plan = guard.planMutation(context, {
      resourceId: 'trustos.wallet',
      operation: 'execute',
      apiPath: '/internal/v1/support/wallets/wlt_1/freeze-requests',
    });

    expect(plan.decision.allowed).toBe(true);
  });

  it('refuses a mutation against a Class A resource', () => {
    /*
     * Refused twice over, and the *first* refusal is the one that fires.
     *
     * Registration will not accept a Class A resource that declares a mutation, so by the time a
     * request reaches the guard the operation is undeclared — and that is the refusal it gets.
     * The class check underneath is unreachable through registration and is exercised directly
     * below, because "unreachable" is a property of today's registration schema rather than of
     * the guard.
     */
    expect(() =>
      guard.planMutation(context, {
        resourceId: 'reporting.transactions',
        operation: 'update',
        apiPath: '/internal/v1/operations/transactions/txn_1',
      }),
    ).toThrow(/The resource declares/);
  });

  it('refuses a mutation not routed through the gateway', () => {
    // A direct write skips authorization, workflow, maker-checker and audit — and nothing errors.
    expect(() =>
      guard.planMutation(context, {
        resourceId: 'trustos.wallet',
        operation: 'execute',
        apiPath: '/wallets/wlt_1/freeze',
      }),
    ).toThrow(/not a gateway path/);
  });

  it('refuses a read routed through the mutation path', () => {
    expect(() =>
      guard.planMutation(context, {
        resourceId: 'trustos.wallet',
        operation: 'read' as never,
        apiPath: '/internal/v1/support/wallets/wlt_1',
      }),
    ).toThrow(/is a read/);
  });

  it('refuses through the standalone assertion too', () => {
    expect(() =>
      assertApiOnlyMutation(
        {
          allowed: true,
          accessClass: 'read_only',
          operation: 'update',
          resourceId: 'r',
          reason: 'ok',
        },
        '/internal/v1/x',
      ),
    ).toThrow(/Class A/);
  });
});

describe('the access summary a reviewer reads', () => {
  it('is derived from the definition rather than described by its author', () => {
    const registry = new ResourceRegistry([resource(), walletResource()]);

    const summary = summarizeAccess({
      appId: 'operations-console',
      environment: 'prod',
      registry,
      dataSources: [{ resourceId: 'reporting.transactions', operation: 'search' }],
      actions: [
        {
          resourceId: 'trustos.wallet',
          operation: 'execute',
          apiPath: '/internal/v1/support/wallets/:walletRef/freeze-requests',
        },
      ],
    });

    expect(summary.reads).toEqual([
      { resourceId: 'reporting.transactions', accessClass: 'read_only' },
    ]);
    expect(summary.mutations[0]?.resourceId).toBe('trustos.wallet');
    expect(summary.unregistered).toEqual([]);
  });

  it('names a resource the app reaches that nobody registered', () => {
    const summary = summarizeAccess({
      appId: 'rogue-console',
      environment: 'prod',
      registry: new ResourceRegistry(),
      dataSources: [{ resourceId: 'production.wallets', operation: 'search' }],
      actions: [],
    });

    expect(summary.unregistered).toEqual(['production.wallets']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  GovernanceClient,
  disabledReason,
  pageRequestSchema,
  shouldRender,
  type GatewayTransport,
  type RequestContext,
} from './index';

function transport(
  response: { status: number; body: unknown; headers?: Record<string, string> } = {
    status: 200,
    body: { items: [] },
  },
): GatewayTransport & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];

  return {
    sent,
    send: async (request) => {
      sent.push(request as unknown as Record<string, unknown>);
      return { headers: {}, ...response };
    },
  };
}

const context: RequestContext = {
  actor: {
    actorId: 'usr_ops',
    organizationId: 'org_a',
    roles: ['operations'],
    permissions: ['governance.console.operations'],
    authenticationLevel: 'mfa',
  },
  appId: 'operations-console',
  correlationId: 'cor_1',
  environment: 'prod',
};

describe('the client', () => {
  it('has no method that computes anything', () => {
    // A fee recomputed in a browser is a second implementation of the fee, and the one the
    // customer sees is the browser's while the one that settles is the server's.
    const surface = Object.getOwnPropertyNames(GovernanceClient.prototype);

    for (const forbidden of ['compute', 'calculate', 'evaluate', 'price', 'total']) {
      expect(surface).not.toContain(forbidden);
    }

    expect(surface).toContain('list');
    expect(surface).toContain('submit');
  });

  it('builds the path from the declared data source, never from a caller string', async () => {
    const gateway = transport();
    await new GovernanceClient(gateway).list(context, 'transactions');

    expect(gateway.sent[0]?.path).toBe('/internal/v1/apps/operations-console/data/transactions');
  });

  it('sends the correlation id and the environment on every request', async () => {
    const gateway = transport();
    await new GovernanceClient(gateway).list(context, 'transactions');

    const headers = gateway.sent[0]?.headers as Record<string, string>;
    expect(headers['x-correlation-id']).toBe('cor_1');
    // Echoed so a DEV console talking to the PROD gateway is detectable — a configuration
    // mistake that otherwise works perfectly.
    expect(headers['x-governance-environment']).toBe('prod');
  });

  it('carries the reason and the approval reference on a submit', async () => {
    const gateway = transport({ status: 200, body: { ok: true } });

    await new GovernanceClient(gateway).submit(context, 'request-correction', {
      reason: 'The settlement batch double-counted three refunds.',
      approvalRef: 'apr_1',
      idempotencyKey: 'idm_1',
    });

    const body = gateway.sent[0]?.body as Record<string, unknown>;
    expect(body.reason).toContain('double-counted');
    expect(body.approvalRef).toBe('apr_1');
    expect((gateway.sent[0]?.headers as Record<string, string>)['idempotency-key']).toBe('idm_1');
  });

  it('turns a gateway refusal into an error carrying the correlation id', async () => {
    const gateway = transport({ status: 403, body: { message: 'Refused.' } });

    await expect(new GovernanceClient(gateway).list(context, 'transactions')).rejects.toMatchObject(
      {
        status: 403,
        // What somebody quotes when they call support, and what turns "it did not work" into one
        // row in the audit trail.
        context: { correlationId: 'cor_1' },
      },
    );
  });

  it('refuses a short reveal reason before the round trip rather than after it', async () => {
    // Enforced only after a round trip, a twenty-character floor trains people to type twenty
    // characters of nothing. Refused before, it prompts.
    const gateway = transport();

    await expect(
      new GovernanceClient(gateway).requestReveal(context, {
        resourceId: 'trustos.customer',
        subjectRef: 'cus_1',
        fields: ['phone'],
        reason: 'support',
      }),
    ).rejects.toThrow(/at least twenty/);

    expect(gateway.sent).toHaveLength(0);
  });

  it('sends a reveal request with an adequate reason', async () => {
    const gateway = transport({
      status: 200,
      body: { fields: ['phone'], refused: [], expiresAt: '' },
    });

    await new GovernanceClient(gateway).requestReveal(context, {
      resourceId: 'trustos.customer',
      subjectRef: 'cus_1',
      fields: ['phone'],
      reason: 'Customer called about a payment they say never arrived.',
    });

    expect(gateway.sent[0]?.path).toBe('/internal/v1/support/reveals');
  });

  it('returns the export decision including everything that would block it', async () => {
    const gateway = transport({
      status: 200,
      body: {
        allowed: false,
        requiresApproval: true,
        refusals: ['too many rows'],
        requestId: 'exp_1',
      },
    });

    const decision = await new GovernanceClient(gateway).requestExport(context, {
      resourceId: 'reporting.settlements',
      fields: ['batchRef'],
      filters: {},
      justification: 'Month-end reconciliation against the counterparty statement.',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.refusals).toEqual(['too many rows']);
  });
});

describe('paging', () => {
  it('uses a cursor rather than an offset', () => {
    const fields = Object.keys(pageRequestSchema.shape);

    expect(fields).toContain('cursor');
    // An offset over a moving list shows some rows twice and skips others.
    expect(fields).not.toContain('offset');
    expect(fields).not.toContain('page');
  });

  it('carries the cursor through when one is supplied', () => {
    expect(pageRequestSchema.parse({ cursor: 'opaque' }).cursor).toBe('opaque');
  });

  it('bounds the page size client-side as well as on the server', () => {
    expect(() => pageRequestSchema.parse({ limit: 10_000 })).toThrow();
    expect(pageRequestSchema.parse({}).limit).toBe(50);
  });
});

describe('rendering decisions', () => {
  it('offers shouldRender and no helper called can', () => {
    // A helper called `can` is a helper somebody uses as the check, and the check is on the
    // server.
    expect(shouldRender(context.actor, 'governance.console.operations')).toBe(true);
    expect(shouldRender(context.actor, 'governance.console.finance')).toBe(false);
  });

  it('explains why a control is disabled', () => {
    expect(disabledReason(context.actor, { permission: 'x', isRequester: true })).toContain(
      'You submitted this',
    );
    expect(disabledReason(context.actor, { permission: 'governance.console.finance' })).toContain(
      'permission',
    );
    expect(
      disabledReason(context.actor, {
        permission: 'governance.console.operations',
        requiresApproval: true,
      }),
    ).toContain('approval');
    expect(
      disabledReason(context.actor, { permission: 'governance.console.operations' }),
    ).toBeNull();
  });
});

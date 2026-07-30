import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { ProductService } from './product.service';
import { generateApiKey, hashApiKey, verifyApiKey } from './api-key';

/**
 * Isolation, credential handling and state-machine tests for the gateway.
 *
 * This is a payments skeleton, so the assertions go beyond tenant isolation:
 * a credential that can be recovered from storage, or a payment that can leave
 * a terminal state, are both the kind of defect that is only discovered when
 * money is involved.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

function buildService(): { service: ProductService; sink: InMemoryAuditSink } {
  const historyRows: Array<Record<string, unknown>> = [];

  const prisma = {
    merchantAccount: new FakeModelDelegate([
      {
        id: 'ma_acme',
        organizationId: ACME,
        displayName: 'Acme',
        reference: 'ACME',
        status: 'ACTIVE',
        defaultCurrency: 'USD',
        ...timestamps,
      },
      {
        id: 'ma_rival',
        organizationId: RIVAL,
        displayName: 'Rival',
        reference: 'RIVAL',
        status: 'ACTIVE',
        defaultCurrency: 'USD',
        ...timestamps,
      },
    ]),
    gatewayApiKey: new FakeModelDelegate([]),
    payment: new FakeModelDelegate([
      {
        id: 'pay_acme',
        organizationId: ACME,
        merchantAccountId: 'ma_acme',
        idempotencyKey: 'idem-acme-1',
        amountMinor: 1050,
        currency: 'USD',
        status: 'CREATED',
        reference: 'ACME-1',
        description: null,
        providerReference: null,
        failureReason: null,
        ...timestamps,
      },
      {
        id: 'pay_rival',
        organizationId: RIVAL,
        merchantAccountId: 'ma_rival',
        idempotencyKey: 'idem-rival-1',
        amountMinor: 2000,
        currency: 'USD',
        status: 'CAPTURED',
        reference: 'RIVAL-1',
        description: null,
        providerReference: null,
        failureReason: null,
        ...timestamps,
      },
    ]),
    gatewayWebhookEndpoint: new FakeModelDelegate([]),
    // The history table is append-only, so the fake only needs create + read.
    paymentStatusHistory: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        historyRows.push(data);
        return data;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        historyRows.filter(
          (row) => row.paymentId === where.paymentId && row.organizationId === where.organizationId,
        ),
    },
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new ProductService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('gateway tenant isolation', () => {
  let service: ProductService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization accounts and payments', async () => {
    expect((await asAcme(() => service.listAccounts())).map((row) => row.reference)).toEqual([
      'ACME',
    ]);
    expect((await asRival(() => service.listPayments())).map((row) => row.reference)).toEqual([
      'RIVAL-1',
    ]);
  });

  it('reports another organization payment as not_found', async () => {
    try {
      await asAcme(() => service.findPayment('pay_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('refuses to issue an API key against another organization account', async () => {
    await expect(
      asAcme(() => service.issueApiKey({ merchantAccountId: 'ma_rival', label: 'Sneaky' }, ACME)),
    ).rejects.toThrow();
  });

  it('refuses to transition another organization payment', async () => {
    await expect(
      asAcme(() => service.transitionPayment('pay_rival', 'CANCELLED', null, ACME, 'user_1')),
    ).rejects.toThrow();
  });

  it('never returns another organization history', async () => {
    await expect(asAcme(() => service.paymentHistory('pay_rival', ACME))).rejects.toThrow();
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(service.listPayments()).rejects.toThrow(/Organization context is required/);
  });

  it('attributes every audit record to the acting organization', async () => {
    await asAcme(() => service.createAccount({ displayName: 'Audited', reference: 'AUD' }, ACME));
    await asRival(() => service.createAccount({ displayName: 'Rival', reference: 'RVL' }, RIVAL));

    // An audit trail that attributes an action to the wrong organization is
    // worse than none: it is evidence pointing at the wrong party.
    const byOrganization = sink.records.map((record) => record.organizationId);
    expect(byOrganization).toEqual([ACME, RIVAL]);
  });
});

describe('API key handling', () => {
  let service: ProductService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('returns the key once and stores only a hash', async () => {
    const issued = await asAcme(() =>
      service.issueApiKey({ merchantAccountId: 'ma_acme', label: 'Primary' }, ACME),
    );

    expect(issued.key).toMatch(/^tos_test_/);
    // The response object must not carry the hash, and the stored row must not
    // carry the key.
    expect('keyHash' in issued.apiKey).toBe(false);

    const listed = await asAcme(() => service.listApiKeys());
    expect(listed[0]?.keyPrefix).toBe(issued.key.slice(0, 12));
    expect(JSON.stringify(listed)).not.toContain(issued.key);
  });

  it('never writes the key into the audit trail', async () => {
    const issued = await asAcme(() =>
      service.issueApiKey({ merchantAccountId: 'ma_acme', label: 'Primary' }, ACME),
    );

    const serialized = JSON.stringify(sink.records);
    expect(serialized).not.toContain(issued.key);
    // The prefix is fine: it identifies the credential without being usable.
    expect(serialized).toContain(issued.apiKey.keyPrefix);
  });

  it('revocation is idempotent', async () => {
    const issued = await asAcme(() =>
      service.issueApiKey({ merchantAccountId: 'ma_acme', label: 'Primary' }, ACME),
    );

    await asAcme(() => service.revokeApiKey(issued.apiKey.id, 'rotated', ACME));
    await asAcme(() => service.revokeApiKey(issued.apiKey.id, 'rotated again', ACME));

    expect(
      sink.records.filter((record) => record.action === 'gateway.apiKey.revoked'),
    ).toHaveLength(1);
  });
});

describe('generateApiKey / verifyApiKey', () => {
  it('produces a distinct key each time', () => {
    expect(generateApiKey().key).not.toBe(generateApiKey().key);
  });

  it('marks the environment so a test key cannot pass for a live one', () => {
    expect(generateApiKey('test').key.startsWith('tos_test_')).toBe(true);
    expect(generateApiKey('live').key.startsWith('tos_live_')).toBe(true);
  });

  it('verifies a correct key and rejects a wrong one', () => {
    const { key, keyHash } = generateApiKey();
    expect(verifyApiKey(key, keyHash)).toBe(true);
    expect(verifyApiKey(`${key}x`, keyHash)).toBe(false);
    expect(verifyApiKey(generateApiKey().key, keyHash)).toBe(false);
  });

  it('hashes deterministically without embedding the key', () => {
    const { key, keyHash } = generateApiKey();
    expect(hashApiKey(key)).toBe(keyHash);
    expect(keyHash).toHaveLength(64);
    expect(keyHash).not.toContain(key);
  });
});

describe('payment state machine', () => {
  let service: ProductService;

  beforeEach(() => {
    ({ service } = buildService());
  });

  it('is idempotent on the idempotency key', async () => {
    const first = await asAcme(() =>
      service.createPayment(
        {
          merchantAccountId: 'ma_acme',
          idempotencyKey: 'idem-new-1',
          amountMinor: 500,
          currency: 'USD',
          reference: 'R1',
        },
        ACME,
      ),
    );
    const second = await asAcme(() =>
      service.createPayment(
        {
          merchantAccountId: 'ma_acme',
          idempotencyKey: 'idem-new-1',
          amountMinor: 500,
          currency: 'USD',
          reference: 'R1',
        },
        ACME,
      ),
    );

    // A retried request must not create a second charge.
    expect(second.id).toBe(first.id);
    expect(await asAcme(() => service.listPayments())).toHaveLength(2);
  });

  it('walks a payment through the permitted states and records each step', async () => {
    await asAcme(() => service.transitionPayment('pay_acme', 'PENDING', null, ACME, 'user_1'));
    await asAcme(() => service.transitionPayment('pay_acme', 'AUTHORIZED', null, ACME, 'user_1'));
    const captured = await asAcme(() =>
      service.transitionPayment('pay_acme', 'CAPTURED', null, ACME, 'user_1'),
    );

    expect(captured.status).toBe('CAPTURED');

    const history = (await asAcme(() => service.paymentHistory('pay_acme', ACME))) as Array<{
      toStatus: string;
    }>;
    expect(history.map((entry) => entry.toStatus)).toEqual(['PENDING', 'AUTHORIZED', 'CAPTURED']);
  });

  it('refuses a transition the state machine does not allow', async () => {
    // CREATED -> CAPTURED skips authorization entirely.
    await expect(
      asAcme(() => service.transitionPayment('pay_acme', 'CAPTURED', null, ACME, 'user_1')),
    ).rejects.toThrow(/cannot move from CREATED to CAPTURED/);
  });

  it('refuses to move a payment out of a terminal state', async () => {
    await expect(
      asRival(() => service.transitionPayment('pay_rival', 'PENDING', null, RIVAL, 'user_2')),
    ).rejects.toThrow(/cannot move from CAPTURED/);
  });

  it('records a provider decline as FAILED with the reason', async () => {
    // The mock declines deterministically when the amount ends in 13.
    const payment = await asAcme(() =>
      service.createPayment(
        {
          merchantAccountId: 'ma_acme',
          idempotencyKey: 'idem-decline',
          amountMinor: 1013,
          currency: 'USD',
          reference: 'D1',
        },
        ACME,
      ),
    );
    await asAcme(() => service.transitionPayment(payment.id, 'PENDING', null, ACME, 'user_1'));

    await expect(
      asAcme(() => service.transitionPayment(payment.id, 'AUTHORIZED', null, ACME, 'user_1')),
    ).rejects.toThrow(/declined/);

    const after = await asAcme(() => service.findPayment(payment.id, ACME));
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toBe('declined_by_issuer');
  });
});

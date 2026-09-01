import { describe, expect, it } from 'vitest';
import { CurrencyRegistry, money } from '@trustsystem/financial-core';
import {
  FINANCIAL_EVENTS,
  FINANCIAL_EVENT_DEFINITIONS,
  describeFinancialEvent,
  eventMoney,
  financialEvent,
} from './events';

const currencies = new CurrencyRegistry();
const actor = { type: 'user' as const, id: 'usr_1', displayName: 'Dara' };

describe('the catalog', () => {
  it('has a definition for every event name', () => {
    // A name with no schema is a name whose payload nobody validates.
    const named = new Set(Object.values(FINANCIAL_EVENTS));
    const defined = new Set(FINANCIAL_EVENT_DEFINITIONS.map((entry) => entry.name));

    expect([...named].filter((name) => !defined.has(name))).toEqual([]);
    expect([...defined].filter((name) => !named.has(name))).toEqual([]);
  });

  it('describes when each event fires', () => {
    // The description is what a subscriber author reads before deciding to subscribe.
    for (const definition of FINANCIAL_EVENT_DEFINITIONS) {
      expect(definition.description.length, definition.name).toBeGreaterThan(20);
    }
  });

  it('namespaces every event under `financial.`', () => {
    for (const name of Object.values(FINANCIAL_EVENTS)) {
      expect(name.startsWith('financial.'), name).toBe(true);
    }
  });
});

describe('building an event', () => {
  it('validates the payload at the publisher', () => {
    /*
     * A subscriber discovering a malformed payload cannot tell whether it is a bad publisher or a
     * stale schema, so it fails here instead.
     */
    expect(() =>
      financialEvent({
        name: FINANCIAL_EVENTS.WALLET_CREATED,
        payload: { walletId: 'wlt_1' } as never,
        organizationId: 'org_a',
        actor,
      }),
    ).toThrow();
  });

  it('builds a valid envelope', () => {
    const envelope = financialEvent({
      name: FINANCIAL_EVENTS.WALLET_CREATED,
      payload: {
        walletId: 'wlt_1',
        ownerId: 'usr_1',
        currency: 'USD',
        accountId: 'acc_1',
      },
      organizationId: 'org_a',
      actor,
      aggregate: { type: 'Wallet', id: 'wlt_1' },
    });

    expect(envelope.name).toBe('financial.wallet.created');
    expect(envelope.organizationId).toBe('org_a');
    expect(envelope.metadata.source).toBe('financial');
    expect(envelope.aggregate).toEqual({ type: 'Wallet', id: 'wlt_1' });
  });

  it('carries amounts as strings, never as numbers', () => {
    /*
     * A JSON number goes through a double each way, and a subscriber totalling event payloads gets
     * a figure that disagrees with the ledger.
     */
    const amount = eventMoney(money('1234.56', 'USD', currencies));

    expect(amount).toEqual({ currency: 'USD', amount: '1234.56' });
    expect(typeof amount.amount).toBe('string');
  });

  it('refuses a numeric amount in a payload', () => {
    expect(() =>
      financialEvent({
        name: FINANCIAL_EVENTS.WALLET_CREDITED,
        payload: {
          walletId: 'wlt_1',
          amount: { currency: 'USD', amount: 100.5 },
          journalId: 'jrn_1',
          reference: null,
        } as never,
        organizationId: 'org_a',
        actor,
      }),
    ).toThrow();
  });

  it('carries no balance on a movement event', () => {
    /*
     * By the time a subscriber reads it the balance may have changed twice, and an event that
     * carried one would invite a stale display.
     */
    const definition = FINANCIAL_EVENT_DEFINITIONS.find(
      (entry) => entry.name === FINANCIAL_EVENTS.WALLET_CREDITED,
    )!;

    const shape = Object.keys(
      (definition.schema as never as { shape: Record<string, unknown> }).shape,
    );

    expect(shape).not.toContain('balance');
    expect(shape).toContain('journalId');
  });

  it('takes an idempotency key so a redelivery is the same event', () => {
    const envelope = financialEvent({
      name: FINANCIAL_EVENTS.JOURNAL_POSTED,
      payload: {
        journalId: 'jrn_1',
        ledgerId: 'default',
        reference: 'INV-1',
        description: 'Sale',
        entryCount: 2,
        totals: [{ currency: 'USD', amount: '100.00' }],
        effectiveAt: '2026-03-01T09:00:00.000Z',
      },
      organizationId: 'org_a',
      actor,
      idempotencyKey: 'jrn_1',
    });

    expect(envelope.idempotencyKey).toBe('jrn_1');
  });
});

describe('describing an event', () => {
  it('reads as a line in a log', () => {
    const envelope = financialEvent({
      name: FINANCIAL_EVENTS.WALLET_CREDITED,
      payload: {
        walletId: 'wlt_1',
        amount: eventMoney(money('100.00', 'USD', currencies)),
        journalId: 'jrn_1',
        reference: 'DEP-1',
      },
      organizationId: 'org_a',
      actor,
    });

    expect(describeFinancialEvent(envelope)).toBe('financial.wallet.credited 100.00 USD (DEP-1)');
  });
});

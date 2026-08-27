import { describe, expect, it } from 'vitest';
import {
  assertDeletable,
  decideRetention,
  dueForAction,
  holdApplies,
  legalHoldSchema,
  retentionRuleSchema,
  type RecordFacts,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const CREATED = new Date('2020-01-01T00:00:00.000Z');

function rule(overrides: Record<string, unknown> = {}) {
  return retentionRuleSchema.parse({
    ruleId: 'kh-financial-records',
    description: 'Financial records are kept for the statutory period.',
    appliesTo: { recordType: 'transaction' },
    minimumRetentionDays: 365 * 5,
    maximumRetentionDays: 365 * 7,
    action: 'archive',
    legalBasis: 'Statutory retention for financial records.',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    reviewDate: '2027-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function facts(overrides: Partial<RecordFacts> = {}): RecordFacts {
  return {
    recordType: 'transaction',
    classification: 'RESTRICTED',
    personalData: false,
    createdAt: CREATED,
    ...overrides,
  };
}

function hold(overrides: Record<string, unknown> = {}) {
  return legalHoldSchema.parse({
    holdId: 'hold-2026-litigation',
    scope: { recordType: 'transaction' },
    reason: 'Litigation notice received from counsel on 12 May concerning merchant disputes.',
    placedBy: 'usr_legal',
    placedAt: '2026-05-12T00:00:00.000Z',
    liftedAt: null,
    liftedBy: null,
    ...overrides,
  });
}

describe('retention rules', () => {
  it('refuses a minimum above the maximum', () => {
    expect(() => rule({ minimumRetentionDays: 3000, maximumRetentionDays: 100 })).toThrow(
      /both kept and deleted/,
    );
  });

  it('refuses an unattended delete with no minimum and no review', () => {
    expect(() =>
      rule({ action: 'delete', minimumRetentionDays: 0, requiresReview: false }),
    ).toThrow(/destroy a record the day it is created/);
  });

  it('requires a legal basis', () => {
    expect(() => rule({ legalBasis: '' })).toThrow();
  });
});

describe('deciding retention', () => {
  it('takes the longest minimum and the longest maximum', () => {
    // A record covered by a jurisdiction's seven years and a product's five is kept for seven.
    // Taking the most specific rule deletes it two years early while doing exactly what it was
    // told.
    const decision = decideRetention(
      [
        rule({
          ruleId: 'statutory',
          minimumRetentionDays: 365 * 7,
          maximumRetentionDays: 365 * 10,
        }),
        rule({ ruleId: 'product', minimumRetentionDays: 365 * 5, maximumRetentionDays: 365 * 5 }),
      ],
      facts(),
    );

    expect(decision.minimumRetentionDays).toBe(365 * 7);
    expect(decision.maximumRetentionDays).toBe(365 * 10);
    expect(decision.applicable).toHaveLength(2);
  });

  it('takes the gentlest action at the horizon', () => {
    // Anonymizing satisfies both: the data is gone for the purpose the deleting rule cared
    // about, and the record still exists for the one that wanted it kept.
    const decision = decideRetention(
      [
        rule({
          ruleId: 'delete-it',
          action: 'delete',
          maximumRetentionDays: 1000,
          minimumRetentionDays: 1,
        }),
        rule({
          ruleId: 'anonymize-it',
          action: 'anonymize',
          maximumRetentionDays: 1000,
          minimumRetentionDays: 1,
        }),
      ],
      facts(),
    );

    expect(decision.action).toBe('anonymize');
  });

  it('falls back to the classification default and says so', () => {
    // An absent rule is visible rather than silently permissive.
    const decision = decideRetention([], facts());

    expect(decision.applicable).toEqual([]);
    expect(decision.requiresReview).toBe(true);
    expect(decision.legalBases[0]).toContain('No rule matched');
  });

  it('names every legal basis, so "why do we keep this" has an answer', () => {
    const decision = decideRetention([rule()], facts());
    expect(decision.legalBases).toEqual(['Statutory retention for financial records.']);
  });

  it('does not match a rule for another record type', () => {
    expect(
      decideRetention([rule({ appliesTo: { recordType: 'loan' } })], facts()).applicable,
    ).toEqual([]);
  });
});

describe('legal hold', () => {
  it('always wins, with no override', () => {
    const decision = decideRetention(
      [rule({ minimumRetentionDays: 0, requiresReview: false })],
      facts(),
    );

    try {
      assertDeletable({ facts: facts(), decision, holds: [hold()], now: NOW, reviewed: true });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('no override');
    }
  });

  it('has no parameter that skips it', () => {
    // The signature is the control. A hold that can be skipped by an argument gets skipped
    // during the incident it was placed for.
    const parameters = assertDeletable.length;
    expect(parameters).toBe(1);
  });

  it('stops applying once lifted', () => {
    const lifted = hold({ liftedAt: '2026-05-30T00:00:00.000Z', liftedBy: 'usr_counsel' });
    expect(holdApplies(lifted, facts())).toBe(false);
  });

  it('refuses a hold lifted by the person who placed it', () => {
    expect(() => hold({ liftedAt: '2026-05-30T00:00:00.000Z', liftedBy: 'usr_legal' })).toThrow(
      /is a note, not a hold/,
    );
  });

  it('refuses a hold with no reason worth reading', () => {
    expect(() => hold({ reason: 'legal' })).toThrow();
  });

  it('does not apply to a record outside its scope', () => {
    expect(holdApplies(hold({ scope: { recordType: 'loan' } }), facts())).toBe(false);
  });
});

describe('deletion', () => {
  it('refuses before the minimum retention, naming the basis', () => {
    const decision = decideRetention([rule()], facts());

    try {
      assertDeletable({ facts: facts(), decision, holds: [], now: new Date('2021-01-01') });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('Statutory retention');
    }
  });

  it('refuses when a review is required and has not happened', () => {
    const decision = decideRetention(
      [rule({ requiresReview: true, minimumRetentionDays: 0 })],
      facts(),
    );

    expect(() =>
      assertDeletable({ facts: facts(), decision, holds: [], now: NOW, reviewed: false }),
    ).toThrow(/requires a person to confirm/);
  });

  it('permits deletion once everything is satisfied', () => {
    const decision = decideRetention(
      [rule({ minimumRetentionDays: 1, requiresReview: false })],
      facts(),
    );

    expect(() => assertDeletable({ facts: facts(), decision, holds: [], now: NOW })).not.toThrow();
  });
});

describe('the sweep', () => {
  it('reports what is due, and what a hold is blocking', () => {
    const due = dueForAction(
      [{ ...facts(), recordId: 'txn_1' }],
      // The default minimum is five years, so the maximum has to move with it.
      [rule({ minimumRetentionDays: 50, maximumRetentionDays: 100 })],
      [hold()],
      NOW,
    );

    expect(due).toHaveLength(1);
    expect(due[0]?.blockedByHold).toEqual(['hold-2026-litigation']);
  });

  it('leaves out what is not due yet', () => {
    expect(
      dueForAction([{ ...facts(), recordId: 'txn_1' }], [rule()], [], new Date('2021-01-01')),
    ).toEqual([]);
  });
});

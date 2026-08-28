import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MASK_RULES,
  MAX_REVEAL_WINDOW_MS,
  MaskPolicy,
  assertRevealLive,
  evaluateReveal,
  mask,
  maskRuleSchema,
  revealAuditDetail,
  revealIsLive,
  type RevealRequest,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const policy = new MaskPolicy();

describe('masking', () => {
  it('keeps the suffix of a phone number, because that is what is read back', () => {
    expect(
      mask(
        '85512345678',
        maskRuleSchema.parse({ field: 'phone', strategy: 'partial_suffix', keep: 3 }),
      ),
    ).toBe('••••••••678');
  });

  it('keeps the suffix of an account number', () => {
    expect(
      mask(
        '1234567890',
        maskRuleSchema.parse({ field: 'accountNumber', strategy: 'partial_suffix', keep: 4 }),
      ),
    ).toBe('••••••7890');
  });

  it('masks an email to its first character and domain', () => {
    expect(
      mask('jane.doe@example.test', maskRuleSchema.parse({ field: 'email', strategy: 'email' })),
    ).toBe('j•••••••@example.test');
  });

  it('masks something with no local part rather than returning it', () => {
    expect(
      mask('@example.test', maskRuleSchema.parse({ field: 'email', strategy: 'email' })),
    ).not.toContain('example');
  });

  it('returns an empty string for an absent value rather than the word null', () => {
    const rule = maskRuleSchema.parse({ field: 'phone', strategy: 'partial_suffix' });
    expect(mask(null, rule)).toBe('');
    expect(mask(undefined, rule)).toBe('');
  });

  it('refuses a hashed field marked revealable', () => {
    // The plaintext is not stored, so marking it revealable promises what no code path delivers.
    expect(() => maskRuleSchema.parse({ field: 'x', strategy: 'hash', revealable: true })).toThrow(
      /cannot be revealed/,
    );
  });

  it('never reveals a government identifier or a date of birth', () => {
    for (const field of ['governmentId', 'dateOfBirth']) {
      expect(policy.ruleFor(field)?.revealable, field).toBe(false);
    }
  });

  it('masks a row and leaves unmasked fields alone', () => {
    const masked = policy.maskRow({
      customerRef: 'cus_1',
      phone: '85512345678',
      email: 'jane@example.test',
      status: 'active',
    });

    expect(masked.customerRef).toBe('cus_1');
    expect(masked.status).toBe('active');
    expect(masked.phone).not.toBe('85512345678');
    expect(masked.email).not.toBe('jane@example.test');
  });

  it('matches a field whatever its spelling', () => {
    expect(policy.ruleFor('account_number')).toBeDefined();
    expect(policy.ruleFor('AccountNumber')).toBeDefined();
  });

  it('reports which fields would be masked, for the reveal affordance', () => {
    expect(policy.maskedFields({ customerRef: 'cus_1', phone: '855', status: 'active' })).toEqual([
      'phone',
    ]);
  });

  it('ships a default rule for every obviously identifying field', () => {
    const fields = DEFAULT_MASK_RULES.map((rule) => rule.field);
    for (const required of ['phone', 'email', 'accountNumber', 'cardNumber', 'governmentId']) {
      expect(fields).toContain(required);
    }
  });
});

describe('reveal', () => {
  function decide(overrides: Record<string, unknown> = {}) {
    return evaluateReveal({
      policy,
      fields: ['phone'],
      hasRevealPermission: true,
      approved: false,
      now: NOW,
      ...overrides,
    } as never);
  }

  it('grants a revealable field to somebody who holds the permission', () => {
    const decision = decide();
    expect(decision.granted).toBe(true);
    expect(decision.fields).toEqual(['phone']);
  });

  it('refuses everything when the permission is missing', () => {
    const decision = decide({ hasRevealPermission: false });
    expect(decision.granted).toBe(false);
    expect(decision.refused[0]?.reason).toContain('governance.pii.reveal');
  });

  it('narrows rather than refusing the whole request', () => {
    // Refusing the whole request trains people to ask one field at a time, which produces more
    // reveals with less context in each audit record.
    const decision = decide({ fields: ['phone', 'governmentId'] });

    expect(decision.fields).toEqual(['phone']);
    expect(decision.refused).toHaveLength(1);
    expect(decision.refused[0]?.field).toBe('governmentId');
  });

  it('reports a field that needs approval, and grants it once approved', () => {
    expect(decide({ fields: ['cardNumber'] }).requiresApproval).toBe(true);
    expect(decide({ fields: ['cardNumber'], approved: true }).fields).toEqual(['cardNumber']);
  });

  it('says so when a field was never masked', () => {
    const decision = decide({ fields: ['status'] });
    expect(decision.refused[0]?.reason).toContain('not masked');
  });

  it('caps the window at fifteen minutes however long was asked for', () => {
    // A granted reveal is not a standing grant, and "for the session" always becomes one.
    const decision = decide({ windowMs: 8 * 60 * 60 * 1000 });
    expect(decision.expiresAt.getTime() - NOW.getTime()).toBe(MAX_REVEAL_WINDOW_MS);
  });

  it('expires', () => {
    const request: RevealRequest = {
      requestId: 'rev_1',
      actorId: 'usr_support',
      organizationId: 'org_a',
      resourceId: 'trustos.customer',
      subjectRef: 'cus_1',
      fields: ['phone'],
      reason: 'Customer called about a payment that they say never arrived.',
      requestedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      status: 'granted',
      approvedBy: null,
    };

    expect(revealIsLive(request, NOW)).toBe(true);
    expect(revealIsLive(request, new Date(NOW.getTime() + 120_000))).toBe(false);
    expect(() => assertRevealLive(request, new Date(NOW.getTime() + 120_000))).toThrow(/expired/);
  });

  it('audits field names and never values', () => {
    const request: RevealRequest = {
      requestId: 'rev_1',
      actorId: 'usr_support',
      organizationId: 'org_a',
      resourceId: 'trustos.customer',
      subjectRef: 'cus_1',
      fields: ['phone'],
      reason: 'Customer called about a payment that they say never arrived.',
      requestedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      status: 'granted',
      approvedBy: null,
    };

    const detail = revealAuditDetail(request, decide());

    expect(detail.fieldsRevealed).toBe('phone');
    expect(detail.reason).toContain('Customer called');
    // An audit record of a reveal must not itself be a reveal.
    expect(JSON.stringify(detail)).not.toContain('85512345678');
  });
});

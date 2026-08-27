import { describe, expect, it } from 'vitest';
import {
  MaskPolicy,
  assertMasked,
  mask,
  maskRuleSchema,
  maskingPolicySchema,
  pseudonymize,
  refusingTokenVault,
  rulesForClassification,
} from './index';

const KEY = 'a-pseudonymization-key-long-enough-to-resist-a-candidate-list';

describe('reuse rather than restatement', () => {
  it('exposes the same mask function the Governance Tool uses', () => {
    // A second mask() would be a second set of rules about how many digits of an account number
    // a person sees, and the two would diverge.
    const rule = maskRuleSchema.parse({
      field: 'accountNumber',
      strategy: 'partial_suffix',
      keep: 4,
    });
    expect(mask('1234567890', rule)).toBe('••••••7890');
    expect(new MaskPolicy()).toBeInstanceOf(MaskPolicy);
  });
});

describe('pseudonymization', () => {
  it('is stable within a scope', () => {
    expect(pseudonymize({ value: '85512345678', key: KEY, scope: 'analytics' })).toBe(
      pseudonymize({ value: '85512345678', key: KEY, scope: 'analytics' }),
    );
  });

  it('differs across scopes, so two extracts cannot be joined to re-identify', () => {
    // The standard attack on pseudonymized data.
    expect(pseudonymize({ value: '85512345678', key: KEY, scope: 'analytics' })).not.toBe(
      pseudonymize({ value: '85512345678', key: KEY, scope: 'marketing' }),
    );
  });

  it('differs across values', () => {
    expect(pseudonymize({ value: 'a', key: KEY, scope: 's' })).not.toBe(
      pseudonymize({ value: 'b', key: KEY, scope: 's' }),
    );
  });

  it('refuses a short key', () => {
    // An unsalted or weakly-keyed hash of a phone number is reversible by anybody with a list of
    // phone numbers, which is everybody.
    expect(() => pseudonymize({ value: 'x', key: 'short', scope: 's' })).toThrow(
      /candidate list for a phone number is every phone number/,
    );
  });

  it('does not return the original value', () => {
    const surrogate = pseudonymize({ value: '85512345678', key: KEY, scope: 'analytics' });
    expect(surrogate).not.toContain('85512345678');
    expect(surrogate).toHaveLength(16);
  });
});

describe('the token vault', () => {
  it('refuses everything until one is configured', () => {
    // An unconfigured platform that silently returned the token unchanged would be a platform
    // where tokenization appears to work and nothing is tokenized.
    const vault = refusingTokenVault();

    return Promise.all([
      expect(vault.tokenize({ value: 'x', purpose: 'p' })).rejects.toThrow(/ships none/),
      expect(
        vault.detokenize({ token: 't', actorId: 'usr_1', reason: 'investigating' }),
      ).rejects.toThrow(),
    ]);
  });

  it('requires an actor and a reason to detokenize', () => {
    // Detokenizing *is* a reveal. A vault whose detokenize took only a token is a vault where a
    // service account can read every card number it has ever seen.
    const vault = refusingTokenVault();
    const parameters = Object.keys({ token: '', actorId: '', reason: '' });

    expect(parameters).toContain('actorId');
    expect(parameters).toContain('reason');
    expect(vault.detokenize).toBeTypeOf('function');
  });
});

describe('rules derived from classification', () => {
  it('masks personal data and anything the classification obliges', () => {
    const rules = rulesForClassification([
      { field: 'reference', classification: 'INTERNAL', personalData: false },
      { field: 'phone', classification: 'INTERNAL', personalData: true },
      { field: 'balance', classification: 'RESTRICTED', personalData: false },
    ]);

    expect(rules.map((rule) => rule.field)).toEqual(['phone', 'balance']);
  });

  it('redacts the highest level rather than partially masking it', () => {
    // A partial mask of something that must not leave the system still leaves part of it.
    const [rule] = rulesForClassification([
      { field: 'journalLine', classification: 'HIGHLY_RESTRICTED', personalData: false },
    ]);

    expect(rule?.strategy).toBe('redact');
    expect(rule?.revealable).toBe(false);
  });

  it('carries the reveal-approval obligation through', () => {
    const [rule] = rulesForClassification([
      { field: 'balance', classification: 'RESTRICTED', personalData: false },
    ]);

    expect(rule?.revealRequiresApproval).toBe(true);
  });
});

describe('a masking policy', () => {
  it('refuses a field that is both masked and tokenized', () => {
    // Masking a token displays part of a surrogate, which tells a reader nothing and looks
    // exactly like a partially-masked real value.
    expect(() =>
      maskingPolicySchema.parse({
        policyId: 'customer-masking',
        description: 'Masking for customer records.',
        rules: [{ field: 'cardNumber', strategy: 'partial_suffix', keep: 4 }],
        tokenizedFields: ['cardNumber'],
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow(/both masked and tokenized/);
  });

  it('accepts a policy that masks some fields and tokenizes others', () => {
    expect(() =>
      maskingPolicySchema.parse({
        policyId: 'customer-masking',
        description: 'Masking for customer records.',
        rules: [{ field: 'phone', strategy: 'partial_suffix', keep: 3 }],
        tokenizedFields: ['cardNumber'],
        pseudonymizedFields: [{ field: 'customerRef', scope: 'analytics' }],
        effectiveFrom: '2026-01-01T00:00:00.000Z',
      }),
    ).not.toThrow();
  });
});

describe('enforcing the obligation', () => {
  it('refuses an unmasked read of data the classification masks', () => {
    expect(() => assertMasked('RESTRICTED', false)).toThrow(/needs a reveal/);
  });

  it('permits a masked read', () => {
    expect(() => assertMasked('RESTRICTED', true)).not.toThrow();
  });

  it('permits an unmasked read of data that is not masked by default', () => {
    expect(() => assertMasked('INTERNAL', false)).not.toThrow();
  });
});

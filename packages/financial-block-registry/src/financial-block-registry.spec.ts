import { describe, expect, it } from 'vitest';
import { productErrorCode } from '@trustos/financial-product-core';
import {
  APPROVED_BLOCKS,
  BLOCK_CATALOG,
  BlockRegistry,
  blockCatalogSummary,
  blockDefinitionSchema,
  patternAdmits,
} from './index';

function approvedBlock(overrides: Record<string, unknown> = {}) {
  return {
    blockId: 'wallet.test_block',
    name: 'Test block',
    category: 'wallet',
    version: '1.0.0',
    description: 'A block for testing the schema.',
    monetaryEffect: 'none',
    idempotent: false,
    securityClassification: 'standard',
    lifecycleStatus: 'approved',
    ...overrides,
  };
}

describe('the approved catalog', () => {
  it('covers every category section 4 of the specification names', () => {
    for (const category of [
      'identity',
      'wallet',
      'payment',
      'transfer',
      'ledger',
      'fee',
      'limit',
      'settlement',
      'reconciliation',
      'lending',
      'risk',
    ] as const) {
      expect(APPROVED_BLOCKS.byCategory(category).length).toBeGreaterThan(0);
    }
  });

  it('names no provider, in any block, anywhere', () => {
    // The single constraint the whole layer rests on. A vendor-named block would make every
    // product containing it a product for that vendor.
    const forbidden = [
      'bakong',
      'khqr',
      'aba',
      'wing',
      'acleda',
      'visa',
      'mastercard',
      'swift',
      'paykh',
      'dbank',
      'stripe',
      'plaid',
    ];

    // Whole words, not substrings: "database" contains "aba", and a test that fails on the word
    // "database" is a test somebody deletes rather than a control anybody keeps.
    const serialized = JSON.stringify(BLOCK_CATALOG).toLowerCase();
    for (const vendor of forbidden) {
      expect(serialized).not.toMatch(new RegExp(`\\b${vendor}\\b`));
    }
  });

  it('binds every provider-dependent block to an interface, never to a vendor', () => {
    for (const block of BLOCK_CATALOG) {
      if (!block.providerInterface) continue;
      expect(block.providerInterface).toMatch(/Provider$/);
    }
  });

  it('makes every money-moving block idempotent and compensable', () => {
    for (const block of BLOCK_CATALOG) {
      if (block.monetaryEffect !== 'moves') continue;
      expect(block.idempotent).toBe(true);
      expect(block.compensatedBy).toBeTruthy();
    }
  });

  it('requires something before every block that touches money', () => {
    for (const block of BLOCK_CATALOG) {
      if (block.monetaryEffect === 'none') continue;
      expect(block.requiresPrecedingCategories.length).toBeGreaterThan(0);
    }
  });

  it('names successors explicitly for money-moving blocks rather than allowing anything', () => {
    for (const block of BLOCK_CATALOG) {
      if (block.monetaryEffect !== 'moves') continue;
      expect(block.allowedNext.length).toBeGreaterThan(0);
    }
  });

  it('classifies every block that carries personal data above standard', () => {
    for (const block of BLOCK_CATALOG) {
      const carriesPii = [...block.inputs, ...block.outputs].some((field) => field.pii);
      if (carriesPii) expect(block.securityClassification).not.toBe('standard');
    }
  });

  it('reports a summary the catalog page can render', () => {
    const summary = blockCatalogSummary();
    expect(summary.total).toBe(BLOCK_CATALOG.length);
    expect(summary.movesMoney).toBeGreaterThan(0);
    expect(summary.requiresProvider).toBeGreaterThan(0);
  });
});

describe('the block schema', () => {
  it('refuses a money-moving block that is not idempotent', () => {
    expect(() =>
      blockDefinitionSchema.parse(
        approvedBlock({
          monetaryEffect: 'moves',
          idempotent: false,
          compensatedBy: 'ledger.reverse_journal',
          requiresPrecedingCategories: ['limit'],
        }),
      ),
    ).toThrow(/must be idempotent/);
  });

  it('refuses a money-moving block with nothing to undo it', () => {
    expect(() =>
      blockDefinitionSchema.parse(
        approvedBlock({
          monetaryEffect: 'moves',
          idempotent: true,
          requiresPrecedingCategories: ['limit'],
        }),
      ),
    ).toThrow(/what undoes it/);
  });

  it('refuses a money-moving block with no required predecessor', () => {
    expect(() =>
      blockDefinitionSchema.parse(
        approvedBlock({
          monetaryEffect: 'moves',
          idempotent: true,
          compensatedBy: 'ledger.reverse_journal',
        }),
      ),
    ).toThrow(/must require something before it/);
  });

  it('refuses a block whose id does not match its category', () => {
    expect(() =>
      blockDefinitionSchema.parse(approvedBlock({ blockId: 'payment.create', category: 'wallet' })),
    ).toThrow(/must start with/);
  });

  it('refuses a reference field with no domain', () => {
    expect(() =>
      blockDefinitionSchema.parse(
        approvedBlock({
          outputs: [{ name: 'level', type: 'reference', description: 'A level.' }],
        }),
      ),
    ).toThrow(/must name its domain/);
  });

  it('refuses a deprecated block with no successor', () => {
    expect(() =>
      blockDefinitionSchema.parse(approvedBlock({ lifecycleStatus: 'deprecated' })),
    ).toThrow(/must name its successor/);
  });

  it('refuses a personal-data field on a standard-classification block', () => {
    expect(() =>
      blockDefinitionSchema.parse(
        approvedBlock({
          inputs: [{ name: 'fullName', type: 'string', description: 'A name.', pii: true }],
        }),
      ),
    ).toThrow(/at least sensitive/);
  });
});

describe('resolution', () => {
  it('refuses an unapproved block, and says so rather than returning nothing', () => {
    try {
      APPROVED_BLOCKS.require('wallet.drain_everything', '1.0.0');
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_block_not_approved');
    }
  });

  it('distinguishes an unknown block from an unknown version of a known one', () => {
    expect(() => APPROVED_BLOCKS.require('wallet.debit', '9.9.9')).toThrow(/has no version/);
    expect(() => APPROVED_BLOCKS.require('wallet.nonexistent', '1.0.0')).toThrow(
      /No approved block/,
    );
  });

  it('refuses a duplicate registration', () => {
    const registry = new BlockRegistry([]);
    registry.register(approvedBlock());
    expect(() => registry.register(approvedBlock())).toThrow(/already registered/);
  });

  it('refuses to compose a draft or withdrawn block, and permits a deprecated one', () => {
    const registry = new BlockRegistry([]);
    registry.register(approvedBlock({ blockId: 'wallet.draft_block', lifecycleStatus: 'draft' }));
    registry.register(
      approvedBlock({
        blockId: 'wallet.old_block',
        lifecycleStatus: 'deprecated',
        supersededBy: 'wallet.debit',
      }),
    );

    expect(() => registry.requireComposable('wallet.draft_block', '1.0.0')).toThrow(/is draft/);
    // Deprecated stays composable: refusing it would break every published product containing
    // it the moment somebody deprecates a block.
    expect(registry.requireComposable('wallet.old_block', '1.0.0').blockId).toBe(
      'wallet.old_block',
    );
  });
});

describe('successor patterns', () => {
  it('matches an exact id and a category wildcard', () => {
    expect(patternAdmits('ledger.create_journal', 'ledger.create_journal')).toBe(true);
    expect(patternAdmits('ledger.*', 'ledger.create_journal')).toBe(true);
    expect(patternAdmits('ledger.*', 'wallet.debit')).toBe(false);
  });

  it('lets anything follow a block with no declared successors', () => {
    expect(APPROVED_BLOCKS.transitionAllowed('wallet.get_balance', '1.0.0', 'payment.create')).toBe(
      true,
    );
  });

  it('refuses a successor a money-moving block did not declare', () => {
    // A debit may be followed by a ledger posting or a notification. It may not be followed by
    // another authentication — that ordering is a composition mistake, not a workflow.
    expect(
      APPROVED_BLOCKS.transitionAllowed('wallet.debit', '1.0.0', 'ledger.create_journal'),
    ).toBe(true);
    expect(
      APPROVED_BLOCKS.transitionAllowed('wallet.debit', '1.0.0', 'identity.authenticate'),
    ).toBe(false);
  });

  it('refuses a transition from a block that does not exist', () => {
    expect(APPROVED_BLOCKS.transitionAllowed('wallet.nope', '1.0.0', 'ledger.create_journal')).toBe(
      false,
    );
  });
});

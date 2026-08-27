import { describe, expect, it } from 'vitest';
import { productErrorCode, structuralReferenceData } from '@trustos/financial-product-core';
import { ConnectorRegistry } from '@trustos/connector-registry';
import {
  DESIGNER_NAVIGATION,
  PRODUCT_TEMPLATES,
  ProductComposer,
  buildCompositionBrief,
  compareDesigns,
  consumerWalletTemplate,
  designerCanvas,
  designerPalette,
  draftFromProposal,
  findTemplate,
  merchantWalletBasicTemplate,
  validateProduct,
  type ComposerOptions,
} from './index';

function options(overrides: Partial<ComposerOptions> = {}): ComposerOptions {
  return {
    productId: 'test-product',
    productName: 'Test Product',
    productType: 'merchant',
    description: 'A product for exercising the composer.',
    version: '1.0.0',
    ownership: {
      businessOwner: 'usr_business',
      technicalOwner: 'usr_tech',
      riskOwner: 'usr_risk',
      complianceOwner: 'usr_compliance',
    },
    supportedCurrencies: ['XTS'],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    compliancePolicy: { dataClassification: 'confidential', retentionDays: 2555, screening: [] },
    auditClassification: 'sensitive',
    ...overrides,
  };
}

/** The smallest product that validates: verify, limit, debit, ledger, done. */
function minimalComposer(): ProductComposer {
  return new ProductComposer(options())
    .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
    .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
    .addBlock({
      key: 'debit',
      blockId: 'wallet.debit',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse'],
    })
    .addBlock({ key: 'post', blockId: 'ledger.create_journal', blockVersion: '1.0.0', onFailure: 'compensate', compensateWith: ['reverse'] })
    .addBlock({ key: 'reverse', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
    .connect('start', 'verify', 'always')
    .connect('verify', 'consume-limit')
    .connect('consume-limit', 'debit')
    .connect('debit', 'post')
    .connect('post', 'completed')
    .connect('reverse', 'failed', 'always');
}

describe('the composer', () => {
  it('builds a valid product', () => {
    const { validation } = minimalComposer().buildAndValidate();
    expect(validation.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('always emits a draft, whatever else it was asked for', () => {
    // Composition is not approval. A composer that could emit `active` would be a way around
    // the entire lifecycle, reachable from a script in one line.
    expect(minimalComposer().build().lifecycleStatus).toBe('draft');
  });

  it('refuses an unapproved block at the call that adds it', () => {
    try {
      new ProductComposer(options()).addBlock({
        key: 'drain',
        blockId: 'wallet.transfer_everything',
        blockVersion: '1.0.0',
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_block_not_approved');
    }
  });

  it('refuses a duplicate block key', () => {
    expect(() =>
      minimalComposer().addBlock({ key: 'verify', blockId: 'identity.kyc_check', blockVersion: '1.0.0' }),
    ).toThrow(/already in this product/);
  });

  it('has no way to add a script, an expression or a handler', () => {
    // The composer's vocabulary is the block catalog. Anything else would make every review that
    // followed a review of the wrong thing.
    const surface = Object.getOwnPropertyNames(ProductComposer.prototype);
    for (const forbidden of ['addScript', 'addExpression', 'addHandler', 'addCode', 'eval']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('declares the provider requirement when a block needs one', () => {
    const definition = new ProductComposer(options())
      .addBlock({ key: 'notify', blockId: 'notification.send', blockVersion: '1.0.0' })
      .connect('start', 'notify', 'always')
      .connect('notify', 'completed')
      .build();

    expect(definition.providers.map((provider) => provider.providerInterface)).toEqual([
      'NotificationProvider',
    ]);
  });
});

describe('resolution findings', () => {
  it('refuses an unknown block in a hand-written definition', () => {
    const definition = minimalComposer().build();
    const tampered = {
      ...definition,
      blocks: definition.blocks.map((block) =>
        block.key === 'verify' ? { ...block, blockId: 'identity.does_not_exist' } : block,
      ),
    };

    const result = validateProduct(tampered as never);
    expect(result.findings.some((finding) => finding.code === 'unknown_block')).toBe(true);
  });

  it('refuses a retry on a block that is not idempotent', () => {
    const definition = new ProductComposer(options())
      .addBlock({
        key: 'authenticate',
        blockId: 'identity.authenticate',
        blockVersion: '1.0.0',
        retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 100, maxDelayMs: 1000 },
      })
      .connect('start', 'authenticate', 'always')
      .connect('authenticate', 'completed')
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'retry_on_non_idempotent')).toBe(true);
  });

  it('treats an unbound provider as a note without a connector registry and a defect with one', () => {
    const definition = merchantWalletBasicTemplate();

    const abstract = validateProduct(definition);
    expect(abstract.findings.filter((finding) => finding.code === 'provider_unbound').every((finding) => finding.severity === 'warning')).toBe(true);
    expect(abstract.valid).toBe(true);

    const forPublication = validateProduct(definition, {
      connectors: new ConnectorRegistry(),
      organizationId: 'org_a',
    });
    expect(forPublication.valid).toBe(false);
  });

  it('refuses a connector implementing the wrong interface', () => {
    const connectors = new ConnectorRegistry();
    connectors.register('org_a', {
      connectorId: 'notify-rail',
      name: 'Notification rail',
      description: 'Sends messages for the test suite.',
      version: '1.0.0',
      providerInterface: 'NotificationProvider',
      operation: 'send',
      authentication: 'api_key',
      timeoutMs: 5000,
      idempotent: true,
      dataClassification: 'internal',
      lifecycleStatus: 'approved',
      technicalOwner: 'usr_integrations',
    });

    const definition = new ProductComposer(options())
      .addBlock({
        key: 'accept',
        blockId: 'payment.execute',
        blockVersion: '1.0.0',
        connectorId: 'notify-rail',
        onFailure: 'compensate',
        compensateWith: ['refund'],
      })
      .addBlock({ key: 'refund', blockId: 'payment.refund', blockVersion: '1.0.0' })
      .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
      .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
      .connect('start', 'verify', 'always')
      .connect('verify', 'consume-limit')
      .connect('consume-limit', 'accept')
      .connect('accept', 'completed')
      .connect('refund', 'failed', 'always')
      .build();

    const result = validateProduct(definition, { connectors, organizationId: 'org_a' });
    expect(result.findings.some((finding) => finding.code === 'connector_mismatch')).toBe(true);
  });
});

describe('graph findings', () => {
  it('refuses a product with no entry', () => {
    const definition = { ...minimalComposer().build() };
    const stripped = {
      ...definition,
      transitions: definition.transitions.filter((transition) => transition.from !== 'start'),
    };

    const result = validateProduct(stripped as never);
    expect(result.findings.some((finding) => finding.code === 'no_entry')).toBe(true);
  });

  it('refuses two transitions leaving start', () => {
    const definition = minimalComposer()
      .connect('start', 'consume-limit', 'always')
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'multiple_entries')).toBe(true);
  });

  it('refuses an unreachable block', () => {
    const definition = minimalComposer()
      .addBlock({ key: 'orphan', blockId: 'wallet.get_balance', blockVersion: '1.0.0' })
      .connect('orphan', 'completed')
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'unreachable_block')).toBe(true);
  });

  it('counts a compensating block as reachable', () => {
    // Nothing transitions to a compensator on success. A reachability check that only followed
    // transitions would report every one as dead configuration.
    const result = validateProduct(minimalComposer().build());
    expect(result.findings.some((finding) => finding.subject === 'reverse')).toBe(false);
  });

  it('refuses a block that leads nowhere', () => {
    const definition = minimalComposer()
      .addBlock({ key: 'balance', blockId: 'wallet.get_balance', blockVersion: '1.0.0' })
      .connect('post', 'balance')
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'dead_end_block')).toBe(true);
  });

  it('refuses a cycle', () => {
    const definition = minimalComposer().connect('post', 'consume-limit').build();
    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'cycle')).toBe(true);
  });

  it('refuses a successor the block catalog does not permit', () => {
    const definition = new ProductComposer(options())
      .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
      .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
      .addBlock({ key: 'debit', blockId: 'wallet.debit', blockVersion: '1.0.0', onFailure: 'compensate', compensateWith: ['reverse'] })
      .addBlock({ key: 'authenticate-again', blockId: 'identity.authenticate', blockVersion: '1.0.0' })
      .addBlock({ key: 'reverse', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
      .connect('start', 'verify', 'always')
      .connect('verify', 'consume-limit')
      .connect('consume-limit', 'debit')
      .connect('debit', 'authenticate-again')
      .connect('authenticate-again', 'completed')
      .connect('reverse', 'failed', 'always')
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'transition_not_allowed')).toBe(true);
  });
});

describe('ordering — the group that catches a valid-looking product that is wrong', () => {
  it('refuses a debit with no preceding limit consumption', () => {
    const definition = new ProductComposer(options())
      .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
      .addBlock({ key: 'debit', blockId: 'wallet.debit', blockVersion: '1.0.0', onFailure: 'compensate', compensateWith: ['reverse'] })
      .addBlock({ key: 'reverse', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
      .connect('start', 'verify', 'always')
      .connect('verify', 'debit')
      .connect('debit', 'completed')
      .connect('reverse', 'failed', 'always')
      .build();

    const result = validateProduct(definition);
    const finding = result.findings.find((entry) => entry.code === 'missing_prerequisite');

    expect(finding?.subject).toBe('debit');
    expect(finding?.message).toContain('authorizes the same money twice');
  });

  it('refuses a limit check that sits on only one branch', () => {
    // The check that a union-based analysis would pass and an intersection-based one refuses:
    // the limit is consumed on the branch that is not taken.
    const definition = new ProductComposer(options())
      .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
      .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
      .addBlock({ key: 'skip-limit', blockId: 'wallet.get_balance', blockVersion: '1.0.0' })
      .addBlock({ key: 'debit', blockId: 'wallet.debit', blockVersion: '1.0.0', onFailure: 'compensate', compensateWith: ['reverse'] })
      .addBlock({ key: 'reverse', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
      .connect('start', 'verify', 'always')
      .branch('verify', 'consume-limit', { field: 'amountMinorUnits', operator: 'gt', value: 1000 })
      .branch('verify', 'skip-limit', { field: 'amountMinorUnits', operator: 'lte', value: 1000 })
      .connect('consume-limit', 'debit')
      .connect('skip-limit', 'debit')
      .connect('debit', 'completed')
      .connect('reverse', 'failed', 'always')
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'missing_prerequisite')).toBe(true);
  });

  it('accepts a limit check that precedes the branch', () => {
    const definition = new ProductComposer(options())
      .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
      .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
      .addBlock({ key: 'debit', blockId: 'wallet.debit', blockVersion: '1.0.0', onFailure: 'compensate', compensateWith: ['reverse'] })
      .addBlock({ key: 'credit', blockId: 'wallet.credit', blockVersion: '1.0.0', onFailure: 'compensate', compensateWith: ['reverse'] })
      .addBlock({ key: 'reverse', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
      .connect('start', 'verify', 'always')
      .connect('verify', 'consume-limit')
      .branch('consume-limit', 'debit', { field: 'transactionType', operator: 'eq', value: 'DEBIT' })
      .branch('consume-limit', 'credit', { field: 'transactionType', operator: 'eq', value: 'CREDIT' })
      .connect('debit', 'completed')
      .connect('credit', 'completed')
      .connect('reverse', 'failed', 'always')
      .build();

    expect(validateProduct(definition).valid).toBe(true);
  });
});

describe('compensation findings', () => {
  it('refuses a compensator that does not undo what the catalog says', () => {
    const definition = new ProductComposer(options())
      .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
      .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
      .addBlock({ key: 'debit', blockId: 'wallet.debit', blockVersion: '1.0.0', onFailure: 'compensate', compensateWith: ['notify'] })
      .addBlock({ key: 'notify', blockId: 'notification.send', blockVersion: '1.0.0' })
      .connect('start', 'verify', 'always')
      .connect('verify', 'consume-limit')
      .connect('consume-limit', 'debit')
      .connect('debit', 'completed')
      .connect('notify', 'failed', 'always')
      .build();

    const result = validateProduct(definition);
    const finding = result.findings.find((entry) => entry.code === 'compensation_mismatch');
    expect(finding?.message).toContain('leave the money moved');
  });

  it('warns about a money-moving block that fails without compensating', () => {
    const definition = new ProductComposer(options())
      .addBlock({ key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' })
      .addBlock({ key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' })
      .addBlock({ key: 'debit', blockId: 'wallet.debit', blockVersion: '1.0.0' })
      .connect('start', 'verify', 'always')
      .connect('verify', 'consume-limit')
      .connect('consume-limit', 'debit')
      .connect('debit', 'completed')
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'missing_compensation')).toBe(true);
    expect(result.valid).toBe(true);
  });
});

describe('configuration findings', () => {
  it('refuses a fee in a currency the product does not support', () => {
    const definition = minimalComposer()
      .addFee({
        code: 'PLATFORM',
        feeType: 'FLAT',
        basis: 'flat',
        flat: { minorUnits: '100', currency: 'EUR' },
        bearer: 'platform',
        rounding: 'half_even',
      })
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'currency_not_supported')).toBe(true);
  });

  it('refuses a reference code that is not centrally governed', () => {
    const definition = minimalComposer()
      .addLimit({
        code: 'DAILY',
        limitType: 'INVENTED_TYPE',
        scope: 'customer',
        amount: { minorUnits: '1000', currency: 'XTS' },
      })
      .build();

    const result = validateProduct(definition, { referenceData: structuralReferenceData() });
    expect(result.findings.some((finding) => finding.code === 'unknown_reference')).toBe(true);
  });

  it('surfaces rule findings alongside graph findings', () => {
    const definition = minimalComposer()
      .addRule({
        id: 'wrong-amount',
        description: 'Compares the string amount with an ordering operator.',
        priority: 10,
        enabled: true,
        when: { field: 'amount', operator: 'gt', value: 1000 },
        then: [{ kind: 'tag', tag: 'large' }],
      })
      .build();

    const result = validateProduct(definition);
    expect(result.findings.some((finding) => finding.code === 'rule_finding')).toBe(true);
  });
});

describe('the template library', () => {
  it('ships the five templates section 10 asks for, plus the worked example', () => {
    expect(PRODUCT_TEMPLATES.map((template) => template.id).sort()).toEqual([
      'bnpl',
      'consumer-wallet',
      'loyalty-wallet',
      'merchant-wallet',
      'merchant-wallet-basic',
      'microloan',
    ]);
  });

  it('validates every one with no errors', () => {
    // A template a product owner has to fix before it validates teaches them the validator is
    // noise.
    for (const template of PRODUCT_TEMPLATES) {
      const result = validateProduct(template.build());
      expect(
        result.findings.filter((finding) => finding.severity === 'error'),
        `${template.id} should have no errors`,
      ).toEqual([]);
    }
  });

  it('names no provider in any template', () => {
    const forbidden = ['bakong', 'khqr', 'aba', 'wing', 'acleda', 'visa', 'mastercard', 'paykh', 'dbank'];

    for (const template of PRODUCT_TEMPLATES) {
      const serialized = JSON.stringify(template.build()).toLowerCase();
      for (const vendor of forbidden) {
        expect(serialized, `${template.id} names ${vendor}`).not.toMatch(new RegExp(`\\b${vendor}\\b`));
      }
    }
  });

  it('binds no connector in any template', () => {
    for (const template of PRODUCT_TEMPLATES) {
      const definition = template.build();
      for (const provider of definition.providers) {
        expect(provider.connectorId, `${template.id} binds ${provider.providerInterface}`).toBeUndefined();
      }
    }
  });

  it('uses a currency no country settles in', () => {
    // XTS is the ISO 4217 testing code. A template shipped with USD gets deployed with USD by
    // somebody who did not notice they had to change it.
    for (const template of PRODUCT_TEMPLATES) {
      expect(template.build().supportedCurrencies).toEqual(['XTS']);
    }
  });

  it('finds a template by id', () => {
    expect(findTemplate('microloan')?.name).toBe('Microloan');
    expect(findTemplate('nonexistent')).toBeUndefined();
  });

  it('models Merchant Wallet Basic as the specification’s eight steps', () => {
    const definition = merchantWalletBasicTemplate();
    const happyPath = validateProduct(definition).executionOrder;

    expect(happyPath).toContain('verify-merchant');
    expect(happyPath).toContain('create-wallet');
    expect(happyPath).toContain('configure-limits');
    expect(happyPath).toContain('accept-payment');
    expect(happyPath).toContain('apply-fee');
    expect(happyPath).toContain('post-ledger');
    expect(happyPath).toContain('settle');
    expect(happyPath).toContain('reconcile');

    expect(happyPath.indexOf('configure-limits')).toBeLessThan(happyPath.indexOf('accept-payment'));
    expect(happyPath.indexOf('apply-fee')).toBeLessThan(happyPath.indexOf('post-ledger'));
  });
});

describe('the designer', () => {
  it('offers only approved blocks in the palette', () => {
    const palette = designerPalette();
    expect(palette.length).toBeGreaterThan(0);

    for (const group of palette) {
      for (const entry of group.entries) {
        expect(entry.blockId.startsWith(`${group.category}.`)).toBe(true);
      }
    }
  });

  it('has no palette entry that would execute something the catalog did not approve', () => {
    // Whole operation segments, not substrings: `payment.query_status` legitimately contains
    // "query" and `payment.execute` contains "exec", and a test that failed on those is a test
    // somebody deletes rather than a control anybody keeps.
    const operations = designerPalette()
      .flatMap((group) => group.entries.map((entry) => entry.blockId))
      .map((id) => id.split('.')[1]);

    for (const forbidden of ['script', 'eval', 'run', 'code', 'http', 'sql', 'fetch', 'call', 'invoke']) {
      expect(operations, `palette offers ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('lays a canvas out in execution order and attaches findings to their node', () => {
    const canvas = designerCanvas(merchantWalletBasicTemplate());

    const verify = canvas.nodes.find((node) => node.key === 'verify-merchant');
    const settle = canvas.nodes.find((node) => node.key === 'settle');
    expect(verify?.column).toBeLessThan(settle?.column ?? 0);

    const acceptance = canvas.nodes.find((node) => node.key === 'accept-payment');
    expect(acceptance?.movesMoney).toBe(true);
    expect(acceptance?.findings.every((finding) => finding.subject === 'accept-payment')).toBe(true);
  });

  it('marks compensating blocks so they are not drawn on the main flow', () => {
    const canvas = designerCanvas(merchantWalletBasicTemplate());
    expect(canvas.nodes.find((node) => node.key === 'reverse-posting')?.isCompensation).toBe(true);
    expect(canvas.nodes.find((node) => node.key === 'settle')?.isCompensation).toBe(false);
  });

  it('prints a branch condition on its edge', () => {
    const canvas = designerCanvas(consumerWalletTemplate());
    const branch = canvas.edges.find((edge) => edge.kind === 'conditional');
    expect(branch?.label).toContain('transactionType');
  });

  it('compares two versions by node rather than by text', () => {
    const before = merchantWalletBasicTemplate();
    const after = {
      ...before,
      fees: [{ ...before.fees[0]!, rate: { hundredthsOfBasisPoint: '7500' } }],
    };

    const comparison = compareDesigns(before, after as never);
    expect(comparison.changedFields).toContain('fees');
    expect(comparison.addedBlocks).toEqual([]);
  });

  it('describes the eleven-item navigation section 22 asks for', () => {
    expect(DESIGNER_NAVIGATION.map((item) => item.id)).toEqual([
      'products',
      'templates',
      'blocks',
      'connectors',
      'rules',
      'simulator',
      'sandbox',
      'approvals',
      'deployments',
      'monitoring',
      'audit',
    ]);
  });
});

describe('AI-assisted composition', () => {
  const request = {
    intent: 'A merchant wallet that accepts payments, charges half a percent and settles daily.',
    availableCurrencies: ['XTS'],
    availableCountries: ['COUNTRY_A'],
    availableConnectorIds: ['rail-alpha'],
  };

  const draftInput = {
    request,
    ownership: {
      businessOwner: 'usr_business',
      technicalOwner: 'usr_tech',
      riskOwner: 'usr_risk',
      complianceOwner: 'usr_compliance',
    },
    compliancePolicy: { dataClassification: 'confidential' as const, retentionDays: 2555, screening: [] },
    auditClassification: 'sensitive' as const,
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
  };

  function proposal(overrides: Record<string, unknown> = {}) {
    return {
      productId: 'proposed-merchant-wallet',
      productName: 'Proposed Merchant Wallet',
      productType: 'merchant',
      description: 'A merchant wallet proposed from a natural-language brief.',
      supportedCurrencies: ['XTS'],
      supportedCountries: ['COUNTRY_A'],
      blocks: [
        { key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' },
        { key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' },
        { key: 'accept', blockId: 'payment.execute', blockVersion: '1.0.0', connectorId: 'rail-alpha' },
      ],
      transitions: [
        { from: 'start', to: 'verify', kind: 'always' },
        { from: 'verify', to: 'consume-limit', kind: 'on_success' },
        { from: 'consume-limit', to: 'accept', kind: 'on_success' },
        { from: 'accept', to: 'completed', kind: 'on_success' },
      ],
      rationale: 'Started from the merchant wallet shape and kept it minimal.',
      ...overrides,
    };
  }

  it('builds a brief listing every block the model may use', () => {
    const brief = buildCompositionBrief(request);
    expect(brief.availableBlocks.length).toBeGreaterThan(50);
    expect(brief.availableTemplates.length).toBe(PRODUCT_TEMPLATES.length);
    expect(brief.constraints.some((line) => line.includes('Do not invent a block'))).toBe(true);
  });

  it('lands a proposal in draft, whatever it asked for', () => {
    const outcome = draftFromProposal({ ...draftInput, proposal: proposal() });
    expect(outcome.definition.lifecycleStatus).toBe('draft');
    expect(outcome.overrides.some((line) => line.includes('forced to `draft`'))).toBe(true);
  });

  it('refuses a hallucinated block at the block rather than at the graph', () => {
    try {
      draftFromProposal({
        ...draftInput,
        proposal: proposal({
          blocks: [{ key: 'drain', blockId: 'wallet.transfer_everything', blockVersion: '1.0.0' }],
        }),
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_block_not_approved');
    }
  });

  it('drops a connector the tenant has not approved, and says so', () => {
    const outcome = draftFromProposal({
      ...draftInput,
      proposal: proposal({
        blocks: [
          { key: 'verify', blockId: 'identity.customer_eligibility', blockVersion: '1.0.0' },
          { key: 'consume-limit', blockId: 'limit.daily', blockVersion: '1.0.0' },
          { key: 'accept', blockId: 'payment.execute', blockVersion: '1.0.0', connectorId: 'rail-omega' },
        ],
      }),
    });

    expect(outcome.overrides.some((line) => line.includes('rail-omega'))).toBe(true);
    expect(outcome.definition.blocks.find((block) => block.key === 'accept')?.connectorId).toBeUndefined();
  });

  it('drops a currency the deployment does not support', () => {
    const outcome = draftFromProposal({
      ...draftInput,
      proposal: proposal({ supportedCurrencies: ['XTS', 'USD'] }),
    });

    expect(outcome.definition.supportedCurrencies).toEqual(['XTS']);
    expect(outcome.overrides.some((line) => line.includes('USD'))).toBe(true);
  });

  it('refuses a proposal naming no supported currency at all', () => {
    expect(() =>
      draftFromProposal({ ...draftInput, proposal: proposal({ supportedCurrencies: ['USD'] }) }),
    ).toThrow(/names no currency/);
  });

  it('drops a country outside the deployment’s list', () => {
    const outcome = draftFromProposal({
      ...draftInput,
      proposal: proposal({ supportedCountries: ['COUNTRY_A', 'COUNTRY_Z'] }),
    });

    expect(outcome.definition.supportedCountries).toEqual(['COUNTRY_A']);
    expect(outcome.overrides.some((line) => line.includes('Expanding jurisdiction'))).toBe(true);
  });

  it('has no field for ownership, approvals or lifecycle status', () => {
    // A model that could nominate the risk owner could nominate one who does not exist, and the
    // approval requirement would be satisfied by nobody.
    expect(() =>
      draftFromProposal({
        ...draftInput,
        proposal: proposal({ ownership: { businessOwner: 'whoever' } }),
      }),
    ).toThrow();

    expect(() =>
      draftFromProposal({ ...draftInput, proposal: proposal({ lifecycleStatus: 'active' }) }),
    ).toThrow();
  });

  it('normalises a product type the model got slightly wrong', () => {
    const outcome = draftFromProposal({
      ...draftInput,
      proposal: proposal({ productType: 'digital-wallet' }),
    });

    expect(outcome.definition.productType).toBe('wallet');
  });

  it('returns the validation result rather than throwing on a graph mistake', () => {
    const outcome = draftFromProposal({
      ...draftInput,
      proposal: proposal({
        transitions: [
          { from: 'start', to: 'verify', kind: 'always' },
          { from: 'verify', to: 'accept', kind: 'on_success' },
          { from: 'accept', to: 'completed', kind: 'on_success' },
        ],
      }),
    });

    expect(outcome.validation.valid).toBe(false);
    expect(outcome.validation.findings.some((finding) => finding.code === 'unreachable_block')).toBe(true);
  });

  it('carries the model’s rationale through for the reviewer', () => {
    const outcome = draftFromProposal({ ...draftInput, proposal: proposal() });
    expect(outcome.rationale).toContain('merchant wallet shape');
  });
});

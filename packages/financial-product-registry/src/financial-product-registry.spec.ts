import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectingAuditRecorder,
  productErrorCode,
  type ProductDefinition,
} from '@trustos/financial-product-core';
import { merchantWalletBasicTemplate } from '@trustos/financial-product-composer';
import { parseVariant } from '@trustos/financial-product-variants';
import {
  InMemoryProductStore,
  ProductRegistry,
  catalogEntry,
  searchCatalog,
  type RegistryActor,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const clock = { now: () => NOW };

const ALL_PERMISSIONS = [
  'financial.product.create',
  'financial.product.update',
  'financial.product.validate',
  'financial.product.sandbox',
  'financial.product.submit',
  'financial.product.approve',
  'financial.product.publish',
  'financial.product.pause',
  'financial.product.rollback',
  'financial.product.deprecate',
  'financial.product.retire',
  'financial.product.fee.update',
  'financial.product.limit.update',
  'financial.product.provider.update',
  'financial.product.rule.update',
  'financial.product.variant.manage',
];

function actor(actorId: string, organizationId = 'org_a', permissions = ALL_PERMISSIONS): RegistryActor {
  return { actorId, organizationId, permissions };
}

const maker = actor('usr_maker');
const checkerA = actor('usr_risk');
const checkerB = actor('usr_finance');
const checkerC = actor('usr_compliance');
const checkerD = actor('usr_security');
const checkerE = actor('usr_operations');
const checkerF = actor('usr_owner');
const publisher = actor('usr_publisher');

function draft(overrides: Partial<ProductDefinition> = {}): ProductDefinition {
  return { ...merchantWalletBasicTemplate(), ...overrides };
}

/** Carries a draft from creation to an active version, recording every required approval. */
async function activate(
  registry: ProductRegistry,
  definition: ProductDefinition = draft(),
): Promise<string> {
  await registry.create(maker, definition);
  const productId = definition.productId;

  await registry.transition(maker, productId, 'design');
  await registry.transition(maker, productId, 'validate');
  await registry.transition(maker, productId, 'sandbox');
  await registry.transition(maker, productId, 'submit');

  const state = await registry.checkTransition(maker, productId, 'approve');
  const required = (await registry.get(maker, productId)) && state;
  void required;

  const levels = (await registry.validate(maker, productId)) && null;
  void levels;

  const checkers = [checkerF, checkerA, checkerB, checkerC, checkerD, checkerE];
  const classification = (await registryClassification(registry, productId)).requiredApprovalLevels;

  for (const [index, level] of classification.entries()) {
    await registry.decide(checkers[index] as RegistryActor, productId, {
      level,
      decision: 'approved',
    });
  }

  await registry.transition(checkerA, productId, 'approve');
  await registry.publish(publisher, productId, 'The first published version of the worked example.');
  await registry.activate(publisher, productId, definition.version);

  return definition.version;
}

async function registryClassification(registry: ProductRegistry, productId: string) {
  const state = await registry.checkTransition(maker, productId, 'approve');
  void state;
  const record = await registry.get(maker, productId);
  const { classifyChange } = await import('@trustos/financial-product-governance');
  return classifyChange(null, record.draft as ProductDefinition);
}

describe('the registry', () => {
  let store: InMemoryProductStore;
  let audit: ReturnType<typeof collectingAuditRecorder>;
  let registry: ProductRegistry;

  beforeEach(() => {
    store = new InMemoryProductStore();
    audit = collectingAuditRecorder();
    registry = new ProductRegistry({ store, audit, clock });
  });

  it('records the author from the actor, never from a parameter', async () => {
    await registry.create(maker, draft());
    const record = await registry.get(maker, 'merchant-wallet-basic');
    expect(record.draftAuthorId).toBe('usr_maker');
  });

  it('carries a product from draft to active', async () => {
    const version = await activate(registry);
    const record = await registry.get(maker, 'merchant-wallet-basic');

    expect(record.activeVersion).toBe(version);
    expect(record.draft).toBeNull();

    const active = await registry.activeVersion(maker, 'merchant-wallet-basic');
    expect(active.definition.lifecycleStatus).toBe('active');
  });

  it('refuses to resolve an active version when nothing is live', async () => {
    await registry.create(maker, draft());
    try {
      await registry.activeVersion(maker, 'merchant-wallet-basic');
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_not_executable');
    }
  });

  it('reports another tenant’s product as not found', async () => {
    await registry.create(maker, draft());

    try {
      await registry.get(actor('usr_other', 'org_b'), 'merchant-wallet-basic');
      expect.unreachable('should have refused');
    } catch (error) {
      // Not `forbidden`: a 403 confirms the product exists.
      expect(productErrorCode(error)).toBe('product_not_found');
    }
  });

  it('refuses a duplicate product id within a tenant, and permits it across tenants', async () => {
    await registry.create(maker, draft());
    await expect(registry.create(maker, draft())).rejects.toThrow(/already exists/);
    await expect(
      registry.create(actor('usr_b', 'org_b'), draft()),
    ).resolves.toBeDefined();
  });
});

describe('sensitive changes', () => {
  let registry: ProductRegistry;

  beforeEach(() => {
    registry = new ProductRegistry({ store: new InMemoryProductStore(), audit: collectingAuditRecorder(), clock });
  });

  it('refuses a fee change from an actor without the fee permission', async () => {
    await registry.create(maker, draft());

    const editor = actor('usr_editor', 'org_a', ['financial.product.update']);
    const changed = draft({
      fees: [
        {
          code: 'ACCEPTANCE',
          feeType: 'PERCENTAGE',
          basis: 'percentage',
          rate: { hundredthsOfBasisPoint: '9000' },
          bearer: 'payee',
          rounding: 'half_even',
        },
      ],
    });

    await expect(registry.updateDraft(editor, 'merchant-wallet-basic', changed)).rejects.toThrow(
      /financial.product.fee.update/,
    );
  });

  it('permits a description change from the same actor', async () => {
    await registry.create(maker, draft());
    const editor = actor('usr_editor', 'org_a', ['financial.product.update']);

    await expect(
      registry.updateDraft(editor, 'merchant-wallet-basic', draft({ description: 'A clearer description of the same product.' })),
    ).resolves.toBeDefined();
  });

  it('audits a fee change as a fee change, not as a generic edit', async () => {
    const audit = collectingAuditRecorder();
    const local = new ProductRegistry({ store: new InMemoryProductStore(), audit, clock });

    await local.create(maker, draft());
    await local.updateDraft(maker, 'merchant-wallet-basic', draft({
      fees: [
        {
          code: 'ACCEPTANCE',
          feeType: 'PERCENTAGE',
          basis: 'percentage',
          rate: { hundredthsOfBasisPoint: '9000' },
          bearer: 'payee',
          rounding: 'half_even',
        },
      ],
    }));

    // An auditor searching for fee changes will search for the action name, not read every edit.
    expect(audit.records.some((record) => record.action === 'financial.product.fee.changed')).toBe(true);
  });
});

describe('maker-checker through the registry', () => {
  let registry: ProductRegistry;

  beforeEach(() => {
    registry = new ProductRegistry({ store: new InMemoryProductStore(), audit: collectingAuditRecorder(), clock });
  });

  it('refuses the maker approving their own product', async () => {
    await registry.create(maker, draft());
    await registry.transition(maker, 'merchant-wallet-basic', 'design');
    await registry.transition(maker, 'merchant-wallet-basic', 'validate');
    await registry.transition(maker, 'merchant-wallet-basic', 'sandbox');
    await registry.transition(maker, 'merchant-wallet-basic', 'submit');

    const classification = await registryClassification(registry, 'merchant-wallet-basic');

    await expect(
      registry.decide(maker, 'merchant-wallet-basic', {
        level: classification.requiredApprovalLevels[0] as string,
        decision: 'approved',
      }),
    ).rejects.toThrow(/composed this version/);
  });

  it('refuses approving a product that is not under review', async () => {
    await registry.create(maker, draft());
    await expect(
      registry.decide(checkerA, 'merchant-wallet-basic', { level: 'RISK', decision: 'approved' }),
    ).rejects.toThrow(/not under review/);
  });

  it('refuses publication while an approval level is outstanding', async () => {
    await registry.create(maker, draft());
    await registry.transition(maker, 'merchant-wallet-basic', 'design');
    await registry.transition(maker, 'merchant-wallet-basic', 'validate');
    await registry.transition(maker, 'merchant-wallet-basic', 'sandbox');
    await registry.transition(maker, 'merchant-wallet-basic', 'submit');

    await expect(registry.transition(checkerA, 'merchant-wallet-basic', 'approve')).rejects.toThrow(
      /Missing approval/,
    );
  });

  it('refuses a draft that does not validate', async () => {
    const broken = draft({
      transitions: draft().transitions.filter((transition) => transition.from !== 'start'),
    });

    await registry.create(maker, broken);
    await registry.transition(maker, 'merchant-wallet-basic', 'design');

    await expect(registry.transition(maker, 'merchant-wallet-basic', 'validate')).rejects.toThrow(
      /does not validate/,
    );
  });
});

describe('immutability and concurrency', () => {
  it('refuses an edit once the draft is under review', async () => {
    const registry = new ProductRegistry({ store: new InMemoryProductStore(), audit: collectingAuditRecorder(), clock });

    await registry.create(maker, draft());
    await registry.transition(maker, 'merchant-wallet-basic', 'design');
    await registry.transition(maker, 'merchant-wallet-basic', 'validate');
    await registry.transition(maker, 'merchant-wallet-basic', 'sandbox');
    await registry.transition(maker, 'merchant-wallet-basic', 'submit');

    try {
      await registry.updateDraft(maker, 'merchant-wallet-basic', draft({ description: 'Changed after freezing.' }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_definition_immutable');
    }
  });

  it('refuses a write against a stale revision rather than retrying it', async () => {
    const store = new InMemoryProductStore();
    const registry = new ProductRegistry({ store, audit: collectingAuditRecorder(), clock });

    await registry.create(maker, draft());
    const stale = await store.find('org_a', 'merchant-wallet-basic');

    await registry.updateDraft(maker, 'merchant-wallet-basic', draft({ description: 'The first edit lands.' }));

    // Zero rows updated is the signal that somebody else won. Retrying would re-apply a decision
    // made against a page that is now stale.
    await expect(
      store.update({ ...(stale as never), draft: draft({ description: 'The second edit is refused.' }) }, 0),
    ).rejects.toThrow(/changed while you were working on it/);
  });
});

describe('publication and activation', () => {
  it('refuses publication by the author', async () => {
    const registry = new ProductRegistry({ store: new InMemoryProductStore(), audit: collectingAuditRecorder(), clock });

    await registry.create(maker, draft());
    await registry.transition(maker, 'merchant-wallet-basic', 'design');
    await registry.transition(maker, 'merchant-wallet-basic', 'validate');
    await registry.transition(maker, 'merchant-wallet-basic', 'sandbox');
    await registry.transition(maker, 'merchant-wallet-basic', 'submit');

    const classification = await registryClassification(registry, 'merchant-wallet-basic');
    const checkers = [checkerF, checkerA, checkerB, checkerC, checkerD, checkerE];

    for (const [index, level] of classification.requiredApprovalLevels.entries()) {
      await registry.decide(checkers[index] as RegistryActor, 'merchant-wallet-basic', {
        level,
        decision: 'approved',
      });
    }

    await registry.transition(checkerA, 'merchant-wallet-basic', 'approve');

    await expect(
      registry.publish(maker, 'merchant-wallet-basic', 'The author trying to publish their own work.'),
    ).rejects.toThrow(/cannot publish their own version/);
  });

  it('refuses a workflow change shipped as a patch bump', async () => {
    const store = new InMemoryProductStore();
    const registry = new ProductRegistry({ store, audit: collectingAuditRecorder(), clock });

    await activate(registry);

    // Removing an exposed operation breaks every channel calling it — and it is exactly the kind
    // of change somebody ships as a patch because "it is only configuration".
    const withExtraBlock = draft({
      version: '1.0.1',
      apiExposurePolicy: {
        ...draft().apiExposurePolicy,
        operations: draft().apiExposurePolicy.operations.slice(0, 1),
      },
    });

    const record = await registry.get(maker, 'merchant-wallet-basic');
    await store.update({ ...record, draft: withExtraBlock, draftAuthorId: 'usr_maker' }, record.revision);

    await registry.transition(maker, 'merchant-wallet-basic', 'design');
    await registry.transition(maker, 'merchant-wallet-basic', 'validate');
    await registry.transition(maker, 'merchant-wallet-basic', 'sandbox');
    await registry.transition(maker, 'merchant-wallet-basic', 'submit');

    const { classifyChange } = await import('@trustos/financial-product-governance');
    const previous = (await registry.get(maker, 'merchant-wallet-basic')).versions[0]!.definition;
    const classification = classifyChange(previous, withExtraBlock);
    const checkers = [checkerF, checkerA, checkerB, checkerC, checkerD, checkerE];

    for (const [index, level] of classification.requiredApprovalLevels.entries()) {
      await registry.decide(checkers[index] as RegistryActor, 'merchant-wallet-basic', {
        level,
        decision: 'approved',
      });
    }

    await registry.transition(checkerA, 'merchant-wallet-basic', 'approve');

    await expect(
      registry.publish(publisher, 'merchant-wallet-basic', 'Added a notification step after reconciliation.'),
    ).rejects.toThrow(/breaking change/);
  });
});

describe('pause and rollback', () => {
  it('pauses without an approval, because an incident response that waits is not one', async () => {
    const registry = new ProductRegistry({ store: new InMemoryProductStore(), audit: collectingAuditRecorder(), clock });
    await activate(registry);

    const operator = actor('usr_oncall', 'org_a', ['financial.product.pause']);
    const state = await registry.pause(operator, 'merchant-wallet-basic', 'Fee applied to the wrong tier.');

    expect(state.activeVersion).toBeNull();
  });

  it('plans a rollback that leaves history alone, and applies it', async () => {
    const store = new InMemoryProductStore();
    const audit = collectingAuditRecorder();
    const registry = new ProductRegistry({ store, audit, clock });

    await activate(registry);

    // A second version, published and activated.
    const second = draft({ version: '1.1.0', description: 'The second version, with a different fee.' });
    const record = await registry.get(maker, 'merchant-wallet-basic');
    await store.update({ ...record, draft: second, draftAuthorId: 'usr_maker' }, record.revision);

    await registry.transition(maker, 'merchant-wallet-basic', 'design');
    await registry.transition(maker, 'merchant-wallet-basic', 'validate');
    await registry.transition(maker, 'merchant-wallet-basic', 'sandbox');
    await registry.transition(maker, 'merchant-wallet-basic', 'submit');
    // A description-only change touches nothing sensitive, so no approval level is required.
    await registry.transition(checkerA, 'merchant-wallet-basic', 'approve');
    await registry.publish(publisher, 'merchant-wallet-basic', 'A second version with a different description.');
    await registry.activate(publisher, 'merchant-wallet-basic', '1.1.0');

    store.setInFlight('org_a', 'merchant-wallet-basic', '1.1.0', 12);

    const plan = await registry.planRollback(
      publisher,
      'merchant-wallet-basic',
      '1.0.0',
      'The second version priced the wrong merchant tier.',
    );

    expect(plan.from).toBe('1.1.0');
    expect(plan.to).toBe('1.0.0');
    expect(plan.inFlightCount).toBe(12);
    expect(plan.effects.some((effect) => effect.includes('Nothing historical is rewritten'))).toBe(true);

    const state = await registry.rollback(publisher, plan);
    expect(state.activeVersion).toBe('1.0.0');

    const rollbackRecord = audit.records.find((entry) => entry.action === 'financial.product.rolled_back');
    expect(rollbackRecord?.detail.historicalExecutionsRewritten).toBe(0);

    // The versions themselves are untouched, which is what "does not rewrite history" means.
    const after = await registry.get(publisher, 'merchant-wallet-basic');
    expect(after.versions.map((version) => version.version)).toEqual(['1.0.0', '1.1.0']);
  });

  it('refuses a rollback to a version that was never approved', async () => {
    const store = new InMemoryProductStore();
    const registry = new ProductRegistry({ store, audit: collectingAuditRecorder(), clock });
    await activate(registry);

    await expect(
      registry.planRollback(publisher, 'merchant-wallet-basic', '9.9.9', 'A version that does not exist.'),
    ).rejects.toThrow(/no version/);
  });
});

describe('variants through the registry', () => {
  it('refuses a variant whose overrides are illegal against the pinned base', async () => {
    const registry = new ProductRegistry({ store: new InMemoryProductStore(), audit: collectingAuditRecorder(), clock });
    await activate(registry);

    const variant = parseVariant({
      variantId: 'widening',
      name: 'Widening',
      description: 'Tries to add a currency the base was not approved for.',
      baseProductId: 'merchant-wallet-basic',
      baseVersion: '1.0.0',
      version: '1.0.0',
      lifecycleStatus: 'draft',
      effectiveDate: '2026-01-01T00:00:00.000Z',
      reviewDate: '2026-12-31T00:00:00.000Z',
      overrides: { supportedCurrencies: ['XTS', 'USD'] },
    });

    await expect(registry.saveVariant(maker, variant)).rejects.toThrow(/USD/);
  });

  it('resolves a legal variant against its base', async () => {
    const registry = new ProductRegistry({ store: new InMemoryProductStore(), audit: collectingAuditRecorder(), clock });
    await activate(registry);

    const variant = parseVariant({
      variantId: 'sme',
      name: 'SME',
      description: 'A cheaper acceptance rate for small merchants.',
      baseProductId: 'merchant-wallet-basic',
      baseVersion: '1.0.0',
      version: '1.0.0',
      lifecycleStatus: 'draft',
      effectiveDate: '2026-01-01T00:00:00.000Z',
      reviewDate: '2026-12-31T00:00:00.000Z',
      overrides: {
        fees: [
          {
            code: 'ACCEPTANCE',
            feeType: 'PERCENTAGE',
            basis: 'percentage',
            rate: { hundredthsOfBasisPoint: '4000' },
            bearer: 'payee',
            rounding: 'half_even',
          },
        ],
      },
    });

    await registry.saveVariant(maker, variant);
    const resolved = await registry.resolvedVariant(maker, 'sme');

    expect(resolved.definition.fees[0]?.rate?.hundredthsOfBasisPoint).toBe('4000');
    // The workflow is the base's, untouched.
    expect(resolved.definition.blocks).toEqual((await registry.activeVersion(maker, 'merchant-wallet-basic')).definition.blocks);
  });
});

describe('the catalog', () => {
  it('derives its entry from the live definition', async () => {
    const store = new InMemoryProductStore();
    const registry = new ProductRegistry({ store, audit: collectingAuditRecorder(), clock });
    await activate(registry);

    const records = await registry.list(maker);
    const entry = catalogEntry(records[0] as never);

    expect(entry?.activeVersion).toBe('1.0.0');
    expect(entry?.lifecycleStatus).toBe('active');
    expect(entry?.riskClassification).toBe('elevated');
    // Only `payment.execute` and `payment.refund` declare a provider dependency in this product;
    // `settlement.create` records an obligation without instructing anybody.
    expect(entry?.providers).toEqual(['PaymentProvider']);
    expect(entry?.apis.some((api) => api.includes('/v1/products/merchant-wallet-basic/payments'))).toBe(true);
  });

  it('narrows with every filter rather than widening', async () => {
    const store = new InMemoryProductStore();
    const registry = new ProductRegistry({ store, audit: collectingAuditRecorder(), clock });
    await activate(registry);

    const records = await registry.list(maker);

    expect(searchCatalog(records, { productType: 'merchant' })).toHaveLength(1);
    expect(searchCatalog(records, { productType: 'lending' })).toHaveLength(0);
    expect(searchCatalog(records, { productType: 'merchant', currency: 'USD' })).toHaveLength(0);
    expect(searchCatalog(records, { text: 'merchant' })).toHaveLength(1);
    expect(searchCatalog(records, { exposed: true })).toHaveLength(1);
  });

  it('shows nothing from another tenant', async () => {
    const store = new InMemoryProductStore();
    const registry = new ProductRegistry({ store, audit: collectingAuditRecorder(), clock });
    await activate(registry);

    expect(await registry.list(actor('usr_other', 'org_b'))).toEqual([]);
  });
});

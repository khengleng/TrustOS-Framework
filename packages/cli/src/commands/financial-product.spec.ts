import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { merchantWalletBasicTemplate } from '@trustsystem/financial-product-composer';
import { createCapturingOutput } from '../output';
import {
  runBlockList,
  runConnectorList,
  runConnectorValidate,
  runProductCreate,
  runProductDoctor,
  runProductList,
  runProductPublishPlan,
  runProductRollbackPlan,
  runProductSimulate,
  runProductValidate,
} from './financial-product';

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'trustos-product-'));
}

/** A definition a deployment would actually publish: real currency, connector bound. */
function configured(overrides: Record<string, unknown> = {}) {
  const definition = merchantWalletBasicTemplate();

  return {
    ...definition,
    supportedCurrencies: ['USD'],
    fees: definition.fees.map((fee) => ({
      ...fee,
      ...(fee.cap ? { cap: { ...fee.cap, currency: 'USD' } } : {}),
    })),
    limits: definition.limits.map((limit) => ({
      ...limit,
      ...(limit.amount ? { amount: { ...limit.amount, currency: 'USD' } } : {}),
    })),
    riskPolicy: {
      ...definition.riskPolicy,
      ...(definition.riskPolicy.enhancedReviewAbove
        ? {
            enhancedReviewAbove: {
              ...definition.riskPolicy.enhancedReviewAbove,
              currency: 'USD',
            },
          }
        : {}),
    },
    providers: definition.providers.map((provider) => ({
      ...provider,
      connectorId: 'payment-rail-primary',
    })),
    ...overrides,
  };
}

describe('financial-block list', () => {
  it('lists the catalog and says the framework ships no handlers', () => {
    const output = createCapturingOutput();
    expect(runBlockList({}, output)).toBe(0);

    const text = output.lines.join('\n');
    expect(text).toContain('84 blocks');
    expect(text).toContain('The seam is the deliverable');
  });

  it('filters by category', () => {
    const output = createCapturingOutput();
    runBlockList({ category: 'settlement' }, output);

    const text = output.lines.join('\n');
    expect(text).toContain('settlement.create');
    expect(text).not.toContain('wallet.debit');
  });

  it('refuses an unknown category and says which exist', () => {
    const output = createCapturingOutput();
    expect(runBlockList({ category: 'nonsense' }, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('Available:');
  });
});

describe('connector list and validate', () => {
  it('lists interfaces and says the catalog is empty by design', () => {
    const output = createCapturingOutput();
    expect(runConnectorList({}, output)).toBe(0);

    const text = output.lines.join('\n');
    expect(text).toContain('PaymentProvider');
    expect(text).toContain('empty by design');
  });

  it('validates a well-formed connector', async () => {
    const directory = await workspace();
    const file = join(directory, 'connector.json');

    await writeFile(
      file,
      JSON.stringify({
        connectorId: 'settlement-rail',
        name: 'Settlement rail',
        description: 'A settlement instruction interface.',
        version: '1.0.0',
        providerInterface: 'SettlementProvider',
        operation: 'instruct',
        authentication: 'mutual_tls',
        timeoutMs: 15000,
        idempotent: true,
        dataClassification: 'confidential',
        lifecycleStatus: 'approved',
        technicalOwner: 'usr_integrations',
      }),
    );

    const output = createCapturingOutput();
    expect(await runConnectorValidate(file, {}, output)).toBe(0);
    expect(output.lines.join('\n')).toContain('carries no endpoint');
  });

  it('refuses a connector carrying a URL', async () => {
    const directory = await workspace();
    const file = join(directory, 'connector.json');

    await writeFile(
      file,
      JSON.stringify({
        connectorId: 'settlement-rail',
        name: 'Settlement rail',
        description: 'Posts to https://settlement.example.test/instruct.',
        version: '1.0.0',
        providerInterface: 'SettlementProvider',
        operation: 'instruct',
        authentication: 'mutual_tls',
        timeoutMs: 15000,
        idempotent: true,
        dataClassification: 'confidential',
        lifecycleStatus: 'approved',
        technicalOwner: 'usr_integrations',
      }),
    );

    const output = createCapturingOutput();
    expect(await runConnectorValidate(file, {}, output)).toBe(1);
  });
});

describe('financial-product create and validate', () => {
  it('lists the templates', () => {
    const output = createCapturingOutput();
    expect(runProductList({}, output)).toBe(0);
    expect(output.lines.join('\n')).toContain('merchant-wallet-basic');
  });

  it('writes a template that already validates', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');

    const created = createCapturingOutput();
    expect(await runProductCreate('merchant-wallet-basic', { out: file }, created)).toBe(0);
    expect(created.lines.join('\n')).toContain('It already validates');

    const validated = createCapturingOutput();
    expect(await runProductValidate(file, {}, validated)).toBe(0);
    expect(validated.lines.join('\n')).toContain('Valid.');
  });

  it('refuses an unknown template and lists the real ones', async () => {
    const output = createCapturingOutput();
    expect(await runProductCreate('nonexistent', {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('Available:');
  });

  it('refuses a file that is not JSON', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');
    await writeFile(file, 'not json at all');

    const output = createCapturingOutput();
    expect(await runProductValidate(file, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('not valid JSON');
  });

  it('refuses a YAML file rather than adding a YAML parser', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.yaml');
    await writeFile(file, 'productId: x');

    const output = createCapturingOutput();
    expect(await runProductValidate(file, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('JSON only');
  });
});

describe('financial-product doctor', () => {
  it('fails a template still denominated in the test currency', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');
    await writeFile(file, JSON.stringify(merchantWalletBasicTemplate()));

    const output = createCapturingOutput();
    expect(await runProductDoctor(file, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('template nobody configured');
  });

  it('passes a configured product', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');
    await writeFile(file, JSON.stringify(configured()));

    const output = createCapturingOutput();
    expect(await runProductDoctor(file, {}, output)).toBe(0);
  });
});

describe('financial-product publish and rollback plans', () => {
  it('writes nothing, and says so', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');
    await writeFile(file, JSON.stringify(configured()));

    const output = createCapturingOutput();
    await runProductPublishPlan(file, {}, output);
    expect(output.lines.join('\n')).toContain('Nothing was written');
  });

  it('names every approval a new product needs', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');
    await writeFile(file, JSON.stringify(configured()));

    const output = createCapturingOutput();
    await runProductPublishPlan(file, {}, output);

    const text = output.lines.join('\n');
    for (const level of ['PRODUCT_OWNER', 'RISK', 'FINANCE', 'COMPLIANCE', 'SECURITY']) {
      expect(text).toContain(level);
    }
  });

  it('names only the approvals a fee change needs', async () => {
    const directory = await workspace();
    const previous = join(directory, 'v1.json');
    const next = join(directory, 'v11.json');

    await writeFile(previous, JSON.stringify(configured()));
    await writeFile(
      next,
      JSON.stringify(
        configured({
          version: '1.1.0',
          fees: [
            {
              ...merchantWalletBasicTemplate().fees[0],
              rate: { hundredthsOfBasisPoint: '7500' },
            },
          ],
        }),
      ),
    );

    const output = createCapturingOutput();
    await runProductPublishPlan(next, { previous }, output);

    const text = output.lines.join('\n');
    expect(text).toContain('FINANCE');
    expect(text).not.toContain('SECURITY');
  });

  it('says a rollback rewrites nothing historical', async () => {
    const directory = await workspace();
    const current = join(directory, 'v11.json');
    const target = join(directory, 'v1.json');

    await writeFile(current, JSON.stringify(configured({ version: '1.1.0' })));
    await writeFile(target, JSON.stringify(configured()));

    const output = createCapturingOutput();
    expect(await runProductRollbackPlan(current, target, {}, output)).toBe(0);
    expect(output.lines.join('\n')).toContain('Nothing historical is rewritten');
  });
});

describe('financial-product simulate', () => {
  it('refuses to simulate a product that does not validate', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');

    const broken = merchantWalletBasicTemplate();
    await writeFile(
      file,
      JSON.stringify({
        ...broken,
        transitions: broken.transitions.filter((transition) => transition.from !== 'start'),
      }),
    );

    const output = createCapturingOutput();
    expect(await runProductSimulate(file, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('measure a product nobody can run');
  });

  it('reports the path distribution and states its caveats', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');
    await writeFile(file, JSON.stringify(configured()));

    const output = createCapturingOutput();
    expect(await runProductSimulate(file, { count: '50', seed: '1' }, output)).toBe(0);

    const text = output.lines.join('\n');
    expect(text).toContain('path distribution');
    expect(text).toContain('mock that returns immediately');
    expect(text).toContain('Limit consumption was cleared between transactions');
  });

  it('refuses an absurd count rather than trying', async () => {
    const directory = await workspace();
    const file = join(directory, 'product.json');
    await writeFile(file, JSON.stringify(configured()));

    const output = createCapturingOutput();
    expect(await runProductSimulate(file, { count: '99999999' }, output)).toBe(1);
  });
});

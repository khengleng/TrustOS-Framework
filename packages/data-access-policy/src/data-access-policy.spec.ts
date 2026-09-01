import { describe, expect, it } from 'vitest';
import { DataCatalog, catalogEntrySchema } from '@trustsystem/data-catalog';
import {
  MAX_GRANT_DAYS,
  accessGrantSchema,
  accessReviewSchema,
  applyReview,
  assertGrantBounded,
  campaignScope,
  decideAccess,
  lapsingGrants,
  purposeCompatible,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function catalogWith(classification: string, personalData = false): DataCatalog {
  return new DataCatalog([
    catalogEntrySchema.parse({
      entryId: 'db.core.wallet',
      kind: 'table',
      technicalName: 'wallet',
      businessName: 'Wallet',
      description: 'One row per wallet.',
      parentId: null,
      owner: 'usr_data',
      steward: 'usr_steward',
      businessDomain: 'financial',
      classification,
      personalData,
      environment: 'prod',
      residencyRegion: 'ap-southeast-1',
      purpose: 'Operating customer wallets.',
      legalBasis: 'contract',
      nextReviewDate: '2026-12-31T00:00:00.000Z',
      lastReviewDate: null,
    }),
  ]);
}

function grant(overrides: Record<string, unknown> = {}) {
  return accessGrantSchema.parse({
    grantId: 'grant-ops-wallet',
    entryId: 'db.core.wallet',
    principal: 'operations',
    principalKind: 'role',
    purpose: 'service_operation',
    operations: ['read'],
    unmasked: false,
    grantedBy: 'usr_data',
    grantedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    justification: 'Operations resolves stuck wallet transactions and needs to see the balance.',
    ...overrides,
  });
}

describe('purpose ceilings', () => {
  it('caps model training at INTERNAL', () => {
    // Training on customer data is a decision with a lawful basis and a retention consequence,
    // made for a specific dataset rather than inherited from a general-purpose grant.
    expect(purposeCompatible('model_training', 'INTERNAL')).toBe(true);
    expect(purposeCompatible('model_training', 'CONFIDENTIAL')).toBe(false);
  });

  it('caps product analytics below customer support', () => {
    expect(purposeCompatible('product_analytics', 'CONFIDENTIAL')).toBe(false);
    expect(purposeCompatible('customer_support', 'CONFIDENTIAL')).toBe(true);
  });

  it('lets incident response and audit reach everything', () => {
    expect(purposeCompatible('incident_response', 'HIGHLY_RESTRICTED')).toBe(true);
    expect(purposeCompatible('audit', 'HIGHLY_RESTRICTED')).toBe(true);
  });
});

describe('grants', () => {
  it('requires an expiry, bounded', () => {
    // A grant with no expiry is a grant forever, and access accumulates because removing it
    // might break something and nobody is sure.
    expect(() => grant({ expiresAt: undefined })).toThrow();
    expect(() => assertGrantBounded(grant({ expiresAt: '2030-01-01T00:00:00.000Z' }))).toThrow(
      new RegExp(`at most ${MAX_GRANT_DAYS} days`),
    );
  });

  it('refuses a grant that expires before it starts', () => {
    expect(() =>
      assertGrantBounded(
        grant({ grantedAt: '2026-06-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ),
    ).toThrow(/grants nothing/);
  });

  it('requires a justification worth reading', () => {
    expect(() => grant({ justification: 'needed' })).toThrow();
  });

  it('is granted to a role rather than a person', () => {
    // Individuals move teams.
    expect(grant().principalKind).toBe('role');
  });
});

describe('deciding access', () => {
  const catalog = catalogWith('RESTRICTED');

  it('permits a compatible grant in date', () => {
    const decision = decideAccess({ grant: grant(), catalog, operation: 'read', now: NOW });
    expect(decision.allowed).toBe(true);
  });

  it('refuses an expired grant', () => {
    const decision = decideAccess({
      grant: grant(),
      catalog,
      operation: 'read',
      now: new Date('2027-01-01'),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons[0]).toContain('expired');
  });

  it('refuses an operation the grant does not permit', () => {
    const decision = decideAccess({ grant: grant(), catalog, operation: 'export', now: NOW });
    expect(decision.reasons.join(' ')).toContain('not export');
  });

  it('refuses a purpose that may not reach this classification', () => {
    const decision = decideAccess({
      grant: grant({ purpose: 'product_analytics' }),
      catalog,
      operation: 'read',
      now: NOW,
    });

    expect(decision.reasons.join(' ')).toContain('at most INTERNAL');
  });

  it('refuses training on personal data whatever the grant says', () => {
    const decision = decideAccess({
      grant: grant({ purpose: 'model_training' }),
      catalog: catalogWith('INTERNAL', true),
      operation: 'read',
      now: NOW,
    });

    expect(decision.reasons.join(' ')).toContain('lawful basis');
  });

  it('collects every refusal rather than returning the first', () => {
    // Somebody told their grant expired, then told the purpose is wrong, then told they cannot
    // export, stops trusting the answers.
    const decision = decideAccess({
      grant: grant({ purpose: 'product_analytics', operations: ['read'] }),
      catalog,
      operation: 'export',
      now: new Date('2027-01-01'),
    });

    expect(decision.reasons.length).toBe(3);
  });

  it('reports unmasked separately from allowed', () => {
    expect(
      decideAccess({ grant: grant({ unmasked: true }), catalog, operation: 'read', now: NOW })
        .unmasked,
    ).toBe(true);
    expect(decideAccess({ grant: grant(), catalog, operation: 'read', now: NOW }).unmasked).toBe(
      false,
    );
  });
});

describe('access review', () => {
  function review(overrides: Record<string, unknown> = {}) {
    return accessReviewSchema.parse({
      reviewId: 'review-2026-h1',
      grantId: 'grant-ops-wallet',
      reviewer: 'usr_owner',
      outcome: 'certify',
      reviewedAt: NOW.toISOString(),
      ...overrides,
    });
  }

  it('extends a certified grant', () => {
    const renewed = applyReview(grant(), review(), NOW);
    expect(new Date(renewed!.expiresAt).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('ends a revoked one', () => {
    expect(
      applyReview(grant(), review({ outcome: 'revoke', notes: 'Team no longer owns this.' }), NOW),
    ).toBeNull();
  });

  it('narrows a reduced one without extending it', () => {
    const reduced = applyReview(
      grant({ operations: ['read', 'export'], unmasked: true }),
      review({ outcome: 'reduce', reducedTo: ['read'], notes: 'Export is no longer needed.' }),
      NOW,
    );

    expect(reduced?.operations).toEqual(['read']);
    expect(reduced?.unmasked).toBe(false);
    // Reducing does not extend. The clock keeps running.
    expect(reduced?.expiresAt).toBe(grant().expiresAt);
  });

  it('leaves an escalated grant exactly as it was', () => {
    // "Could not decide" does not read as "extend for another year".
    const escalated = applyReview(
      grant(),
      review({ outcome: 'escalate', notes: 'The owning team has been reorganized.' }),
      NOW,
    );

    expect(escalated?.expiresAt).toBe(grant().expiresAt);
  });

  it('refuses a reduction to nothing', () => {
    expect(() => review({ outcome: 'reduce', reducedTo: [], notes: 'Nothing left.' })).toThrow(
      /is a revocation/,
    );
  });

  it('requires a note for anything but a plain certification', () => {
    expect(() => review({ outcome: 'revoke' })).toThrow(/asks why/);
  });

  it('reports grants that will lapse because nobody reviewed them', () => {
    // Doing nothing ends a grant. A campaign where doing nothing preserves the status quo gets
    // skipped, and the skipping is invisible.
    const lapsing = lapsingGrants([grant({ expiresAt: '2026-06-15T00:00:00.000Z' })], [], NOW, 30);

    expect(lapsing).toHaveLength(1);
  });

  it('leaves a reviewed grant out of the lapsing list', () => {
    expect(
      lapsingGrants([grant({ expiresAt: '2026-06-15T00:00:00.000Z' })], [review()], NOW, 30),
    ).toEqual([]);
  });

  it('scopes a campaign by classification', () => {
    expect(campaignScope([grant()], catalogWith('RESTRICTED'), 'RESTRICTED')).toHaveLength(1);
    expect(campaignScope([grant()], catalogWith('INTERNAL'), 'RESTRICTED')).toHaveLength(0);
  });
});

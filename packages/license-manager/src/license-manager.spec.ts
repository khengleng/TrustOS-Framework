import { describe, expect, it } from 'vitest';
import {
  assertEnvironmentCount,
  assertFeature,
  entitlementsOf,
  evaluateLicense,
  licenseSchema,
  OPEN_SOURCE_LICENSE,
  parseLicense,
} from './index';

const NOW = new Date('2026-07-01T00:00:00.000Z');

const commercial = {
  licenseId: 'lic-123',
  tier: 'commercial' as const,
  issuedTo: 'Acme Ltd',
  issuedAt: '2026-01-01',
  expiresAt: '2027-01-01',
  frameworkRange: '^0.5.0',
  additionalFeatures: [],
  maxEnvironments: 3,
};

describe('what a licence may gate', () => {
  it('gives open source everything the framework needs to run', () => {
    /*
     * The list is empty on purpose. A framework that puts authentication behind a paid tier
     * produces deployments that turn it off, and the people harmed never saw the invoice.
     */
    expect(entitlementsOf(OPEN_SOURCE_LICENSE)).toEqual([]);

    const status = evaluateLicense(OPEN_SOURCE_LICENSE, { frameworkVersion: '0.5.0', now: NOW });

    expect(status.state).toBe('valid');
    expect(status.daysRemaining).toBeNull();
  });

  it('refuses an open-source licence that expires', () => {
    // That is not an open-source licence, and the contradiction should not be shippable.
    expect(() =>
      licenseSchema.parse({ ...OPEN_SOURCE_LICENSE, expiresAt: '2027-01-01' }),
    ).toThrow();
  });
});

describe('expiry', () => {
  it('warns inside the renewal window', () => {
    const status = evaluateLicense(
      { ...commercial, expiresAt: '2026-07-20' },
      {
        frameworkVersion: '0.5.0',
        now: NOW,
      },
    );

    expect(status.state).toBe('expiring');
    expect(status.daysRemaining).toBe(19);
  });

  it('degrades rather than detonating once expired', () => {
    /*
     * A platform that shut down a hospital's admissions because a purchase order was late has
     * chosen the wrong failure.
     */
    const status = evaluateLicense(
      { ...commercial, expiresAt: '2026-06-01' },
      {
        frameworkVersion: '0.5.0',
        now: NOW,
      },
    );

    expect(status.state).toBe('expired');
    expect(status.features).toEqual([]);
    expect(status.detail).toMatch(/Running services are unaffected/);
  });

  it('reports a licence that does not cover this framework version', () => {
    const status = evaluateLicense(commercial, { frameworkVersion: '0.9.0', now: NOW });

    expect(status.state).toBe('not-applicable');
    expect(status.features).toEqual([]);
  });
});

describe('entitlements', () => {
  it('gives each tier its features, and enterprise all of them', () => {
    expect(entitlementsOf(commercial)).toEqual(['platform.analytics', 'plugins.commercial']);
    expect(entitlementsOf({ ...commercial, tier: 'enterprise' })).toHaveLength(5);
  });

  it('adds negotiated features on top of the tier', () => {
    expect(
      entitlementsOf({ ...commercial, additionalFeatures: ['platform.multi-region'] }),
    ).toContain('platform.multi-region');
  });

  it('refuses a gated operation with a message that says what to do', () => {
    // "Requires an enterprise licence" with no next step is a dead end somebody patches out.
    const status = evaluateLicense(commercial, { frameworkVersion: '0.5.0', now: NOW });

    expect(() => assertFeature(status, 'platform.multi-region')).toThrow(
      /Everything the framework needs to run safely is unlicensed/,
    );
    expect(() => assertFeature(status, 'platform.analytics')).not.toThrow();
  });
});

describe('environments', () => {
  it('bounds the count when the agreement does', () => {
    expect(() => assertEnvironmentCount(commercial, 3)).not.toThrow();
    expect(() => assertEnvironmentCount(commercial, 4)).toThrow(/covers 3 environment/);
  });

  it('treats zero as unbounded', () => {
    expect(() => assertEnvironmentCount({ ...commercial, maxEnvironments: 0 }, 99)).not.toThrow();
  });
});

describe('parsing', () => {
  it('accepts a well-formed licence', () => {
    expect(parseLicense(commercial).licenseId).toBe('lic-123');
  });

  it('refuses a malformed one with a usable message', () => {
    expect(() => parseLicense({ ...commercial, tier: 'platinum' })).toThrow();
  });
});

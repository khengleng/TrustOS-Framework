import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { isValidVersion, satisfies } from '@trustsystem/version-manager';

/**
 * Licensing and feature entitlements.
 *
 * Three rules, and the third is the one that keeps this honest.
 *
 * **A licence gates commercial features, never security ones.** Audit, tenant isolation,
 * encryption, RBAC and the guard chain are not entitlements and never will be. A framework that
 * puts authentication behind a paid tier produces deployments that turn it off, and the people
 * harmed are the ones who never saw the invoice.
 *
 * **Expiry degrades, it does not detonate.** An expired licence stops *new* privileged operations
 * and leaves the running system running. A platform that shuts down a hospital's admissions
 * because a purchase order was late has chosen the wrong failure.
 *
 * **Validation is offline.** No licence server, no phone-home, no kill switch. A signed token the
 * deployment holds, checked locally. Anything else means whoever controls the network controls
 * whether the software runs.
 */

export const LICENSE_TIERS = ['open-source', 'commercial', 'enterprise'] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];

/**
 * Features a licence may gate.
 *
 * Deliberately short, and deliberately containing nothing a deployment needs to be safe. Adding
 * an entry here is a commercial decision that a reviewer should be able to see in one diff.
 */
export const GATED_FEATURES = [
  'marketplace.private-registry',
  'platform.analytics',
  'platform.multi-region',
  'support.priority',
  'plugins.commercial',
] as const;

export type GatedFeature = (typeof GATED_FEATURES)[number];

/** What each tier includes. Open source gets the framework; the tiers add operations tooling. */
const TIER_FEATURES: Record<LicenseTier, readonly GatedFeature[]> = {
  'open-source': [],
  commercial: ['platform.analytics', 'plugins.commercial'],
  enterprise: [...GATED_FEATURES],
};

export const licenseSchema = z
  .object({
    /** Opaque id, for support and revocation. */
    licenseId: z.string().min(4).max(80),
    tier: z.enum(LICENSE_TIERS),
    /** Who it was issued to. Appears in `trustos platform info`. */
    issuedTo: z.string().min(1).max(160),
    issuedAt: z.string().min(10).max(40),
    /** ISO date. Absent means perpetual — which open source always is. */
    expiresAt: z.string().min(10).max(40).optional(),
    /** Framework range this licence covers. A perpetual licence still bounds what it entitles. */
    frameworkRange: z.string().min(2).max(40).default('>=0.0.0'),
    /** Extra features beyond the tier. For a negotiated agreement. */
    additionalFeatures: z.array(z.enum(GATED_FEATURES)).default([]),
    /** Seats or environments, if the agreement bounds them. Zero means unbounded. */
    maxEnvironments: z.number().int().min(0).default(0),
    signature: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((license, ctx) => {
    if (license.tier === 'open-source' && license.expiresAt) {
      /*
       * An open-source licence that expires is not an open-source licence. Refused here so the
       * contradiction cannot be shipped and then argued about later.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'An open-source licence does not expire.',
      });
    }
  });

export type License = z.infer<typeof licenseSchema>;

/** The licence every deployment has until it has another. */
export const OPEN_SOURCE_LICENSE: License = {
  licenseId: 'open-source',
  tier: 'open-source',
  issuedTo: 'Everyone',
  issuedAt: '2026-01-01',
  frameworkRange: '>=0.0.0',
  additionalFeatures: [],
  maxEnvironments: 0,
};

export type LicenseState = 'valid' | 'expiring' | 'expired' | 'not-applicable';

export interface LicenseStatus {
  license: License;
  state: LicenseState;
  /** Null for a perpetual licence. Negative when already expired. */
  daysRemaining: number | null;
  features: GatedFeature[];
  detail: string;
}

/** How long before expiry a deployment should be told. Long enough to renew through procurement. */
export const EXPIRY_WARNING_DAYS = 30;

export function evaluateLicense(
  license: License,
  options: { frameworkVersion: string; now?: Date },
): LicenseStatus {
  const now = options.now ?? new Date();
  const features = entitlementsOf(license);

  if (!satisfies(options.frameworkVersion, license.frameworkRange)) {
    return {
      license,
      state: 'not-applicable',
      daysRemaining: null,
      features: [],
      detail:
        `Licence ${license.licenseId} covers framework ${license.frameworkRange}; this is ` +
        `${options.frameworkVersion}. Gated features are unavailable until the licence is extended.`,
    };
  }

  if (!license.expiresAt) {
    return {
      license,
      state: 'valid',
      daysRemaining: null,
      features,
      detail: `${license.tier} licence, perpetual.`,
    };
  }

  const remaining = Math.floor(
    (new Date(license.expiresAt).getTime() - now.getTime()) / 86_400_000,
  );

  if (remaining < 0) {
    return {
      license,
      state: 'expired',
      daysRemaining: remaining,
      // Expired means no *new* privileged operations. What is running keeps running — see the
      // header. So the entitlement list is empty and nothing is shut down.
      features: [],
      detail:
        `Licence ${license.licenseId} expired ${Math.abs(remaining)} day(s) ago. Running services ` +
        'are unaffected; gated features are unavailable until it is renewed.',
    };
  }

  return {
    license,
    state: remaining <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid',
    daysRemaining: remaining,
    features,
    detail:
      remaining <= EXPIRY_WARNING_DAYS
        ? `Licence ${license.licenseId} expires in ${remaining} day(s).`
        : `${license.tier} licence, valid for another ${remaining} day(s).`,
  };
}

export function entitlementsOf(license: License): GatedFeature[] {
  return [...new Set([...TIER_FEATURES[license.tier], ...license.additionalFeatures])].sort();
}

export function hasFeature(status: LicenseStatus, feature: GatedFeature): boolean {
  return status.features.includes(feature);
}

/**
 * Refuses a gated operation.
 *
 * The message says what to do, not just what is missing. "Requires an enterprise licence" with no
 * next step is a dead end somebody works around by patching the check out.
 */
export function assertFeature(status: LicenseStatus, feature: GatedFeature): void {
  if (hasFeature(status, feature)) return;

  const reason =
    status.state === 'expired'
      ? `the ${status.license.tier} licence expired`
      : `the ${status.license.tier} licence does not include it`;

  throw ApiError.forbidden(
    `"${feature}" is unavailable because ${reason}. Everything the framework needs to run safely ` +
      'is unlicensed and always will be — this is an operations feature.',
  );
}

/** Refuses more environments than the agreement allows. Zero means unbounded. */
export function assertEnvironmentCount(license: License, count: number): void {
  if (license.maxEnvironments === 0 || count <= license.maxEnvironments) return;

  throw ApiError.forbidden(
    `Licence ${license.licenseId} covers ${license.maxEnvironments} environment(s); ${count} are registered.`,
  );
}

export function parseLicense(raw: unknown): License {
  const parsed = licenseSchema.safeParse(raw);

  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'license',
        message: issue.message,
        code: 'invalid_license',
      })),
      'Invalid licence.',
    );
  }

  if (!isValidVersion(parsed.data.frameworkRange.replace(/^[\^~>=]+/, ''))) {
    throw ApiError.validation(
      [{ path: 'frameworkRange', message: 'Not a version range.', code: 'invalid_license' }],
      'Invalid licence.',
    );
  }

  return parsed.data;
}

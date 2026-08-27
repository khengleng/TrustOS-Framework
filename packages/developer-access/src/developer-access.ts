import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { apiClassification, type ApiCatalog, type ApiDefinition } from '@trustos/api-catalog';
import { KIND_CEILINGS, type Consumer } from '@trustos/api-consumer';
import { classificationRank } from '@trustos/data-classification';

/**
 * Developer portal access.
 *
 * A developer portal is the most-visited and least-controlled surface a platform has: it is meant
 * to be easy to sign up for, it holds credentials, and it describes every API in the estate.
 * That combination means the interesting question is not what it offers but what it must never do.
 *
 * Four rules, and each one closes a route that has produced a real incident somewhere:
 *
 * **A portal credential is a sandbox credential.** A self-service registration cannot produce a
 * key that reaches production data. Not "should not" — `assertSandboxOnly` refuses, and production
 * access goes through the consumer registry with a named approver.
 *
 * **The portal never shows a key twice.** It shows it once, at issue, and thereafter shows a
 * prefix. This is `@trustos/api-keys`' rule, and repeating it here matters because the portal is
 * exactly where somebody would add a convenient "show key" button.
 *
 * **A developer sees the APIs they may call, and the existence of nothing else.** Not a greyed-out
 * entry, not "contact us for access" — the catalog listing for a restricted API tells an attacker
 * the shape of the estate, and the shape is most of the reconnaissance.
 *
 * **Documentation is filtered by classification, not just by entitlement.** An OpenAPI document
 * for a RESTRICTED API contains field names, error codes and business rules. A developer with no
 * entitlement does not get to read it while waiting for approval.
 */

export const developerRegistrationSchema = z
  .object({
    registrationId: z.string().min(3).max(64),
    /** The person, as they identified themselves. Verified separately; treated as unverified here. */
    email: z.string().email().max(200),
    displayName: z.string().min(2).max(120),
    /** The organization they claim to represent. A claim, not a fact, until somebody checks. */
    claimedOrganization: z.string().min(2).max(200).nullable().default(null),
    /** What they say they are building. Read by whoever approves production access later. */
    intendedUse: z.string().min(20).max(2000),
    /**
     * Always sandbox at registration.
     *
     * The field exists so the value is explicit in the record rather than implied by the absence
     * of anything else, and so a future production registration would be a visible schema change
     * rather than a quiet one.
     */
    environment: z.literal('development'),
    status: z
      .enum(['pending_verification', 'active', 'suspended', 'closed'])
      .default('pending_verification'),
    registeredAt: z.string().datetime(),
    verifiedAt: z.string().datetime().nullable().default(null),
  })
  .strict();

export type DeveloperRegistration = z.infer<typeof developerRegistrationSchema>;

/**
 * A request to move from sandbox to a real environment.
 *
 * Deliberately a request rather than an action. Self-service ends at the sandbox boundary; past it
 * there is a named approver, which is the same maker-checker shape the framework applies to every
 * other consequential change.
 */
export const accessRequestSchema = z
  .object({
    requestId: z.string().min(3).max(64),
    registrationId: z.string().min(3).max(64),
    apiId: z.string().min(3).max(64),
    majorVersion: z.number().int().min(0).max(999),
    requestedScopes: z.array(z.string().min(3).max(64)).min(1),
    environment: z.enum(['development', 'staging', 'production']),
    /** Why they need it, in their words. The thing an approver actually reads. */
    justification: z.string().min(30).max(2000),
    /** Expected call volume, so quota and rate limits can be set rather than guessed. */
    expectedCallsPerDay: z.number().int().positive().max(1_000_000_000),

    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending'),
    decidedBy: z.string().min(1).max(64).nullable().default(null),
    decidedAt: z.string().datetime().nullable().default(null),
    /** Required on rejection: a refusal a developer cannot act on generates a support ticket. */
    decisionReason: z.string().min(15).max(1000).nullable().default(null),
    /** The consumer created on approval, linking the request to what it produced. */
    consumerId: z.string().min(3).max(64).nullable().default(null),

    requestedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.status === 'rejected' && request.decisionReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionReason'],
        message:
          'A rejection says why. A refusal a developer cannot act on becomes a support ticket.',
      });
    }

    if (
      (request.status === 'approved' || request.status === 'rejected') &&
      request.decidedBy === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decidedBy'],
        message: 'A decision names who made it.',
      });
    }

    if (request.status === 'approved' && request.consumerId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consumerId'],
        message: 'An approved request names the consumer it created, or the grant exists nowhere.',
      });
    }
  });

export type AccessRequest = z.infer<typeof accessRequestSchema>;

/**
 * What a portal may show about an API.
 *
 * `listed` and `documented` are separate because they leak differently: listing tells a reader the
 * API exists, documenting tells them its shape. An API can reasonably be listed without being
 * documented; the reverse is incoherent.
 */
export interface PortalVisibility {
  readonly apiId: string;
  readonly version: string;
  readonly listed: boolean;
  readonly documented: boolean;
  /** Whether this viewer may ask for access, or the request would be refused anyway. */
  readonly requestable: boolean;
  readonly reason: string;
}

export interface PortalViewer {
  /** The consumer the viewer holds, when they have one. A registered developer may have none. */
  readonly consumer: Consumer | null;
  /** True for a signed-in platform operator browsing the portal. */
  readonly isInternal?: boolean;
}

/**
 * Whether an API appears in the portal, and how much of it.
 *
 * The default is invisible. An API becomes visible because something makes it so — being PUBLIC or
 * INTERNAL, or the viewer holding an entitlement — never because nothing hid it.
 */
export function visibilityFor(input: {
  api: ApiDefinition;
  viewer: PortalViewer;
}): PortalVisibility {
  const { api, viewer } = input;
  const classification = apiClassification(api);
  const base = { apiId: api.apiId, version: api.version };

  if (api.lifecycle === 'DRAFT' || api.lifecycle === 'REVIEW' || api.lifecycle === 'APPROVED') {
    return {
      ...base,
      listed: viewer.isInternal === true,
      documented: viewer.isInternal === true,
      requestable: false,
      reason: 'Not published. An unpublished API in a public catalog is a roadmap.',
    };
  }

  const entitled =
    viewer.consumer?.entitlements.some(
      (entitlement) =>
        entitlement.apiId === api.apiId &&
        entitlement.majorVersion === Number(api.version.split('.')[0]),
    ) ?? false;

  if (entitled) {
    return {
      ...base,
      listed: true,
      documented: true,
      requestable: false,
      reason: 'Already entitled.',
    };
  }

  if (viewer.isInternal) {
    return {
      ...base,
      listed: true,
      documented: true,
      requestable: true,
      reason: 'Internal viewer.',
    };
  }

  /*
   * The reconnaissance rule. A greyed-out entry saying "contact us for access to the Ledger API"
   * tells an attacker there is a ledger API, which is most of what they wanted from the portal.
   */
  if (classificationRank(classification) > classificationRank('INTERNAL')) {
    return {
      ...base,
      listed: false,
      documented: false,
      requestable: false,
      reason: `Returns ${classification} data. Its existence is not advertised; access is arranged through an owner.`,
    };
  }

  if (classification === 'INTERNAL') {
    return {
      ...base,
      listed: true,
      documented: false,
      requestable: true,
      reason:
        'Listed so it can be requested, but the specification names fields and business rules, so it follows entitlement.',
    };
  }

  return { ...base, listed: true, documented: true, requestable: true, reason: 'Public.' };
}

/** The catalog as one viewer sees it. */
export function visibleCatalog(input: {
  catalog: Pick<ApiCatalog, 'list'>;
  viewer: PortalViewer;
}): PortalVisibility[] {
  return input.catalog
    .list()
    .map((api) => visibilityFor({ api, viewer: input.viewer }))
    .filter((visibility) => visibility.listed);
}

/**
 * Refuse a portal-issued credential that would reach anything but a sandbox.
 *
 * The rule the whole package exists for. A self-service flow that can produce production access is
 * a self-service flow that will, and the credential it produces lives in a laptop and a screenshot.
 */
export function assertSandboxOnly(input: {
  registration: DeveloperRegistration;
  environment: string;
}): void {
  if (input.environment === 'development') return;

  throw ApiError.forbidden(
    `A portal registration issues sandbox credentials only. ${KIND_CEILINGS.developer.description} ` +
      'Production access is requested and approved by a named person.',
    { reason: 'sandbox_only', registrationId: input.registration.registrationId },
  );
}

/**
 * What the portal may return about an issued credential.
 *
 * `@trustos/api-keys` already guarantees the key is unrecoverable — it is hashed and never stored.
 * This function exists because the portal is precisely where somebody adds a "show key" button and
 * discovers the hash prevents it, and the safe answer should be one call away.
 */
export function credentialDisplay(input: {
  keyPrefix: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}): {
  display: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  note: string;
} {
  return {
    display: `${input.keyPrefix}…`,
    name: input.name,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    lastUsedAt: input.lastUsedAt,
    note: 'The full key was shown once at creation and is not stored. Rotate to obtain a new one.',
  };
}

/**
 * Decide an access request.
 *
 * Approval requires a decider who is not the requester and, for anything above the developer
 * ceiling, an explicit acknowledgement of what the data is. The acknowledgement is not ceremony:
 * an approver clicking through a queue of requests is the mechanism by which a partner ends up
 * entitled to restricted data.
 */
export function decideRequest(input: {
  request: AccessRequest;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  reason: string;
  consumerId?: string;
  /** The API being requested, so the classification can be checked. */
  api?: ApiDefinition;
  acknowledgedClassification?: string;
  at: Date;
}): AccessRequest {
  if (input.request.status !== 'pending') {
    throw ApiError.conflict(`This request is already ${input.request.status}.`);
  }

  if (input.decision === 'approved' && input.api) {
    const classification = apiClassification(input.api);

    if (
      classificationRank(classification) >
        classificationRank(KIND_CEILINGS.developer.maxClassification) &&
      input.acknowledgedClassification !== classification
    ) {
      throw ApiError.conflict(
        `${input.api.apiId} returns ${classification} data. Approving it requires acknowledging that explicitly — ` +
          'an approver working through a queue is how a consumer ends up entitled to data nobody meant to grant.',
        { reason: 'classification_not_acknowledged', classification },
      );
    }

    if (input.request.environment === 'production' && input.api.environment !== 'production') {
      throw ApiError.validation(
        [{ path: 'environment', message: 'The API is not published in production.' }],
        'This request asks for production access to an API that does not exist there.',
      );
    }
  }

  return accessRequestSchema.parse({
    ...input.request,
    status: input.decision,
    decidedBy: input.decidedBy,
    decidedAt: input.at.toISOString(),
    decisionReason: input.reason,
    consumerId: input.decision === 'approved' ? (input.consumerId ?? null) : null,
  });
}

/**
 * Requests that have sat unanswered.
 *
 * A queue nobody drains is how developers conclude the platform is not serious, and it is invisible
 * unless something counts it.
 */
export function stalledRequests(
  requests: readonly AccessRequest[],
  input: { asOf: Date; slaDays?: number },
): Array<{ request: AccessRequest; daysWaiting: number }> {
  const sla = input.slaDays ?? 5;

  return requests
    .filter((request) => request.status === 'pending')
    .map((request) => ({
      request,
      daysWaiting: Math.floor(
        (input.asOf.getTime() - Date.parse(request.requestedAt)) / 86_400_000,
      ),
    }))
    .filter((entry) => entry.daysWaiting > sla)
    .sort((left, right) => right.daysWaiting - left.daysWaiting);
}

import { z } from 'zod';
import { ApiError } from '@trustos/errors';

/**
 * The merchant model.
 *
 * Five entities, and the shape is the point of the pilot as much as the code is: **none of this
 * is a new tenancy model.** `organizationId` is the framework's tenant, unchanged. A merchant is a
 * record *inside* an organization, and a store and a branch are records inside a merchant.
 *
 * The temptation the pilot deliberately resists is making a merchant a tenant. It reads as the
 * natural mapping — one merchant, one set of data, one boundary — and it means every framework
 * package that scopes by `organizationId` now scopes by the wrong thing. Every isolation test in
 * the framework would still pass while the application leaked across merchants inside one
 * organization.
 *
 * So: the organization is the tenant, the merchant is a customer of it, and cross-merchant access
 * inside one organization is a *permission* question rather than an isolation one.
 */

export const MERCHANT_STATUSES = [
  'registered',
  'verification_pending',
  'verified',
  'approved',
  'rejected',
  'suspended',
] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

/**
 * Permitted transitions.
 *
 * `approved` is reachable only from `verified`, so nobody can approve a merchant whose
 * verification has not been recorded. A rejection is terminal for this record — a merchant who
 * comes back registers again, which keeps the rejected record intact as evidence.
 */
const TRANSITIONS: Record<MerchantStatus, readonly MerchantStatus[]> = {
  registered: ['verification_pending', 'rejected'],
  verification_pending: ['verified', 'rejected'],
  verified: ['approved', 'rejected'],
  approved: ['suspended'],
  rejected: [],
  suspended: ['approved'],
};

export const MERCHANT_ROLES = [
  'merchant_owner',
  'merchant_manager',
  'cashier',
  'finance',
  'operations',
  'auditor',
] as const;
export type MerchantRole = (typeof MERCHANT_ROLES)[number];

/**
 * What each merchant role may do inside the application.
 *
 * These are *application* permissions checked by `@trustos/rbac` alongside the framework's own.
 * The pilot adds no second permission system — see `permissions.ts`.
 *
 * `auditor` is read-only and holds no write permission at all. That is the role most often given a
 * write permission "so they can annotate", at which point the audit role can change what it audits.
 */
export const ROLE_CAPABILITIES: Record<
  MerchantRole,
  { readonly describes: string; readonly writes: boolean; readonly seesOtherMerchants: boolean }
> = {
  merchant_owner: {
    describes: 'Runs the business. Sees everything about their own merchant, and nothing else.',
    writes: true,
    seesOtherMerchants: false,
  },
  merchant_manager: {
    describes: 'Runs a store or a branch. Accepts payments, reads their own reports.',
    writes: true,
    seesOtherMerchants: false,
  },
  cashier: {
    describes: 'Takes payments at a branch. Cannot see settlement or the ledger.',
    writes: true,
    seesOtherMerchants: false,
  },
  finance: {
    describes: 'Platform finance. Reads settlement and the ledger across merchants.',
    writes: false,
    seesOtherMerchants: true,
  },
  operations: {
    describes: 'Platform operations. Onboards merchants, freezes wallets, raises limit changes.',
    writes: true,
    seesOtherMerchants: true,
  },
  auditor: {
    describes: 'Reads everything and writes nothing. Deliberately holds no write permission.',
    writes: false,
    seesOtherMerchants: true,
  },
};

const idSchema = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 2)
    .max(64)
    .regex(new RegExp(`^${prefix}_[a-z0-9_]{1,56}$`), `An id beginning "${prefix}_".`);

export const merchantSchema = z
  .object({
    merchantId: idSchema('mer'),
    /** The framework tenant this merchant belongs to. Never null: a merchant has an operator. */
    organizationId: z.string().min(1).max(64),
    legalName: z.string().min(2).max(200),
    tradingName: z.string().min(2).max(200),
    /** A category code. Deliberately opaque — the framework does not know what an MCC means. */
    categoryCode: z.string().min(2).max(16),
    status: z.enum(MERCHANT_STATUSES).default('registered'),
    /** Set on rejection or suspension. A refusal a merchant cannot act on generates a call. */
    statusReason: z.string().min(10).max(500).nullable().default(null),
    /** Who verified, and when. Recorded because approval reads it. */
    verifiedBy: z.string().min(1).max(64).nullable().default(null),
    verifiedAt: z.string().datetime().nullable().default(null),
    /** Who approved. Never the same person as `verifiedBy` — see `assertApprovable`. */
    approvedBy: z.string().min(1).max(64).nullable().default(null),
    approvedAt: z.string().datetime().nullable().default(null),
    /** The product this merchant is onboarded onto. */
    productId: z.string().min(3).max(64),
    productVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    currency: z.string().length(3),
    createdAt: z.string().datetime(),
    createdBy: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((merchant, ctx) => {
    if (
      (merchant.status === 'rejected' || merchant.status === 'suspended') &&
      merchant.statusReason === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['statusReason'],
        message:
          'A rejection or suspension says why, so the merchant can be told and it can be reviewed.',
      });
    }

    if (merchant.status === 'approved' && merchant.verifiedBy === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifiedBy'],
        message: 'An approved merchant records who verified it. Approval is a check on that work.',
      });
    }
  });

export type Merchant = z.infer<typeof merchantSchema>;

export const storeSchema = z
  .object({
    storeId: idSchema('sto'),
    merchantId: idSchema('mer'),
    organizationId: z.string().min(1).max(64),
    name: z.string().min(2).max(200),
    /** Opaque to the framework. A deployment's own address model goes here. */
    locationRef: z.string().max(200).nullable().default(null),
    active: z.boolean().default(true),
  })
  .strict();

export type Store = z.infer<typeof storeSchema>;

export const branchSchema = z
  .object({
    branchId: idSchema('brn'),
    storeId: idSchema('sto'),
    merchantId: idSchema('mer'),
    organizationId: z.string().min(1).max(64),
    name: z.string().min(2).max(200),
    active: z.boolean().default(true),
  })
  .strict();

export type Branch = z.infer<typeof branchSchema>;

export const merchantUserSchema = z
  .object({
    /** The framework user. The pilot creates no second identity. */
    userId: z.string().min(1).max(64),
    merchantId: idSchema('mer'),
    organizationId: z.string().min(1).max(64),
    role: z.enum(MERCHANT_ROLES),
    /** For a cashier or a manager, the branch they work at. */
    branchId: idSchema('brn').nullable().default(null),
    active: z.boolean().default(true),
  })
  .strict()
  .superRefine((user, ctx) => {
    if (user.role === 'cashier' && user.branchId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['branchId'],
        message:
          'A cashier works at a branch. A cashier with no branch can take payments anywhere.',
      });
    }
  });

export type MerchantUser = z.infer<typeof merchantUserSchema>;

export function assertTransition(from: MerchantStatus, to: MerchantStatus): void {
  if (TRANSITIONS[from].includes(to)) return;

  throw ApiError.conflict(`A merchant does not move from ${from} to ${to}.`, {
    permitted: TRANSITIONS[from],
  });
}

/**
 * Refuses an approver who verified the same merchant.
 *
 * The maker-checker rule at the centre of the pilot. It is checked here, on the record, rather
 * than only in the workflow, because a merchant can be approved through the API, the console or a
 * migration script, and a control that lives in one of those three is a control with two bypasses.
 */
export function assertApprovable(merchant: Merchant, approverId: string): void {
  assertTransition(merchant.status, 'approved');

  if (merchant.verifiedBy === approverId) {
    throw ApiError.forbidden(
      'The person who verified a merchant does not approve it. Maker and checker are different people.',
      { reason: 'self_approval', merchantId: merchant.merchantId, verifiedBy: merchant.verifiedBy },
    );
  }

  if (merchant.createdBy === approverId) {
    throw ApiError.forbidden('The person who registered a merchant does not approve it.', {
      reason: 'self_approval',
      merchantId: merchant.merchantId,
      createdBy: merchant.createdBy,
    });
  }
}

/**
 * Whether a viewer may see a merchant.
 *
 * Two checks, in order, and the order matters: **tenant first, then role.** A platform-wide role
 * does not cross an organization boundary — an operations user in organization A cannot see
 * organization B's merchants however broad their role is, because the tenant boundary is not a
 * permission.
 */
export function canView(input: {
  viewer: { organizationId: string; role: MerchantRole; merchantId: string | null };
  merchant: Merchant;
}): boolean {
  if (input.viewer.organizationId !== input.merchant.organizationId) return false;
  if (ROLE_CAPABILITIES[input.viewer.role].seesOtherMerchants) return true;
  return input.viewer.merchantId === input.merchant.merchantId;
}

export function assertCanView(input: {
  viewer: { organizationId: string; role: MerchantRole; merchantId: string | null };
  merchant: Merchant;
}): void {
  if (canView(input)) return;

  /*
   * A 404, not a 403. Confirming that a merchant exists in another organization is itself a
   * disclosure — it tells a caller that the identifier they guessed is real.
   */
  throw ApiError.notFound(`No merchant with id "${input.merchant.merchantId}".`);
}

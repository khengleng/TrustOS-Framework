import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { AuditService } from '@trustsystem/audit';
import type { WalletService } from '@trustsystem/wallet';
import {
  assertApprovable,
  assertTransition,
  merchantSchema,
  type Merchant,
  type MerchantStatus,
} from './merchant';

/**
 * Merchant onboarding, and one controlled configuration change.
 *
 * Both are maker-checker, and they demonstrate the two shapes it takes:
 *
 * **Onboarding** is a state machine where the maker and the checker act on the *same record* at
 * different states. Verification is the maker's work; approval is the checker's. The record itself
 * refuses a checker who was the maker — see `assertApprovable`.
 *
 * **A limit change** is a *request* that exists separately from the thing it changes. Nothing
 * changes until it is approved, and the pending request is a record somebody can see and cancel.
 *
 * The second shape is the harder one to get right and the one people skip, because "just change
 * the limit and audit it" is one line. The difference shows up the first time a limit is raised at
 * 2am by somebody who then leaves the company: with a request there is a decision to read, and
 * with an audited edit there is a row saying what happened and nothing saying why it was allowed.
 */

export const rejectionSchema = z
  .object({
    reason: z.string().min(15).max(500),
    /** Whether the merchant may fix this and come back. A rejection with no path is a refusal. */
    reworkPermitted: z.boolean(),
    /** What to fix, when rework is permitted. */
    remediation: z.string().min(10).max(1000).nullable().default(null),
  })
  .strict()
  .superRefine((rejection, ctx) => {
    if (rejection.reworkPermitted && rejection.remediation === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remediation'],
        message:
          'If they may come back, say what to fix. Otherwise they come back with the same file.',
      });
    }
  });

export type Rejection = z.infer<typeof rejectionSchema>;

export const limitChangeRequestSchema = z
  .object({
    requestId: z.string().min(3).max(64),
    merchantId: z.string().min(3).max(64),
    organizationId: z.string().min(1).max(64),
    /** Which limit, by its key in `@trustsystem/limits`. */
    limitKey: z.string().min(3).max(64),
    /** Minor-unit string. Money never floats. */
    currentValue: z.string().regex(/^\d{1,18}$/),
    requestedValue: z.string().regex(/^\d{1,18}$/),
    /** Why. Read by the approver, which is the whole point of the request existing. */
    justification: z.string().min(20).max(1000),
    requestedBy: z.string().min(1).max(64),
    requestedAt: z.string().datetime(),
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).default('pending'),
    decidedBy: z.string().min(1).max(64).nullable().default(null),
    decidedAt: z.string().datetime().nullable().default(null),
    decisionReason: z.string().min(10).max(500).nullable().default(null),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.status === 'rejected' && request.decisionReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionReason'],
        message: 'A rejected request says why.',
      });
    }

    if (request.currentValue === request.requestedValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedValue'],
        message: 'The requested value is the current one. There is nothing to approve.',
      });
    }
  });

export type LimitChangeRequest = z.infer<typeof limitChangeRequestSchema>;

export interface OnboardingOptions {
  wallets: WalletService;
  audit?: Pick<AuditService, 'record'>;
  now?: () => Date;
  /** Opened on approval. A wallet before approval is a wallet that can receive money. */
  openWalletOnApproval?: boolean;
}

export class MerchantOnboarding {
  private readonly merchants = new Map<string, Merchant>();
  private readonly limitRequests = new Map<string, LimitChangeRequest>();
  private readonly now: () => Date;

  constructor(private readonly options: OnboardingOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private static key(organizationId: string, merchantId: string): string {
    return `${organizationId}::${merchantId}`;
  }

  async register(input: unknown, actorId: string): Promise<Merchant> {
    const merchant = merchantSchema.parse(input);

    if (merchant.createdBy !== actorId) {
      throw ApiError.validation(
        [{ path: 'createdBy', message: 'The registering actor is recorded, not supplied.' }],
        'A registration records who made it.',
      );
    }

    const key = MerchantOnboarding.key(merchant.organizationId, merchant.merchantId);

    if (this.merchants.has(key)) {
      throw ApiError.conflict(`Merchant ${merchant.merchantId} is already registered.`);
    }

    this.merchants.set(key, merchant);

    await this.options.audit?.record({
      action: 'mwb.merchant.registered',
      entityType: 'merchant',
      entityId: merchant.merchantId,
      actorId,
      organizationId: merchant.organizationId,
      after: { status: merchant.status, legalName: merchant.legalName },
    });

    return merchant;
  }

  get(organizationId: string, merchantId: string): Merchant | null {
    return this.merchants.get(MerchantOnboarding.key(organizationId, merchantId)) ?? null;
  }

  /**
   * Reads a merchant, scoped to a tenant.
   *
   * The signature takes `organizationId` first and non-optionally, which is the framework's
   * convention and is what stops a caller reaching a merchant by id alone. A lookup by id that
   * then filters is a lookup that returns the wrong thing when somebody forgets the filter.
   */
  require(organizationId: string, merchantId: string): Merchant {
    const merchant = this.get(organizationId, merchantId);
    if (!merchant) throw ApiError.notFound(`No merchant with id "${merchantId}".`);
    return merchant;
  }

  list(organizationId: string, filter: { status?: MerchantStatus } = {}): Merchant[] {
    return [...this.merchants.values()].filter((merchant) => {
      if (merchant.organizationId !== organizationId) return false;
      if (filter.status && merchant.status !== filter.status) return false;
      return true;
    });
  }

  /** The maker's step. Records who did the verification, which approval then reads. */
  async verify(input: {
    organizationId: string;
    merchantId: string;
    actorId: string;
    notes: string;
  }): Promise<Merchant> {
    const merchant = this.require(input.organizationId, input.merchantId);
    assertTransition(merchant.status, 'verification_pending');

    const next = merchantSchema.parse({
      ...merchant,
      status: 'verified',
      verifiedBy: input.actorId,
      verifiedAt: this.now().toISOString(),
    });

    // Recorded as verified directly: `verification_pending` is the state while somebody is doing
    // the work, and this call is the work being finished.
    this.merchants.set(MerchantOnboarding.key(input.organizationId, input.merchantId), next);

    await this.options.audit?.record({
      action: 'mwb.merchant.verified',
      entityType: 'merchant',
      entityId: merchant.merchantId,
      actorId: input.actorId,
      organizationId: input.organizationId,
      before: { status: merchant.status },
      after: { status: 'verified' },
      metadata: { notes: input.notes },
    });

    return next;
  }

  /**
   * The checker's step.
   *
   * `assertApprovable` refuses the verifier and the registrar. Both, because a two-person control
   * that only excluded the immediately preceding actor would be satisfied by one person
   * registering, a second verifying, and the first approving.
   */
  async approve(input: {
    organizationId: string;
    merchantId: string;
    actorId: string;
    reason: string;
  }): Promise<Merchant> {
    const merchant = this.require(input.organizationId, input.merchantId);
    assertApprovable(merchant, input.actorId);

    const next = merchantSchema.parse({
      ...merchant,
      status: 'approved',
      approvedBy: input.actorId,
      approvedAt: this.now().toISOString(),
    });

    this.merchants.set(MerchantOnboarding.key(input.organizationId, input.merchantId), next);

    if (this.options.openWalletOnApproval !== false) {
      // Opened here rather than at registration: a wallet before approval is a wallet that can
      // receive money for a merchant nobody has checked.
      await this.options.wallets.open({
        organizationId: input.organizationId,
        ownerId: next.merchantId,
        ownerType: 'merchant',
        currency: next.currency,
        name: next.tradingName,
        actorId: input.actorId,
      });
    }

    await this.options.audit?.record({
      action: 'mwb.merchant.approved',
      entityType: 'merchant',
      entityId: merchant.merchantId,
      actorId: input.actorId,
      organizationId: input.organizationId,
      before: { status: merchant.status, verifiedBy: merchant.verifiedBy },
      after: { status: 'approved', approvedBy: input.actorId },
      metadata: { reason: input.reason },
    });

    return next;
  }

  async reject(input: {
    organizationId: string;
    merchantId: string;
    actorId: string;
    rejection: unknown;
  }): Promise<Merchant> {
    const merchant = this.require(input.organizationId, input.merchantId);
    const rejection = rejectionSchema.parse(input.rejection);
    assertTransition(merchant.status, 'rejected');

    const next = merchantSchema.parse({
      ...merchant,
      status: 'rejected',
      statusReason: rejection.reason,
    });

    this.merchants.set(MerchantOnboarding.key(input.organizationId, input.merchantId), next);

    await this.options.audit?.record({
      action: 'mwb.merchant.rejected',
      entityType: 'merchant',
      entityId: merchant.merchantId,
      actorId: input.actorId,
      organizationId: input.organizationId,
      before: { status: merchant.status },
      after: { status: 'rejected' },
      metadata: {
        reason: rejection.reason,
        reworkPermitted: rejection.reworkPermitted,
        remediation: rejection.remediation,
      },
    });

    return next;
  }

  // --- the controlled configuration change ----------------------------------

  async requestLimitChange(input: unknown, actorId: string): Promise<LimitChangeRequest> {
    const request = limitChangeRequestSchema.parse(input);

    if (request.requestedBy !== actorId) {
      throw ApiError.validation(
        [{ path: 'requestedBy', message: 'The requesting actor is recorded, not supplied.' }],
        'A request records who made it.',
      );
    }

    this.require(request.organizationId, request.merchantId);
    this.limitRequests.set(request.requestId, request);

    await this.options.audit?.record({
      action: 'mwb.limit.change_requested',
      entityType: 'limit_change_request',
      entityId: request.requestId,
      actorId,
      organizationId: request.organizationId,
      after: { limitKey: request.limitKey, requestedValue: request.requestedValue },
      metadata: { merchantId: request.merchantId, justification: request.justification },
    });

    return request;
  }

  pendingLimitChanges(organizationId: string): LimitChangeRequest[] {
    return [...this.limitRequests.values()].filter(
      (request) => request.organizationId === organizationId && request.status === 'pending',
    );
  }

  /**
   * Approving a limit change.
   *
   * Refuses the requester, and refuses a request that is not pending. The second matters as much
   * as the first: without it, a rejected request could be approved afterwards by somebody who did
   * not see the rejection.
   */
  async decideLimitChange(input: {
    requestId: string;
    decision: 'approved' | 'rejected';
    actorId: string;
    reason: string;
    organizationId: string;
  }): Promise<LimitChangeRequest> {
    const request = this.limitRequests.get(input.requestId);

    if (!request || request.organizationId !== input.organizationId) {
      throw ApiError.notFound(`No limit change request with id "${input.requestId}".`);
    }

    if (request.status !== 'pending') {
      throw ApiError.conflict(`This request is already ${request.status}.`);
    }

    if (request.requestedBy === input.actorId) {
      throw ApiError.forbidden(
        'The person who requested a limit change does not approve it. A limit is a fraud control, and one person raising their own is the control removed.',
        { reason: 'self_approval', requestId: request.requestId },
      );
    }

    const next = limitChangeRequestSchema.parse({
      ...request,
      status: input.decision,
      decidedBy: input.actorId,
      decidedAt: this.now().toISOString(),
      decisionReason: input.reason,
    });

    this.limitRequests.set(next.requestId, next);

    await this.options.audit?.record({
      action:
        input.decision === 'approved' ? 'mwb.limit.change_approved' : 'mwb.limit.change_rejected',
      entityType: 'limit_change_request',
      entityId: next.requestId,
      actorId: input.actorId,
      organizationId: input.organizationId,
      before: { value: request.currentValue },
      after: {
        value: input.decision === 'approved' ? request.requestedValue : request.currentValue,
      },
      metadata: {
        reason: input.reason,
        requestedBy: request.requestedBy,
        merchantId: request.merchantId,
      },
    });

    return next;
  }
}

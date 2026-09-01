import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Insurance domain service.
 *
 * Every read and write goes through a tenant-scoped repository, and every parent reference is
 * verified through one before a child is created. Without that second check a caller could
 * attach a record to a parent in another organization by supplying its id — the row would be
 * stamped with the caller’s organization, so no isolation test would fail, and the data would be
 * wrong in a way that is hard to unpick later.
 *
 * Writes are audited. A financial or personal-data change with no audit row is a change nobody
 * can answer questions about six months later.
 */

export interface PolicyHolderRow {
  id: string;
  organizationId: string;
  holderNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface InsuranceProductRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  category: 'LIFE' | 'HEALTH' | 'MOTOR' | 'PROPERTY' | 'TRAVEL';
  currency: string;
  basePremium: string;
  defaultSumInsured: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PolicyRow {
  id: string;
  organizationId: string;
  policyNumber: string;
  holderId: string;
  productId: string;
  sumInsured: string;
  currency: string;
  startsOn: Date;
  endsOn: Date;
  status: 'QUOTED' | 'ACTIVE' | 'LAPSED' | 'CANCELLED' | 'EXPIRED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PremiumRow {
  id: string;
  organizationId: string;
  policyId: string;
  dueOn: Date;
  amount: string;
  currency: string;
  paidAt: Date | null;
  status: 'DUE' | 'PAID' | 'OVERDUE' | 'WAIVED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ClaimRow {
  id: string;
  organizationId: string;
  claimNumber: string;
  policyId: string;
  incidentOn: Date;
  reportedAt: Date;
  claimedAmount: string;
  approvedAmount: string | null;
  currency: string;
  workflowInstanceId: string | null;
  status: 'REPORTED' | 'ASSESSING' | 'APPROVED' | 'REJECTED' | 'PAID' | 'WITHDRAWN';
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class InsuranceService {
  private readonly policyHolders: TenantRepository<PolicyHolderRow>;
  private readonly insuranceProducts: TenantRepository<InsuranceProductRow>;
  private readonly policies: TenantRepository<PolicyRow>;
  private readonly premiums: TenantRepository<PremiumRow>;
  private readonly claims: TenantRepository<ClaimRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.policyHolders = new TenantRepository<PolicyHolderRow>(prisma, 'policyHolder');
    this.insuranceProducts = new TenantRepository<InsuranceProductRow>(prisma, 'insuranceProduct');
    this.policies = new TenantRepository<PolicyRow>(prisma, 'policy');
    this.premiums = new TenantRepository<PremiumRow>(prisma, 'premium');
    this.claims = new TenantRepository<ClaimRow>(prisma, 'claim');
  }

  // --- policyholders -----------------------------------------------

  listPolicyHolders(): Promise<PolicyHolderRow[]> {
    return this.policyHolders.list();
  }

  findPolicyHolder(id: string, organizationId: string): Promise<PolicyHolderRow> {
    return this.policyHolders.findById(id, organizationId);
  }

  async createPolicyHolder(
    input: {
      holderNumber: string;
      fullName: string;
      email?: string;
      phone?: string;
      dateOfBirth?: Date;
    },
    organizationId: string,
  ): Promise<PolicyHolderRow> {
    const created = await this.policyHolders.create({
      holderNumber: input.holderNumber,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
    });

    await this.audit.record({
      action: 'insurance.policy-holder.created',
      entityType: 'PolicyHolder',
      entityId: created.id,
      organizationId,
      after: {
        holderNumber: created.holderNumber,
        fullName: created.fullName,
        email: created.email,
      },
    });

    return created;
  }

  async updatePolicyHolder(
    id: string,
    changes: {
      fullName?: string;
      email?: string;
      phone?: string;
      dateOfBirth?: Date;
    },
    organizationId: string,
  ): Promise<PolicyHolderRow> {
    const existing = await this.policyHolders.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.policyHolders.update(id, changes);

    await this.audit.recordChange({
      action: 'insurance.policy-holder.updated',
      entityType: 'PolicyHolder',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- products ----------------------------------------------------

  listInsuranceProducts(): Promise<InsuranceProductRow[]> {
    return this.insuranceProducts.list();
  }

  findInsuranceProduct(id: string, organizationId: string): Promise<InsuranceProductRow> {
    return this.insuranceProducts.findById(id, organizationId);
  }

  async createInsuranceProduct(
    input: {
      code: string;
      name: string;
      category: 'LIFE' | 'HEALTH' | 'MOTOR' | 'PROPERTY' | 'TRAVEL';
      currency: string;
      basePremium: string;
      defaultSumInsured: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<InsuranceProductRow> {
    const created = await this.insuranceProducts.create({
      code: input.code,
      name: input.name,
      category: input.category,
      currency: input.currency,
      basePremium: input.basePremium,
      defaultSumInsured: input.defaultSumInsured,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'insurance.insurance-product.created',
      entityType: 'InsuranceProduct',
      entityId: created.id,
      organizationId,
      after: { code: created.code, name: created.name, category: created.category },
    });

    return created;
  }

  async updateInsuranceProduct(
    id: string,
    changes: {
      name?: string;
      category?: 'LIFE' | 'HEALTH' | 'MOTOR' | 'PROPERTY' | 'TRAVEL';
      currency?: string;
      basePremium?: string;
      defaultSumInsured?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<InsuranceProductRow> {
    const existing = await this.insuranceProducts.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.insuranceProducts.update(id, changes);

    await this.audit.recordChange({
      action: 'insurance.insurance-product.updated',
      entityType: 'InsuranceProduct',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- policies ----------------------------------------------------

  listPolicies(): Promise<PolicyRow[]> {
    return this.policies.list();
  }

  findPolicy(id: string, organizationId: string): Promise<PolicyRow> {
    return this.policies.findById(id, organizationId);
  }

  async createPolicy(
    input: {
      policyNumber: string;
      holderId: string;
      productId: string;
      sumInsured: string;
      currency: string;
      startsOn: Date;
      endsOn: Date;
      status?: 'QUOTED' | 'ACTIVE' | 'LAPSED' | 'CANCELLED' | 'EXPIRED';
    },
    organizationId: string,
  ): Promise<PolicyRow> {
    await this.policyHolders.findById(input.holderId, organizationId);
    await this.insuranceProducts.findById(input.productId, organizationId);

    const created = await this.policies.create({
      policyNumber: input.policyNumber,
      holderId: input.holderId,
      productId: input.productId,
      sumInsured: input.sumInsured,
      currency: input.currency,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      status: input.status,
    });

    await this.audit.record({
      action: 'insurance.policy.created',
      entityType: 'Policy',
      entityId: created.id,
      organizationId,
      after: {
        policyNumber: created.policyNumber,
        holderId: created.holderId,
        productId: created.productId,
      },
    });

    return created;
  }

  async updatePolicy(
    id: string,
    changes: {
      holderId?: string;
      productId?: string;
      startsOn?: Date;
      endsOn?: Date;
      status?: 'QUOTED' | 'ACTIVE' | 'LAPSED' | 'CANCELLED' | 'EXPIRED';
    },
    organizationId: string,
  ): Promise<PolicyRow> {
    const existing = await this.policies.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.policies.update(id, changes);

    await this.audit.recordChange({
      action: 'insurance.policy.updated',
      entityType: 'Policy',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- premiums ----------------------------------------------------

  listPremiums(): Promise<PremiumRow[]> {
    return this.premiums.list();
  }

  findPremium(id: string, organizationId: string): Promise<PremiumRow> {
    return this.premiums.findById(id, organizationId);
  }

  async createPremium(
    input: {
      policyId: string;
      dueOn: Date;
      amount: string;
      currency: string;
      paidAt?: Date;
      status?: 'DUE' | 'PAID' | 'OVERDUE' | 'WAIVED';
    },
    organizationId: string,
  ): Promise<PremiumRow> {
    await this.policies.findById(input.policyId, organizationId);

    const created = await this.premiums.create({
      policyId: input.policyId,
      dueOn: input.dueOn,
      amount: input.amount,
      currency: input.currency,
      paidAt: input.paidAt ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'insurance.premium.created',
      entityType: 'Premium',
      entityId: created.id,
      organizationId,
      after: { policyId: created.policyId, dueOn: created.dueOn, amount: created.amount },
    });

    return created;
  }

  async updatePremium(
    id: string,
    changes: {
      policyId?: string;
      dueOn?: Date;
      amount?: string;
      currency?: string;
      paidAt?: Date;
      status?: 'DUE' | 'PAID' | 'OVERDUE' | 'WAIVED';
    },
    organizationId: string,
  ): Promise<PremiumRow> {
    const existing = await this.premiums.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.premiums.update(id, changes);

    await this.audit.recordChange({
      action: 'insurance.premium.updated',
      entityType: 'Premium',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- claims ------------------------------------------------------

  listClaims(): Promise<ClaimRow[]> {
    return this.claims.list();
  }

  findClaim(id: string, organizationId: string): Promise<ClaimRow> {
    return this.claims.findById(id, organizationId);
  }

  async createClaim(
    input: {
      claimNumber: string;
      policyId: string;
      incidentOn: Date;
      reportedAt: Date;
      claimedAmount: string;
      approvedAmount?: string;
      currency: string;
      workflowInstanceId?: string;
      status?: 'REPORTED' | 'ASSESSING' | 'APPROVED' | 'REJECTED' | 'PAID' | 'WITHDRAWN';
      summary?: string;
    },
    organizationId: string,
  ): Promise<ClaimRow> {
    await this.policies.findById(input.policyId, organizationId);

    const created = await this.claims.create({
      claimNumber: input.claimNumber,
      policyId: input.policyId,
      incidentOn: input.incidentOn,
      reportedAt: input.reportedAt,
      claimedAmount: input.claimedAmount,
      approvedAmount: input.approvedAmount ?? null,
      currency: input.currency,
      workflowInstanceId: input.workflowInstanceId ?? null,
      status: input.status,
      summary: input.summary ?? null,
    });

    await this.audit.record({
      action: 'insurance.claim.created',
      entityType: 'Claim',
      entityId: created.id,
      organizationId,
      after: {
        claimNumber: created.claimNumber,
        policyId: created.policyId,
        incidentOn: created.incidentOn,
      },
    });

    return created;
  }

  async updateClaim(
    id: string,
    changes: {
      policyId?: string;
      incidentOn?: Date;
      reportedAt?: Date;
      claimedAmount?: string;
      approvedAmount?: string;
      currency?: string;
      workflowInstanceId?: string;
      status?: 'REPORTED' | 'ASSESSING' | 'APPROVED' | 'REJECTED' | 'PAID' | 'WITHDRAWN';
      summary?: string;
    },
    organizationId: string,
  ): Promise<ClaimRow> {
    const existing = await this.claims.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.claims.update(id, changes);

    await this.audit.recordChange({
      action: 'insurance.claim.updated',
      entityType: 'Claim',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }
}

/**
 * The changed fields only, for the audit trail.
 *
 * Recording the whole row before and after makes every audit entry look like a total rewrite and
 * buries the one field that actually moved.
 */
function pick(row: object, keys: string[]): Record<string, unknown> {
  /*
   * `object` rather than `Record<string, unknown>`: an interface with declared fields
   * has no index signature, so the constrained generic would reject every row type
   * this service defines. The cast is contained to this one line.
   */
  const source = row as Record<string, unknown>;

  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

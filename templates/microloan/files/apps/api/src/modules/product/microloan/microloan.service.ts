import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Microloan domain service.
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

export interface BorrowerRow {
  id: string;
  organizationId: string;
  borrowerNumber: string;
  fullName: string;
  phone: string | null;
  addressLine: string | null;
  status: 'ACTIVE' | 'BLOCKED' | 'CLOSED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface LoanProductRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  currency: string;
  minPrincipal: string;
  maxPrincipal: string;
  annualRate: string;
  termMonths: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface LoanApplicationRow {
  id: string;
  organizationId: string;
  reference: string;
  borrowerId: string;
  productId: string;
  requestedPrincipal: string;
  currency: string;
  purpose: string | null;
  workflowInstanceId: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface LoanAccountRow {
  id: string;
  organizationId: string;
  applicationId: string;
  borrowerId: string;
  accountNumber: string;
  principal: string;
  currency: string;
  annualRate: string;
  termMonths: number;
  disbursedAt: Date;
  status: 'ACTIVE' | 'IN_ARREARS' | 'CLOSED' | 'WRITTEN_OFF' | 'RESTRUCTURED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface RepaymentInstalmentRow {
  id: string;
  organizationId: string;
  loanId: string;
  sequence: number;
  dueDate: Date;
  principalDue: string;
  interestDue: string;
  totalDue: string;
  currency: string;
  status: 'DUE' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'WAIVED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface RepaymentRow {
  id: string;
  organizationId: string;
  loanId: string;
  reference: string;
  amount: string;
  currency: string;
  receivedAt: Date;
  journalId: string | null;
  method: 'CASH' | 'WALLET' | 'BANK_TRANSFER' | 'ADJUSTMENT';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class MicroloanService {
  private readonly borrowers: TenantRepository<BorrowerRow>;
  private readonly loanProducts: TenantRepository<LoanProductRow>;
  private readonly loanApplications: TenantRepository<LoanApplicationRow>;
  private readonly loanAccounts: TenantRepository<LoanAccountRow>;
  private readonly repaymentInstalments: TenantRepository<RepaymentInstalmentRow>;
  private readonly repayments: TenantRepository<RepaymentRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.borrowers = new TenantRepository<BorrowerRow>(prisma, 'borrower');
    this.loanProducts = new TenantRepository<LoanProductRow>(prisma, 'loanProduct');
    this.loanApplications = new TenantRepository<LoanApplicationRow>(prisma, 'loanApplication');
    this.loanAccounts = new TenantRepository<LoanAccountRow>(prisma, 'loanAccount');
    this.repaymentInstalments = new TenantRepository<RepaymentInstalmentRow>(
      prisma,
      'repaymentInstalment',
    );
    this.repayments = new TenantRepository<RepaymentRow>(prisma, 'repayment');
  }

  // --- borrowers ---------------------------------------------------

  listBorrowers(): Promise<BorrowerRow[]> {
    return this.borrowers.list();
  }

  findBorrower(id: string, organizationId: string): Promise<BorrowerRow> {
    return this.borrowers.findById(id, organizationId);
  }

  async createBorrower(
    input: {
      borrowerNumber: string;
      fullName: string;
      phone?: string;
      addressLine?: string;
      status?: 'ACTIVE' | 'BLOCKED' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<BorrowerRow> {
    const created = await this.borrowers.create({
      borrowerNumber: input.borrowerNumber,
      fullName: input.fullName,
      phone: input.phone ?? null,
      addressLine: input.addressLine ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'microloan.borrower.created',
      entityType: 'Borrower',
      entityId: created.id,
      organizationId,
      after: {
        borrowerNumber: created.borrowerNumber,
        fullName: created.fullName,
        phone: created.phone,
      },
    });

    return created;
  }

  async updateBorrower(
    id: string,
    changes: {
      fullName?: string;
      phone?: string;
      addressLine?: string;
      status?: 'ACTIVE' | 'BLOCKED' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<BorrowerRow> {
    const existing = await this.borrowers.findById(id, organizationId);

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

    const updated = await this.borrowers.update(id, changes);

    await this.audit.recordChange({
      action: 'microloan.borrower.updated',
      entityType: 'Borrower',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- loan products -----------------------------------------------

  listLoanProducts(): Promise<LoanProductRow[]> {
    return this.loanProducts.list();
  }

  findLoanProduct(id: string, organizationId: string): Promise<LoanProductRow> {
    return this.loanProducts.findById(id, organizationId);
  }

  async createLoanProduct(
    input: {
      code: string;
      name: string;
      currency: string;
      minPrincipal: string;
      maxPrincipal: string;
      annualRate: string;
      termMonths: number;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<LoanProductRow> {
    const created = await this.loanProducts.create({
      code: input.code,
      name: input.name,
      currency: input.currency,
      minPrincipal: input.minPrincipal,
      maxPrincipal: input.maxPrincipal,
      annualRate: input.annualRate,
      termMonths: input.termMonths,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'microloan.loan-product.created',
      entityType: 'LoanProduct',
      entityId: created.id,
      organizationId,
      after: { code: created.code, name: created.name, currency: created.currency },
    });

    return created;
  }

  async updateLoanProduct(
    id: string,
    changes: {
      name?: string;
      currency?: string;
      minPrincipal?: string;
      maxPrincipal?: string;
      annualRate?: string;
      termMonths?: number;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<LoanProductRow> {
    const existing = await this.loanProducts.findById(id, organizationId);

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

    const updated = await this.loanProducts.update(id, changes);

    await this.audit.recordChange({
      action: 'microloan.loan-product.updated',
      entityType: 'LoanProduct',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- applications ------------------------------------------------

  listLoanApplications(): Promise<LoanApplicationRow[]> {
    return this.loanApplications.list();
  }

  findLoanApplication(id: string, organizationId: string): Promise<LoanApplicationRow> {
    return this.loanApplications.findById(id, organizationId);
  }

  async createLoanApplication(
    input: {
      reference: string;
      borrowerId: string;
      productId: string;
      requestedPrincipal: string;
      currency: string;
      purpose?: string;
      workflowInstanceId?: string;
      status?: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
      submittedAt: Date;
    },
    organizationId: string,
  ): Promise<LoanApplicationRow> {
    await this.borrowers.findById(input.borrowerId, organizationId);
    await this.loanProducts.findById(input.productId, organizationId);

    const created = await this.loanApplications.create({
      reference: input.reference,
      borrowerId: input.borrowerId,
      productId: input.productId,
      requestedPrincipal: input.requestedPrincipal,
      currency: input.currency,
      purpose: input.purpose ?? null,
      workflowInstanceId: input.workflowInstanceId ?? null,
      status: input.status,
      submittedAt: input.submittedAt,
    });

    await this.audit.record({
      action: 'microloan.loan-application.created',
      entityType: 'LoanApplication',
      entityId: created.id,
      organizationId,
      after: {
        reference: created.reference,
        borrowerId: created.borrowerId,
        productId: created.productId,
      },
    });

    return created;
  }

  async updateLoanApplication(
    id: string,
    changes: {
      borrowerId?: string;
      productId?: string;
      requestedPrincipal?: string;
      currency?: string;
      purpose?: string;
      workflowInstanceId?: string;
      status?: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
      submittedAt?: Date;
    },
    organizationId: string,
  ): Promise<LoanApplicationRow> {
    const existing = await this.loanApplications.findById(id, organizationId);

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

    const updated = await this.loanApplications.update(id, changes);

    await this.audit.recordChange({
      action: 'microloan.loan-application.updated',
      entityType: 'LoanApplication',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- loans -------------------------------------------------------

  listLoanAccounts(): Promise<LoanAccountRow[]> {
    return this.loanAccounts.list();
  }

  findLoanAccount(id: string, organizationId: string): Promise<LoanAccountRow> {
    return this.loanAccounts.findById(id, organizationId);
  }

  async createLoanAccount(
    input: {
      applicationId: string;
      borrowerId: string;
      accountNumber: string;
      principal: string;
      currency: string;
      annualRate: string;
      termMonths: number;
      disbursedAt: Date;
      status?: 'ACTIVE' | 'IN_ARREARS' | 'CLOSED' | 'WRITTEN_OFF' | 'RESTRUCTURED';
    },
    organizationId: string,
  ): Promise<LoanAccountRow> {
    await this.loanApplications.findById(input.applicationId, organizationId);
    await this.borrowers.findById(input.borrowerId, organizationId);

    const created = await this.loanAccounts.create({
      applicationId: input.applicationId,
      borrowerId: input.borrowerId,
      accountNumber: input.accountNumber,
      principal: input.principal,
      currency: input.currency,
      annualRate: input.annualRate,
      termMonths: input.termMonths,
      disbursedAt: input.disbursedAt,
      status: input.status,
    });

    await this.audit.record({
      action: 'microloan.loan-account.created',
      entityType: 'LoanAccount',
      entityId: created.id,
      organizationId,
      after: {
        applicationId: created.applicationId,
        borrowerId: created.borrowerId,
        accountNumber: created.accountNumber,
      },
    });

    return created;
  }

  async updateLoanAccount(
    id: string,
    changes: {
      applicationId?: string;
      borrowerId?: string;
      principal?: string;
      currency?: string;
      annualRate?: string;
      termMonths?: number;
      disbursedAt?: Date;
      status?: 'ACTIVE' | 'IN_ARREARS' | 'CLOSED' | 'WRITTEN_OFF' | 'RESTRUCTURED';
    },
    organizationId: string,
  ): Promise<LoanAccountRow> {
    const existing = await this.loanAccounts.findById(id, organizationId);

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

    const updated = await this.loanAccounts.update(id, changes);

    await this.audit.recordChange({
      action: 'microloan.loan-account.updated',
      entityType: 'LoanAccount',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- instalments -------------------------------------------------

  listRepaymentInstalments(): Promise<RepaymentInstalmentRow[]> {
    return this.repaymentInstalments.list();
  }

  findRepaymentInstalment(id: string, organizationId: string): Promise<RepaymentInstalmentRow> {
    return this.repaymentInstalments.findById(id, organizationId);
  }

  async createRepaymentInstalment(
    input: {
      loanId: string;
      sequence: number;
      dueDate: Date;
      principalDue: string;
      interestDue: string;
      totalDue: string;
      currency: string;
      status?: 'DUE' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'WAIVED';
    },
    organizationId: string,
  ): Promise<RepaymentInstalmentRow> {
    await this.loanAccounts.findById(input.loanId, organizationId);

    const created = await this.repaymentInstalments.create({
      loanId: input.loanId,
      sequence: input.sequence,
      dueDate: input.dueDate,
      principalDue: input.principalDue,
      interestDue: input.interestDue,
      totalDue: input.totalDue,
      currency: input.currency,
      status: input.status,
    });

    await this.audit.record({
      action: 'microloan.repayment-instalment.created',
      entityType: 'RepaymentInstalment',
      entityId: created.id,
      organizationId,
      after: { loanId: created.loanId, sequence: created.sequence, dueDate: created.dueDate },
    });

    return created;
  }

  async updateRepaymentInstalment(
    id: string,
    changes: {
      loanId?: string;
      sequence?: number;
      dueDate?: Date;
      principalDue?: string;
      interestDue?: string;
      totalDue?: string;
      currency?: string;
      status?: 'DUE' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'WAIVED';
    },
    organizationId: string,
  ): Promise<RepaymentInstalmentRow> {
    const existing = await this.repaymentInstalments.findById(id, organizationId);

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

    const updated = await this.repaymentInstalments.update(id, changes);

    await this.audit.recordChange({
      action: 'microloan.repayment-instalment.updated',
      entityType: 'RepaymentInstalment',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- repayments --------------------------------------------------

  listRepayments(): Promise<RepaymentRow[]> {
    return this.repayments.list();
  }

  findRepayment(id: string, organizationId: string): Promise<RepaymentRow> {
    return this.repayments.findById(id, organizationId);
  }

  async createRepayment(
    input: {
      loanId: string;
      reference: string;
      amount: string;
      currency: string;
      receivedAt: Date;
      journalId?: string;
      method?: 'CASH' | 'WALLET' | 'BANK_TRANSFER' | 'ADJUSTMENT';
    },
    organizationId: string,
  ): Promise<RepaymentRow> {
    await this.loanAccounts.findById(input.loanId, organizationId);

    const created = await this.repayments.create({
      loanId: input.loanId,
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      receivedAt: input.receivedAt,
      journalId: input.journalId ?? null,
      method: input.method,
    });

    await this.audit.record({
      action: 'microloan.repayment.created',
      entityType: 'Repayment',
      entityId: created.id,
      organizationId,
      after: { loanId: created.loanId, reference: created.reference, amount: created.amount },
    });

    return created;
  }

  async updateRepayment(
    id: string,
    changes: {
      loanId?: string;
      amount?: string;
      currency?: string;
      receivedAt?: Date;
      method?: 'CASH' | 'WALLET' | 'BANK_TRANSFER' | 'ADJUSTMENT';
    },
    organizationId: string,
  ): Promise<RepaymentRow> {
    const existing = await this.repayments.findById(id, organizationId);

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

    const updated = await this.repayments.update(id, changes);

    await this.audit.recordChange({
      action: 'microloan.repayment.updated',
      entityType: 'Repayment',
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

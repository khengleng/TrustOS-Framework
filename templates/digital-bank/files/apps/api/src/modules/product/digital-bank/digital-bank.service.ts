import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Digital Bank domain service.
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

export interface BankCustomerRow {
  id: string;
  organizationId: string;
  customerNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  segment: 'RETAIL' | 'SME' | 'CORPORATE';
  status: 'PENDING' | 'ACTIVE' | 'DORMANT' | 'CLOSED';
  onboardedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface BankAccountRow {
  id: string;
  organizationId: string;
  customerId: string;
  profileId: string;
  accountNumber: string;
  productName: string;
  currency: string;
  status: 'ACTIVE' | 'FROZEN' | 'DORMANT' | 'CLOSED';
  openedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AccountStatementRow {
  id: string;
  organizationId: string;
  accountId: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: string;
  closingBalance: string;
  currency: string;
  generatedAt: Date;
  status: 'GENERATED' | 'DELIVERED' | 'FAILED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CustomerNotificationPreferenceRow {
  id: string;
  organizationId: string;
  customerId: string;
  channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH';
  muted: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class DigitalBankService {
  private readonly bankCustomers: TenantRepository<BankCustomerRow>;
  private readonly bankAccounts: TenantRepository<BankAccountRow>;
  private readonly accountStatements: TenantRepository<AccountStatementRow>;
  private readonly customerNotificationPreferences: TenantRepository<CustomerNotificationPreferenceRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.bankCustomers = new TenantRepository<BankCustomerRow>(prisma, 'bankCustomer');
    this.bankAccounts = new TenantRepository<BankAccountRow>(prisma, 'bankAccount');
    this.accountStatements = new TenantRepository<AccountStatementRow>(prisma, 'accountStatement');
    this.customerNotificationPreferences = new TenantRepository<CustomerNotificationPreferenceRow>(
      prisma,
      'customerNotificationPreference',
    );
  }

  // --- customers ---------------------------------------------------

  listBankCustomers(): Promise<BankCustomerRow[]> {
    return this.bankCustomers.list();
  }

  findBankCustomer(id: string, organizationId: string): Promise<BankCustomerRow> {
    return this.bankCustomers.findById(id, organizationId);
  }

  async createBankCustomer(
    input: {
      customerNumber: string;
      fullName: string;
      email?: string;
      phone?: string;
      segment?: 'RETAIL' | 'SME' | 'CORPORATE';
      status?: 'PENDING' | 'ACTIVE' | 'DORMANT' | 'CLOSED';
      onboardedAt: Date;
    },
    organizationId: string,
  ): Promise<BankCustomerRow> {
    const created = await this.bankCustomers.create({
      customerNumber: input.customerNumber,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      segment: input.segment,
      status: input.status,
      onboardedAt: input.onboardedAt,
    });

    await this.audit.record({
      action: 'digitalbank.bank-customer.created',
      entityType: 'BankCustomer',
      entityId: created.id,
      organizationId,
      after: {
        customerNumber: created.customerNumber,
        fullName: created.fullName,
        email: created.email,
      },
    });

    return created;
  }

  async updateBankCustomer(
    id: string,
    changes: {
      fullName?: string;
      email?: string;
      phone?: string;
      segment?: 'RETAIL' | 'SME' | 'CORPORATE';
      status?: 'PENDING' | 'ACTIVE' | 'DORMANT' | 'CLOSED';
      onboardedAt?: Date;
    },
    organizationId: string,
  ): Promise<BankCustomerRow> {
    const existing = await this.bankCustomers.findById(id, organizationId);

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

    const updated = await this.bankCustomers.update(id, changes);

    await this.audit.recordChange({
      action: 'digitalbank.bank-customer.updated',
      entityType: 'BankCustomer',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- accounts ----------------------------------------------------

  listBankAccounts(): Promise<BankAccountRow[]> {
    return this.bankAccounts.list();
  }

  findBankAccount(id: string, organizationId: string): Promise<BankAccountRow> {
    return this.bankAccounts.findById(id, organizationId);
  }

  async createBankAccount(
    input: {
      customerId: string;
      profileId: string;
      accountNumber: string;
      productName: string;
      currency: string;
      status?: 'ACTIVE' | 'FROZEN' | 'DORMANT' | 'CLOSED';
      openedAt: Date;
    },
    organizationId: string,
  ): Promise<BankAccountRow> {
    await this.bankCustomers.findById(input.customerId, organizationId);

    const created = await this.bankAccounts.create({
      customerId: input.customerId,
      profileId: input.profileId,
      accountNumber: input.accountNumber,
      productName: input.productName,
      currency: input.currency,
      status: input.status,
      openedAt: input.openedAt,
    });

    await this.audit.record({
      action: 'digitalbank.bank-account.created',
      entityType: 'BankAccount',
      entityId: created.id,
      organizationId,
      after: {
        customerId: created.customerId,
        profileId: created.profileId,
        accountNumber: created.accountNumber,
      },
    });

    return created;
  }

  async updateBankAccount(
    id: string,
    changes: {
      customerId?: string;
      profileId?: string;
      productName?: string;
      status?: 'ACTIVE' | 'FROZEN' | 'DORMANT' | 'CLOSED';
      openedAt?: Date;
    },
    organizationId: string,
  ): Promise<BankAccountRow> {
    const existing = await this.bankAccounts.findById(id, organizationId);

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

    const updated = await this.bankAccounts.update(id, changes);

    await this.audit.recordChange({
      action: 'digitalbank.bank-account.updated',
      entityType: 'BankAccount',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- statements --------------------------------------------------

  listAccountStatements(): Promise<AccountStatementRow[]> {
    return this.accountStatements.list();
  }

  findAccountStatement(id: string, organizationId: string): Promise<AccountStatementRow> {
    return this.accountStatements.findById(id, organizationId);
  }

  async createAccountStatement(
    input: {
      accountId: string;
      periodStart: Date;
      periodEnd: Date;
      openingBalance: string;
      closingBalance: string;
      currency: string;
      generatedAt: Date;
      status?: 'GENERATED' | 'DELIVERED' | 'FAILED';
    },
    organizationId: string,
  ): Promise<AccountStatementRow> {
    await this.bankAccounts.findById(input.accountId, organizationId);

    const created = await this.accountStatements.create({
      accountId: input.accountId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      openingBalance: input.openingBalance,
      closingBalance: input.closingBalance,
      currency: input.currency,
      generatedAt: input.generatedAt,
      status: input.status,
    });

    await this.audit.record({
      action: 'digitalbank.account-statement.created',
      entityType: 'AccountStatement',
      entityId: created.id,
      organizationId,
      after: {
        accountId: created.accountId,
        periodStart: created.periodStart,
        periodEnd: created.periodEnd,
      },
    });

    return created;
  }

  async updateAccountStatement(
    id: string,
    changes: {
      accountId?: string;
      periodStart?: Date;
      periodEnd?: Date;
      openingBalance?: string;
      closingBalance?: string;
      currency?: string;
      generatedAt?: Date;
      status?: 'GENERATED' | 'DELIVERED' | 'FAILED';
    },
    organizationId: string,
  ): Promise<AccountStatementRow> {
    const existing = await this.accountStatements.findById(id, organizationId);

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

    const updated = await this.accountStatements.update(id, changes);

    await this.audit.recordChange({
      action: 'digitalbank.account-statement.updated',
      entityType: 'AccountStatement',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- notification preferences ------------------------------------

  listCustomerNotificationPreferences(): Promise<CustomerNotificationPreferenceRow[]> {
    return this.customerNotificationPreferences.list();
  }

  findCustomerNotificationPreference(
    id: string,
    organizationId: string,
  ): Promise<CustomerNotificationPreferenceRow> {
    return this.customerNotificationPreferences.findById(id, organizationId);
  }

  async createCustomerNotificationPreference(
    input: {
      customerId: string;
      channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH';
      muted?: boolean;
    },
    organizationId: string,
  ): Promise<CustomerNotificationPreferenceRow> {
    await this.bankCustomers.findById(input.customerId, organizationId);

    const created = await this.customerNotificationPreferences.create({
      customerId: input.customerId,
      channel: input.channel,
      muted: input.muted,
    });

    await this.audit.record({
      action: 'digitalbank.customer-notification-preference.created',
      entityType: 'CustomerNotificationPreference',
      entityId: created.id,
      organizationId,
      after: { customerId: created.customerId, channel: created.channel, muted: created.muted },
    });

    return created;
  }

  async updateCustomerNotificationPreference(
    id: string,
    changes: {
      customerId?: string;
      channel?: 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH';
      muted?: boolean;
    },
    organizationId: string,
  ): Promise<CustomerNotificationPreferenceRow> {
    const existing = await this.customerNotificationPreferences.findById(id, organizationId);

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

    const updated = await this.customerNotificationPreferences.update(id, changes);

    await this.audit.recordChange({
      action: 'digitalbank.customer-notification-preference.updated',
      entityType: 'CustomerNotificationPreference',
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

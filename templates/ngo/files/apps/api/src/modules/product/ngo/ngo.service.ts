import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS NGO domain service.
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

export interface ProgrammeRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  summary: string | null;
  status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface NgoProjectRow {
  id: string;
  organizationId: string;
  programmeId: string;
  code: string;
  name: string;
  location: string | null;
  budget: string;
  currency: string;
  startsOn: Date | null;
  endsOn: Date | null;
  status: 'PLANNED' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DonorRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  kind: 'INDIVIDUAL' | 'CORPORATE' | 'FOUNDATION' | 'GOVERNMENT' | 'MULTILATERAL';
  email: string | null;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DonationRow {
  id: string;
  organizationId: string;
  donorId: string;
  projectId: string | null;
  reference: string;
  amount: string;
  currency: string;
  receivedOn: Date;
  isRestricted: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface BeneficiaryRow {
  id: string;
  organizationId: string;
  projectId: string;
  reference: string;
  fullName: string;
  phone: string | null;
  village: string | null;
  householdSize: number;
  enrolledOn: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface FieldReportRow {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  body: string;
  reportedOn: Date;
  authorUserId: string | null;
  peopleReached: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class NgoService {
  private readonly programmes: TenantRepository<ProgrammeRow>;
  private readonly ngoProjects: TenantRepository<NgoProjectRow>;
  private readonly donors: TenantRepository<DonorRow>;
  private readonly donations: TenantRepository<DonationRow>;
  private readonly beneficiaries: TenantRepository<BeneficiaryRow>;
  private readonly fieldReports: TenantRepository<FieldReportRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.programmes = new TenantRepository<ProgrammeRow>(prisma, 'programme');
    this.ngoProjects = new TenantRepository<NgoProjectRow>(prisma, 'ngoProject');
    this.donors = new TenantRepository<DonorRow>(prisma, 'donor');
    this.donations = new TenantRepository<DonationRow>(prisma, 'donation');
    this.beneficiaries = new TenantRepository<BeneficiaryRow>(prisma, 'beneficiary');
    this.fieldReports = new TenantRepository<FieldReportRow>(prisma, 'fieldReport');
  }

  // --- programmes --------------------------------------------------

  listProgrammes(): Promise<ProgrammeRow[]> {
    return this.programmes.list();
  }

  findProgramme(id: string, organizationId: string): Promise<ProgrammeRow> {
    return this.programmes.findById(id, organizationId);
  }

  async createProgramme(
    input: {
      code: string;
      name: string;
      summary?: string;
      status?: 'PLANNED' | 'ACTIVE' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<ProgrammeRow> {
    const created = await this.programmes.create({
      code: input.code,
      name: input.name,
      summary: input.summary ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'ngo.programme.created',
      entityType: 'Programme',
      entityId: created.id,
      organizationId,
      after: { code: created.code, name: created.name, summary: created.summary },
    });

    return created;
  }

  async updateProgramme(
    id: string,
    changes: {
      name?: string;
      summary?: string;
      status?: 'PLANNED' | 'ACTIVE' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<ProgrammeRow> {
    const existing = await this.programmes.findById(id, organizationId);

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

    const updated = await this.programmes.update(id, changes);

    await this.audit.recordChange({
      action: 'ngo.programme.updated',
      entityType: 'Programme',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- projects ----------------------------------------------------

  listNgoProjects(): Promise<NgoProjectRow[]> {
    return this.ngoProjects.list();
  }

  findNgoProject(id: string, organizationId: string): Promise<NgoProjectRow> {
    return this.ngoProjects.findById(id, organizationId);
  }

  async createNgoProject(
    input: {
      programmeId: string;
      code: string;
      name: string;
      location?: string;
      budget: string;
      currency: string;
      startsOn?: Date;
      endsOn?: Date;
      status?: 'PLANNED' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED';
    },
    organizationId: string,
  ): Promise<NgoProjectRow> {
    await this.programmes.findById(input.programmeId, organizationId);

    const created = await this.ngoProjects.create({
      programmeId: input.programmeId,
      code: input.code,
      name: input.name,
      location: input.location ?? null,
      budget: input.budget,
      currency: input.currency,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'ngo.ngo-project.created',
      entityType: 'NgoProject',
      entityId: created.id,
      organizationId,
      after: { programmeId: created.programmeId, code: created.code, name: created.name },
    });

    return created;
  }

  async updateNgoProject(
    id: string,
    changes: {
      programmeId?: string;
      name?: string;
      location?: string;
      budget?: string;
      currency?: string;
      startsOn?: Date;
      endsOn?: Date;
      status?: 'PLANNED' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED';
    },
    organizationId: string,
  ): Promise<NgoProjectRow> {
    const existing = await this.ngoProjects.findById(id, organizationId);

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

    const updated = await this.ngoProjects.update(id, changes);

    await this.audit.recordChange({
      action: 'ngo.ngo-project.updated',
      entityType: 'NgoProject',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- donors ------------------------------------------------------

  listDonors(): Promise<DonorRow[]> {
    return this.donors.list();
  }

  findDonor(id: string, organizationId: string): Promise<DonorRow> {
    return this.donors.findById(id, organizationId);
  }

  async createDonor(
    input: {
      name: string;
      code: string;
      kind?: 'INDIVIDUAL' | 'CORPORATE' | 'FOUNDATION' | 'GOVERNMENT' | 'MULTILATERAL';
      email?: string;
      phone?: string;
    },
    organizationId: string,
  ): Promise<DonorRow> {
    const created = await this.donors.create({
      name: input.name,
      code: input.code,
      kind: input.kind,
      email: input.email ?? null,
      phone: input.phone ?? null,
    });

    await this.audit.record({
      action: 'ngo.donor.created',
      entityType: 'Donor',
      entityId: created.id,
      organizationId,
      after: { name: created.name, code: created.code, kind: created.kind },
    });

    return created;
  }

  async updateDonor(
    id: string,
    changes: {
      name?: string;
      kind?: 'INDIVIDUAL' | 'CORPORATE' | 'FOUNDATION' | 'GOVERNMENT' | 'MULTILATERAL';
      email?: string;
      phone?: string;
    },
    organizationId: string,
  ): Promise<DonorRow> {
    const existing = await this.donors.findById(id, organizationId);

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

    const updated = await this.donors.update(id, changes);

    await this.audit.recordChange({
      action: 'ngo.donor.updated',
      entityType: 'Donor',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- donations ---------------------------------------------------

  listDonations(): Promise<DonationRow[]> {
    return this.donations.list();
  }

  findDonation(id: string, organizationId: string): Promise<DonationRow> {
    return this.donations.findById(id, organizationId);
  }

  async createDonation(
    input: {
      donorId: string;
      projectId?: string;
      reference: string;
      amount: string;
      currency: string;
      receivedOn: Date;
      isRestricted?: boolean;
    },
    organizationId: string,
  ): Promise<DonationRow> {
    await this.donors.findById(input.donorId, organizationId);
    if (input.projectId !== undefined) {
      await this.ngoProjects.findById(input.projectId, organizationId);
    }

    const created = await this.donations.create({
      donorId: input.donorId,
      projectId: input.projectId ?? null,
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      receivedOn: input.receivedOn,
      isRestricted: input.isRestricted,
    });

    await this.audit.record({
      action: 'ngo.donation.created',
      entityType: 'Donation',
      entityId: created.id,
      organizationId,
      after: {
        donorId: created.donorId,
        projectId: created.projectId,
        reference: created.reference,
      },
    });

    return created;
  }

  async updateDonation(
    id: string,
    changes: {
      donorId?: string;
      projectId?: string;
      amount?: string;
      currency?: string;
      receivedOn?: Date;
      isRestricted?: boolean;
    },
    organizationId: string,
  ): Promise<DonationRow> {
    const existing = await this.donations.findById(id, organizationId);

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

    const updated = await this.donations.update(id, changes);

    await this.audit.recordChange({
      action: 'ngo.donation.updated',
      entityType: 'Donation',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- beneficiaries -----------------------------------------------

  listBeneficiaries(): Promise<BeneficiaryRow[]> {
    return this.beneficiaries.list();
  }

  findBeneficiary(id: string, organizationId: string): Promise<BeneficiaryRow> {
    return this.beneficiaries.findById(id, organizationId);
  }

  async createBeneficiary(
    input: {
      projectId: string;
      reference: string;
      fullName: string;
      phone?: string;
      village?: string;
      householdSize?: number;
      enrolledOn: Date;
    },
    organizationId: string,
  ): Promise<BeneficiaryRow> {
    await this.ngoProjects.findById(input.projectId, organizationId);

    const created = await this.beneficiaries.create({
      projectId: input.projectId,
      reference: input.reference,
      fullName: input.fullName,
      phone: input.phone ?? null,
      village: input.village ?? null,
      householdSize: input.householdSize,
      enrolledOn: input.enrolledOn,
    });

    await this.audit.record({
      action: 'ngo.beneficiary.created',
      entityType: 'Beneficiary',
      entityId: created.id,
      organizationId,
      after: {
        projectId: created.projectId,
        reference: created.reference,
        village: created.village,
      },
    });

    return created;
  }

  async updateBeneficiary(
    id: string,
    changes: {
      projectId?: string;
      fullName?: string;
      phone?: string;
      village?: string;
      householdSize?: number;
      enrolledOn?: Date;
    },
    organizationId: string,
  ): Promise<BeneficiaryRow> {
    const existing = await this.beneficiaries.findById(id, organizationId);

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

    const updated = await this.beneficiaries.update(id, changes);

    await this.audit.recordChange({
      action: 'ngo.beneficiary.updated',
      entityType: 'Beneficiary',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- field reports -----------------------------------------------

  listFieldReports(): Promise<FieldReportRow[]> {
    return this.fieldReports.list();
  }

  findFieldReport(id: string, organizationId: string): Promise<FieldReportRow> {
    return this.fieldReports.findById(id, organizationId);
  }

  async createFieldReport(
    input: {
      projectId: string;
      title: string;
      body: string;
      reportedOn: Date;
      authorUserId?: string;
      peopleReached?: number;
    },
    organizationId: string,
  ): Promise<FieldReportRow> {
    await this.ngoProjects.findById(input.projectId, organizationId);

    const created = await this.fieldReports.create({
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      reportedOn: input.reportedOn,
      authorUserId: input.authorUserId ?? null,
      peopleReached: input.peopleReached,
    });

    await this.audit.record({
      action: 'ngo.field-report.created',
      entityType: 'FieldReport',
      entityId: created.id,
      organizationId,
      after: { projectId: created.projectId, title: created.title, body: created.body },
    });

    return created;
  }

  async updateFieldReport(
    id: string,
    changes: {
      projectId?: string;
      title?: string;
      body?: string;
      reportedOn?: Date;
      authorUserId?: string;
      peopleReached?: number;
    },
    organizationId: string,
  ): Promise<FieldReportRow> {
    const existing = await this.fieldReports.findById(id, organizationId);

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

    const updated = await this.fieldReports.update(id, changes);

    await this.audit.recordChange({
      action: 'ngo.field-report.updated',
      entityType: 'FieldReport',
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

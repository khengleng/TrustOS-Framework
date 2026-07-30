import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Hospital domain service.
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

export interface HospitalDepartmentRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  headPractitionerId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface WardRow {
  id: string;
  organizationId: string;
  departmentId: string;
  name: string;
  code: string;
  bedCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface BedRow {
  id: string;
  organizationId: string;
  wardId: string;
  label: string;
  status: 'AVAILABLE' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AdmissionRow {
  id: string;
  organizationId: string;
  patientId: string;
  bedId: string;
  admittingPractitionerId: string;
  reference: string;
  admittedAt: Date;
  dischargedAt: Date | null;
  status: 'ADMITTED' | 'TRANSFERRED' | 'DISCHARGED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class HospitalService {
  private readonly hospitalDepartments: TenantRepository<HospitalDepartmentRow>;
  private readonly wards: TenantRepository<WardRow>;
  private readonly beds: TenantRepository<BedRow>;
  private readonly admissions: TenantRepository<AdmissionRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.hospitalDepartments = new TenantRepository<HospitalDepartmentRow>(
      prisma,
      'hospitalDepartment',
    );
    this.wards = new TenantRepository<WardRow>(prisma, 'ward');
    this.beds = new TenantRepository<BedRow>(prisma, 'bed');
    this.admissions = new TenantRepository<AdmissionRow>(prisma, 'admission');
  }

  // --- departments -------------------------------------------------

  listHospitalDepartments(): Promise<HospitalDepartmentRow[]> {
    return this.hospitalDepartments.list();
  }

  findHospitalDepartment(id: string, organizationId: string): Promise<HospitalDepartmentRow> {
    return this.hospitalDepartments.findById(id, organizationId);
  }

  async createHospitalDepartment(
    input: {
      name: string;
      code: string;
      headPractitionerId?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<HospitalDepartmentRow> {
    const created = await this.hospitalDepartments.create({
      name: input.name,
      code: input.code,
      headPractitionerId: input.headPractitionerId ?? null,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'hospital.hospital-department.created',
      entityType: 'HospitalDepartment',
      entityId: created.id,
      organizationId,
      after: {
        name: created.name,
        code: created.code,
        headPractitionerId: created.headPractitionerId,
      },
    });

    return created;
  }

  async updateHospitalDepartment(
    id: string,
    changes: {
      name?: string;
      headPractitionerId?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<HospitalDepartmentRow> {
    const existing = await this.hospitalDepartments.findById(id, organizationId);

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

    const updated = await this.hospitalDepartments.update(id, changes);

    await this.audit.recordChange({
      action: 'hospital.hospital-department.updated',
      entityType: 'HospitalDepartment',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- wards -------------------------------------------------------

  listWards(): Promise<WardRow[]> {
    return this.wards.list();
  }

  findWard(id: string, organizationId: string): Promise<WardRow> {
    return this.wards.findById(id, organizationId);
  }

  async createWard(
    input: {
      departmentId: string;
      name: string;
      code: string;
      bedCount: number;
    },
    organizationId: string,
  ): Promise<WardRow> {
    await this.hospitalDepartments.findById(input.departmentId, organizationId);

    const created = await this.wards.create({
      departmentId: input.departmentId,
      name: input.name,
      code: input.code,
      bedCount: input.bedCount,
    });

    await this.audit.record({
      action: 'hospital.ward.created',
      entityType: 'Ward',
      entityId: created.id,
      organizationId,
      after: { departmentId: created.departmentId, name: created.name, code: created.code },
    });

    return created;
  }

  async updateWard(
    id: string,
    changes: {
      departmentId?: string;
      name?: string;
      bedCount?: number;
    },
    organizationId: string,
  ): Promise<WardRow> {
    const existing = await this.wards.findById(id, organizationId);

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

    const updated = await this.wards.update(id, changes);

    await this.audit.recordChange({
      action: 'hospital.ward.updated',
      entityType: 'Ward',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- beds --------------------------------------------------------

  listBeds(): Promise<BedRow[]> {
    return this.beds.list();
  }

  findBed(id: string, organizationId: string): Promise<BedRow> {
    return this.beds.findById(id, organizationId);
  }

  async createBed(
    input: {
      wardId: string;
      label: string;
      status?: 'AVAILABLE' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';
    },
    organizationId: string,
  ): Promise<BedRow> {
    await this.wards.findById(input.wardId, organizationId);

    const created = await this.beds.create({
      wardId: input.wardId,
      label: input.label,
      status: input.status,
    });

    await this.audit.record({
      action: 'hospital.bed.created',
      entityType: 'Bed',
      entityId: created.id,
      organizationId,
      after: { wardId: created.wardId, label: created.label, status: created.status },
    });

    return created;
  }

  async updateBed(
    id: string,
    changes: {
      wardId?: string;
      label?: string;
      status?: 'AVAILABLE' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';
    },
    organizationId: string,
  ): Promise<BedRow> {
    const existing = await this.beds.findById(id, organizationId);

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

    const updated = await this.beds.update(id, changes);

    await this.audit.recordChange({
      action: 'hospital.bed.updated',
      entityType: 'Bed',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- admissions --------------------------------------------------

  listAdmissions(): Promise<AdmissionRow[]> {
    return this.admissions.list();
  }

  findAdmission(id: string, organizationId: string): Promise<AdmissionRow> {
    return this.admissions.findById(id, organizationId);
  }

  async createAdmission(
    input: {
      patientId: string;
      bedId: string;
      admittingPractitionerId: string;
      reference: string;
      admittedAt: Date;
      dischargedAt?: Date;
      status?: 'ADMITTED' | 'TRANSFERRED' | 'DISCHARGED';
    },
    organizationId: string,
  ): Promise<AdmissionRow> {
    await this.beds.findById(input.bedId, organizationId);

    const created = await this.admissions.create({
      patientId: input.patientId,
      bedId: input.bedId,
      admittingPractitionerId: input.admittingPractitionerId,
      reference: input.reference,
      admittedAt: input.admittedAt,
      dischargedAt: input.dischargedAt ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'hospital.admission.created',
      entityType: 'Admission',
      entityId: created.id,
      organizationId,
      after: {
        patientId: created.patientId,
        bedId: created.bedId,
        admittingPractitionerId: created.admittingPractitionerId,
      },
    });

    return created;
  }

  async updateAdmission(
    id: string,
    changes: {
      patientId?: string;
      bedId?: string;
      admittingPractitionerId?: string;
      admittedAt?: Date;
      dischargedAt?: Date;
      status?: 'ADMITTED' | 'TRANSFERRED' | 'DISCHARGED';
    },
    organizationId: string,
  ): Promise<AdmissionRow> {
    const existing = await this.admissions.findById(id, organizationId);

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

    const updated = await this.admissions.update(id, changes);

    await this.audit.recordChange({
      action: 'hospital.admission.updated',
      entityType: 'Admission',
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

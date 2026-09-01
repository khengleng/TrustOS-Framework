import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Government Services domain service.
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

export interface CitizenRow {
  id: string;
  organizationId: string;
  citizenNumber: string;
  fullName: string;
  nationalIdRef: string | null;
  dateOfBirth: Date | null;
  phone: string | null;
  addressLine: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface GovernmentServiceRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  workflowDefinitionId: string | null;
  processingDays: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ServiceApplicationRow {
  id: string;
  organizationId: string;
  reference: string;
  citizenId: string;
  serviceId: string;
  submittedAt: Date;
  payload: Record<string, unknown> | null;
  workflowInstanceId: string | null;
  status:
    | 'DRAFT'
    | 'SUBMITTED'
    | 'IN_REVIEW'
    | 'INFORMATION_REQUESTED'
    | 'APPROVED'
    | 'REJECTED'
    | 'WITHDRAWN';
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ServiceAppointmentRow {
  id: string;
  organizationId: string;
  applicationId: string | null;
  citizenId: string;
  office: string;
  scheduledFor: Date;
  status: 'BOOKED' | 'ATTENDED' | 'MISSED' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PublicNoticeRow {
  id: string;
  organizationId: string;
  title: string;
  body: string;
  publishedAt: Date | null;
  expiresAt: Date | null;
  audience: 'PUBLIC' | 'REGISTERED' | 'INTERNAL';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class GovernmentService {
  private readonly citizens: TenantRepository<CitizenRow>;
  private readonly governmentServices: TenantRepository<GovernmentServiceRow>;
  private readonly serviceApplications: TenantRepository<ServiceApplicationRow>;
  private readonly serviceAppointments: TenantRepository<ServiceAppointmentRow>;
  private readonly publicNotices: TenantRepository<PublicNoticeRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.citizens = new TenantRepository<CitizenRow>(prisma, 'citizen');
    this.governmentServices = new TenantRepository<GovernmentServiceRow>(
      prisma,
      'governmentService',
    );
    this.serviceApplications = new TenantRepository<ServiceApplicationRow>(
      prisma,
      'serviceApplication',
    );
    this.serviceAppointments = new TenantRepository<ServiceAppointmentRow>(
      prisma,
      'serviceAppointment',
    );
    this.publicNotices = new TenantRepository<PublicNoticeRow>(prisma, 'publicNotice');
  }

  // --- citizens ----------------------------------------------------

  listCitizens(): Promise<CitizenRow[]> {
    return this.citizens.list();
  }

  findCitizen(id: string, organizationId: string): Promise<CitizenRow> {
    return this.citizens.findById(id, organizationId);
  }

  async createCitizen(
    input: {
      citizenNumber: string;
      fullName: string;
      nationalIdRef?: string;
      dateOfBirth?: Date;
      phone?: string;
      addressLine?: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
    },
    organizationId: string,
  ): Promise<CitizenRow> {
    const created = await this.citizens.create({
      citizenNumber: input.citizenNumber,
      fullName: input.fullName,
      nationalIdRef: input.nationalIdRef ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      phone: input.phone ?? null,
      addressLine: input.addressLine ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'government.citizen.created',
      entityType: 'Citizen',
      entityId: created.id,
      organizationId,
      after: {
        citizenNumber: created.citizenNumber,
        fullName: created.fullName,
        status: created.status,
      },
    });

    return created;
  }

  async updateCitizen(
    id: string,
    changes: {
      fullName?: string;
      nationalIdRef?: string;
      dateOfBirth?: Date;
      phone?: string;
      addressLine?: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
    },
    organizationId: string,
  ): Promise<CitizenRow> {
    const existing = await this.citizens.findById(id, organizationId);

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

    const updated = await this.citizens.update(id, changes);

    await this.audit.recordChange({
      action: 'government.citizen.updated',
      entityType: 'Citizen',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- services ----------------------------------------------------

  listGovernmentServices(): Promise<GovernmentServiceRow[]> {
    return this.governmentServices.list();
  }

  findGovernmentService(id: string, organizationId: string): Promise<GovernmentServiceRow> {
    return this.governmentServices.findById(id, organizationId);
  }

  async createGovernmentService(
    input: {
      code: string;
      name: string;
      description?: string;
      workflowDefinitionId?: string;
      processingDays?: number;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<GovernmentServiceRow> {
    const created = await this.governmentServices.create({
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      workflowDefinitionId: input.workflowDefinitionId ?? null,
      processingDays: input.processingDays,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'government.government-service.created',
      entityType: 'GovernmentService',
      entityId: created.id,
      organizationId,
      after: { code: created.code, name: created.name, description: created.description },
    });

    return created;
  }

  async updateGovernmentService(
    id: string,
    changes: {
      name?: string;
      description?: string;
      workflowDefinitionId?: string;
      processingDays?: number;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<GovernmentServiceRow> {
    const existing = await this.governmentServices.findById(id, organizationId);

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

    const updated = await this.governmentServices.update(id, changes);

    await this.audit.recordChange({
      action: 'government.government-service.updated',
      entityType: 'GovernmentService',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- applications ------------------------------------------------

  listServiceApplications(): Promise<ServiceApplicationRow[]> {
    return this.serviceApplications.list();
  }

  findServiceApplication(id: string, organizationId: string): Promise<ServiceApplicationRow> {
    return this.serviceApplications.findById(id, organizationId);
  }

  async createServiceApplication(
    input: {
      reference: string;
      citizenId: string;
      serviceId: string;
      submittedAt: Date;
      payload?: Record<string, unknown>;
      workflowInstanceId?: string;
      status?:
        | 'DRAFT'
        | 'SUBMITTED'
        | 'IN_REVIEW'
        | 'INFORMATION_REQUESTED'
        | 'APPROVED'
        | 'REJECTED'
        | 'WITHDRAWN';
      decidedAt?: Date;
    },
    organizationId: string,
  ): Promise<ServiceApplicationRow> {
    await this.citizens.findById(input.citizenId, organizationId);
    await this.governmentServices.findById(input.serviceId, organizationId);

    const created = await this.serviceApplications.create({
      reference: input.reference,
      citizenId: input.citizenId,
      serviceId: input.serviceId,
      submittedAt: input.submittedAt,
      payload: input.payload ?? null,
      workflowInstanceId: input.workflowInstanceId ?? null,
      status: input.status,
      decidedAt: input.decidedAt ?? null,
    });

    await this.audit.record({
      action: 'government.service-application.created',
      entityType: 'ServiceApplication',
      entityId: created.id,
      organizationId,
      after: {
        reference: created.reference,
        citizenId: created.citizenId,
        serviceId: created.serviceId,
      },
    });

    return created;
  }

  async updateServiceApplication(
    id: string,
    changes: {
      citizenId?: string;
      serviceId?: string;
      submittedAt?: Date;
      payload?: Record<string, unknown>;
      workflowInstanceId?: string;
      status?:
        | 'DRAFT'
        | 'SUBMITTED'
        | 'IN_REVIEW'
        | 'INFORMATION_REQUESTED'
        | 'APPROVED'
        | 'REJECTED'
        | 'WITHDRAWN';
      decidedAt?: Date;
    },
    organizationId: string,
  ): Promise<ServiceApplicationRow> {
    const existing = await this.serviceApplications.findById(id, organizationId);

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

    const updated = await this.serviceApplications.update(id, changes);

    await this.audit.recordChange({
      action: 'government.service-application.updated',
      entityType: 'ServiceApplication',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- appointments ------------------------------------------------

  listServiceAppointments(): Promise<ServiceAppointmentRow[]> {
    return this.serviceAppointments.list();
  }

  findServiceAppointment(id: string, organizationId: string): Promise<ServiceAppointmentRow> {
    return this.serviceAppointments.findById(id, organizationId);
  }

  async createServiceAppointment(
    input: {
      applicationId?: string;
      citizenId: string;
      office: string;
      scheduledFor: Date;
      status?: 'BOOKED' | 'ATTENDED' | 'MISSED' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<ServiceAppointmentRow> {
    if (input.applicationId !== undefined) {
      await this.serviceApplications.findById(input.applicationId, organizationId);
    }
    await this.citizens.findById(input.citizenId, organizationId);

    const created = await this.serviceAppointments.create({
      applicationId: input.applicationId ?? null,
      citizenId: input.citizenId,
      office: input.office,
      scheduledFor: input.scheduledFor,
      status: input.status,
    });

    await this.audit.record({
      action: 'government.service-appointment.created',
      entityType: 'ServiceAppointment',
      entityId: created.id,
      organizationId,
      after: {
        applicationId: created.applicationId,
        citizenId: created.citizenId,
        office: created.office,
      },
    });

    return created;
  }

  async updateServiceAppointment(
    id: string,
    changes: {
      applicationId?: string;
      citizenId?: string;
      office?: string;
      scheduledFor?: Date;
      status?: 'BOOKED' | 'ATTENDED' | 'MISSED' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<ServiceAppointmentRow> {
    const existing = await this.serviceAppointments.findById(id, organizationId);

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

    const updated = await this.serviceAppointments.update(id, changes);

    await this.audit.recordChange({
      action: 'government.service-appointment.updated',
      entityType: 'ServiceAppointment',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- notices -----------------------------------------------------

  listPublicNotices(): Promise<PublicNoticeRow[]> {
    return this.publicNotices.list();
  }

  findPublicNotice(id: string, organizationId: string): Promise<PublicNoticeRow> {
    return this.publicNotices.findById(id, organizationId);
  }

  async createPublicNotice(
    input: {
      title: string;
      body: string;
      publishedAt?: Date;
      expiresAt?: Date;
      audience?: 'PUBLIC' | 'REGISTERED' | 'INTERNAL';
    },
    organizationId: string,
  ): Promise<PublicNoticeRow> {
    const created = await this.publicNotices.create({
      title: input.title,
      body: input.body,
      publishedAt: input.publishedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      audience: input.audience,
    });

    await this.audit.record({
      action: 'government.public-notice.created',
      entityType: 'PublicNotice',
      entityId: created.id,
      organizationId,
      after: { title: created.title, body: created.body, publishedAt: created.publishedAt },
    });

    return created;
  }

  async updatePublicNotice(
    id: string,
    changes: {
      title?: string;
      body?: string;
      publishedAt?: Date;
      expiresAt?: Date;
      audience?: 'PUBLIC' | 'REGISTERED' | 'INTERNAL';
    },
    organizationId: string,
  ): Promise<PublicNoticeRow> {
    const existing = await this.publicNotices.findById(id, organizationId);

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

    const updated = await this.publicNotices.update(id, changes);

    await this.audit.recordChange({
      action: 'government.public-notice.updated',
      entityType: 'PublicNotice',
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

import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Clinic domain service.
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

export interface PatientRow {
  id: string;
  organizationId: string;
  patientNumber: string;
  fullName: string;
  dateOfBirth: Date | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED' | null;
  phone: string | null;
  addressLine: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PractitionerRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  speciality: string | null;
  licenceNumber: string | null;
  isAcceptingPatients: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AppointmentRow {
  id: string;
  organizationId: string;
  patientId: string;
  practitionerId: string;
  reference: string;
  scheduledFor: Date;
  durationMinutes: number;
  reason: string | null;
  status: 'BOOKED' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MedicalRecordEntryRow {
  id: string;
  organizationId: string;
  patientId: string;
  appointmentId: string | null;
  authorPractitionerId: string;
  kind: 'CONSULTATION' | 'OBSERVATION' | 'PRESCRIPTION' | 'REFERRAL' | 'ATTACHMENT';
  body: string;
  recordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ClinicInvoiceRow {
  id: string;
  organizationId: string;
  patientId: string;
  appointmentId: string | null;
  number: string;
  issuedAt: Date;
  total: string;
  currency: string;
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class ClinicService {
  private readonly patients: TenantRepository<PatientRow>;
  private readonly practitioners: TenantRepository<PractitionerRow>;
  private readonly appointments: TenantRepository<AppointmentRow>;
  private readonly medicalRecordEntries: TenantRepository<MedicalRecordEntryRow>;
  private readonly clinicInvoices: TenantRepository<ClinicInvoiceRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.patients = new TenantRepository<PatientRow>(prisma, 'patient');
    this.practitioners = new TenantRepository<PractitionerRow>(prisma, 'practitioner');
    this.appointments = new TenantRepository<AppointmentRow>(prisma, 'appointment');
    this.medicalRecordEntries = new TenantRepository<MedicalRecordEntryRow>(
      prisma,
      'medicalRecordEntry',
    );
    this.clinicInvoices = new TenantRepository<ClinicInvoiceRow>(prisma, 'clinicInvoice');
  }

  // --- patients ----------------------------------------------------

  listPatients(): Promise<PatientRow[]> {
    return this.patients.list();
  }

  findPatient(id: string, organizationId: string): Promise<PatientRow> {
    return this.patients.findById(id, organizationId);
  }

  async createPatient(
    input: {
      patientNumber: string;
      fullName: string;
      dateOfBirth?: Date;
      sex?: 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED';
      phone?: string;
      addressLine?: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
    },
    organizationId: string,
  ): Promise<PatientRow> {
    const created = await this.patients.create({
      patientNumber: input.patientNumber,
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth ?? null,
      sex: input.sex ?? null,
      phone: input.phone ?? null,
      addressLine: input.addressLine ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'clinic.patient.created',
      entityType: 'Patient',
      entityId: created.id,
      organizationId,
      after: { patientNumber: created.patientNumber, fullName: created.fullName, sex: created.sex },
    });

    return created;
  }

  async updatePatient(
    id: string,
    changes: {
      fullName?: string;
      dateOfBirth?: Date;
      sex?: 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED';
      phone?: string;
      addressLine?: string;
      status?: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
    },
    organizationId: string,
  ): Promise<PatientRow> {
    const existing = await this.patients.findById(id, organizationId);

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

    const updated = await this.patients.update(id, changes);

    await this.audit.recordChange({
      action: 'clinic.patient.updated',
      entityType: 'Patient',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- doctors -----------------------------------------------------

  listPractitioners(): Promise<PractitionerRow[]> {
    return this.practitioners.list();
  }

  findPractitioner(id: string, organizationId: string): Promise<PractitionerRow> {
    return this.practitioners.findById(id, organizationId);
  }

  async createPractitioner(
    input: {
      userId: string;
      displayName: string;
      speciality?: string;
      licenceNumber?: string;
      isAcceptingPatients?: boolean;
    },
    organizationId: string,
  ): Promise<PractitionerRow> {
    const created = await this.practitioners.create({
      userId: input.userId,
      displayName: input.displayName,
      speciality: input.speciality ?? null,
      licenceNumber: input.licenceNumber ?? null,
      isAcceptingPatients: input.isAcceptingPatients,
    });

    await this.audit.record({
      action: 'clinic.practitioner.created',
      entityType: 'Practitioner',
      entityId: created.id,
      organizationId,
      after: {
        userId: created.userId,
        displayName: created.displayName,
        speciality: created.speciality,
      },
    });

    return created;
  }

  async updatePractitioner(
    id: string,
    changes: {
      userId?: string;
      displayName?: string;
      speciality?: string;
      licenceNumber?: string;
      isAcceptingPatients?: boolean;
    },
    organizationId: string,
  ): Promise<PractitionerRow> {
    const existing = await this.practitioners.findById(id, organizationId);

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

    const updated = await this.practitioners.update(id, changes);

    await this.audit.recordChange({
      action: 'clinic.practitioner.updated',
      entityType: 'Practitioner',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- appointments ------------------------------------------------

  listAppointments(): Promise<AppointmentRow[]> {
    return this.appointments.list();
  }

  findAppointment(id: string, organizationId: string): Promise<AppointmentRow> {
    return this.appointments.findById(id, organizationId);
  }

  async createAppointment(
    input: {
      patientId: string;
      practitionerId: string;
      reference: string;
      scheduledFor: Date;
      durationMinutes: number;
      reason?: string;
      status?: 'BOOKED' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
    },
    organizationId: string,
  ): Promise<AppointmentRow> {
    await this.patients.findById(input.patientId, organizationId);
    await this.practitioners.findById(input.practitionerId, organizationId);

    const created = await this.appointments.create({
      patientId: input.patientId,
      practitionerId: input.practitionerId,
      reference: input.reference,
      scheduledFor: input.scheduledFor,
      durationMinutes: input.durationMinutes,
      reason: input.reason ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'clinic.appointment.created',
      entityType: 'Appointment',
      entityId: created.id,
      organizationId,
      after: {
        patientId: created.patientId,
        practitionerId: created.practitionerId,
        reference: created.reference,
      },
    });

    return created;
  }

  async updateAppointment(
    id: string,
    changes: {
      patientId?: string;
      practitionerId?: string;
      scheduledFor?: Date;
      durationMinutes?: number;
      reason?: string;
      status?: 'BOOKED' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
    },
    organizationId: string,
  ): Promise<AppointmentRow> {
    const existing = await this.appointments.findById(id, organizationId);

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

    const updated = await this.appointments.update(id, changes);

    await this.audit.recordChange({
      action: 'clinic.appointment.updated',
      entityType: 'Appointment',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- medical records ---------------------------------------------

  listMedicalRecordEntries(): Promise<MedicalRecordEntryRow[]> {
    return this.medicalRecordEntries.list();
  }

  findMedicalRecordEntry(id: string, organizationId: string): Promise<MedicalRecordEntryRow> {
    return this.medicalRecordEntries.findById(id, organizationId);
  }

  async createMedicalRecordEntry(
    input: {
      patientId: string;
      appointmentId?: string;
      authorPractitionerId: string;
      kind: 'CONSULTATION' | 'OBSERVATION' | 'PRESCRIPTION' | 'REFERRAL' | 'ATTACHMENT';
      body: string;
      recordedAt: Date;
    },
    organizationId: string,
  ): Promise<MedicalRecordEntryRow> {
    await this.patients.findById(input.patientId, organizationId);
    if (input.appointmentId !== undefined) {
      await this.appointments.findById(input.appointmentId, organizationId);
    }
    await this.practitioners.findById(input.authorPractitionerId, organizationId);

    const created = await this.medicalRecordEntries.create({
      patientId: input.patientId,
      appointmentId: input.appointmentId ?? null,
      authorPractitionerId: input.authorPractitionerId,
      kind: input.kind,
      body: input.body,
      recordedAt: input.recordedAt,
    });

    await this.audit.record({
      action: 'clinic.medical-record-entry.created',
      entityType: 'MedicalRecordEntry',
      entityId: created.id,
      organizationId,
      after: {
        patientId: created.patientId,
        appointmentId: created.appointmentId,
        authorPractitionerId: created.authorPractitionerId,
      },
    });

    return created;
  }

  async updateMedicalRecordEntry(
    id: string,
    changes: {
      patientId?: string;
      appointmentId?: string;
      authorPractitionerId?: string;
      kind?: 'CONSULTATION' | 'OBSERVATION' | 'PRESCRIPTION' | 'REFERRAL' | 'ATTACHMENT';
      body?: string;
      recordedAt?: Date;
    },
    organizationId: string,
  ): Promise<MedicalRecordEntryRow> {
    const existing = await this.medicalRecordEntries.findById(id, organizationId);

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

    const updated = await this.medicalRecordEntries.update(id, changes);

    await this.audit.recordChange({
      action: 'clinic.medical-record-entry.updated',
      entityType: 'MedicalRecordEntry',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- invoices ----------------------------------------------------

  listClinicInvoices(): Promise<ClinicInvoiceRow[]> {
    return this.clinicInvoices.list();
  }

  findClinicInvoice(id: string, organizationId: string): Promise<ClinicInvoiceRow> {
    return this.clinicInvoices.findById(id, organizationId);
  }

  async createClinicInvoice(
    input: {
      patientId: string;
      appointmentId?: string;
      number: string;
      issuedAt: Date;
      total: string;
      currency: string;
      status?: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
    },
    organizationId: string,
  ): Promise<ClinicInvoiceRow> {
    await this.patients.findById(input.patientId, organizationId);
    if (input.appointmentId !== undefined) {
      await this.appointments.findById(input.appointmentId, organizationId);
    }

    const created = await this.clinicInvoices.create({
      patientId: input.patientId,
      appointmentId: input.appointmentId ?? null,
      number: input.number,
      issuedAt: input.issuedAt,
      total: input.total,
      currency: input.currency,
      status: input.status,
    });

    await this.audit.record({
      action: 'clinic.clinic-invoice.created',
      entityType: 'ClinicInvoice',
      entityId: created.id,
      organizationId,
      after: {
        patientId: created.patientId,
        appointmentId: created.appointmentId,
        number: created.number,
      },
    });

    return created;
  }

  async updateClinicInvoice(
    id: string,
    changes: {
      patientId?: string;
      appointmentId?: string;
      issuedAt?: Date;
      total?: string;
      currency?: string;
      status?: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
    },
    organizationId: string,
  ): Promise<ClinicInvoiceRow> {
    const existing = await this.clinicInvoices.findById(id, organizationId);

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

    const updated = await this.clinicInvoices.update(id, changes);

    await this.audit.recordChange({
      action: 'clinic.clinic-invoice.updated',
      entityType: 'ClinicInvoice',
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

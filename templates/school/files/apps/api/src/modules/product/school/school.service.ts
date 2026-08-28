import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS School domain service.
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

export interface AcademicTermRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  startsOn: Date;
  endsOn: Date;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ClassGroupRow {
  id: string;
  organizationId: string;
  termId: string;
  courseId: string;
  teacherId: string;
  name: string;
  room: string | null;
  capacity: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AttendanceRow {
  id: string;
  organizationId: string;
  classGroupId: string;
  studentId: string;
  sessionOn: Date;
  period: number;
  state: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface GradeRow {
  id: string;
  organizationId: string;
  classGroupId: string;
  studentId: string;
  component: string;
  marksAwarded: number;
  maxMarks: number;
  recordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface GuardianRow {
  id: string;
  organizationId: string;
  studentId: string;
  fullName: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  isPrimaryContact: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class SchoolService {
  private readonly academicTerms: TenantRepository<AcademicTermRow>;
  private readonly classGroups: TenantRepository<ClassGroupRow>;
  private readonly attendances: TenantRepository<AttendanceRow>;
  private readonly grades: TenantRepository<GradeRow>;
  private readonly guardians: TenantRepository<GuardianRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.academicTerms = new TenantRepository<AcademicTermRow>(prisma, 'academicTerm');
    this.classGroups = new TenantRepository<ClassGroupRow>(prisma, 'classGroup');
    this.attendances = new TenantRepository<AttendanceRow>(prisma, 'attendance');
    this.grades = new TenantRepository<GradeRow>(prisma, 'grade');
    this.guardians = new TenantRepository<GuardianRow>(prisma, 'guardian');
  }

  // --- terms -------------------------------------------------------

  listAcademicTerms(): Promise<AcademicTermRow[]> {
    return this.academicTerms.list();
  }

  findAcademicTerm(id: string, organizationId: string): Promise<AcademicTermRow> {
    return this.academicTerms.findById(id, organizationId);
  }

  async createAcademicTerm(
    input: {
      name: string;
      code: string;
      startsOn: Date;
      endsOn: Date;
      isCurrent?: boolean;
    },
    organizationId: string,
  ): Promise<AcademicTermRow> {
    const created = await this.academicTerms.create({
      name: input.name,
      code: input.code,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      isCurrent: input.isCurrent,
    });

    await this.audit.record({
      action: 'school.academic-term.created',
      entityType: 'AcademicTerm',
      entityId: created.id,
      organizationId,
      after: { name: created.name, code: created.code, startsOn: created.startsOn },
    });

    return created;
  }

  async updateAcademicTerm(
    id: string,
    changes: {
      name?: string;
      startsOn?: Date;
      endsOn?: Date;
      isCurrent?: boolean;
    },
    organizationId: string,
  ): Promise<AcademicTermRow> {
    const existing = await this.academicTerms.findById(id, organizationId);

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

    const updated = await this.academicTerms.update(id, changes);

    await this.audit.recordChange({
      action: 'school.academic-term.updated',
      entityType: 'AcademicTerm',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- classes -----------------------------------------------------

  listClassGroups(): Promise<ClassGroupRow[]> {
    return this.classGroups.list();
  }

  findClassGroup(id: string, organizationId: string): Promise<ClassGroupRow> {
    return this.classGroups.findById(id, organizationId);
  }

  async createClassGroup(
    input: {
      termId: string;
      courseId: string;
      teacherId: string;
      name: string;
      room?: string;
      capacity?: number;
    },
    organizationId: string,
  ): Promise<ClassGroupRow> {
    await this.academicTerms.findById(input.termId, organizationId);

    const created = await this.classGroups.create({
      termId: input.termId,
      courseId: input.courseId,
      teacherId: input.teacherId,
      name: input.name,
      room: input.room ?? null,
      capacity: input.capacity,
    });

    await this.audit.record({
      action: 'school.class-group.created',
      entityType: 'ClassGroup',
      entityId: created.id,
      organizationId,
      after: { termId: created.termId, courseId: created.courseId, teacherId: created.teacherId },
    });

    return created;
  }

  async updateClassGroup(
    id: string,
    changes: {
      termId?: string;
      courseId?: string;
      teacherId?: string;
      name?: string;
      room?: string;
      capacity?: number;
    },
    organizationId: string,
  ): Promise<ClassGroupRow> {
    const existing = await this.classGroups.findById(id, organizationId);

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

    const updated = await this.classGroups.update(id, changes);

    await this.audit.recordChange({
      action: 'school.class-group.updated',
      entityType: 'ClassGroup',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- attendance --------------------------------------------------

  listAttendances(): Promise<AttendanceRow[]> {
    return this.attendances.list();
  }

  findAttendance(id: string, organizationId: string): Promise<AttendanceRow> {
    return this.attendances.findById(id, organizationId);
  }

  async createAttendance(
    input: {
      classGroupId: string;
      studentId: string;
      sessionOn: Date;
      period: number;
      state: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
      note?: string;
    },
    organizationId: string,
  ): Promise<AttendanceRow> {
    await this.classGroups.findById(input.classGroupId, organizationId);

    const created = await this.attendances.create({
      classGroupId: input.classGroupId,
      studentId: input.studentId,
      sessionOn: input.sessionOn,
      period: input.period,
      state: input.state,
      note: input.note ?? null,
    });

    await this.audit.record({
      action: 'school.attendance.created',
      entityType: 'Attendance',
      entityId: created.id,
      organizationId,
      after: {
        classGroupId: created.classGroupId,
        studentId: created.studentId,
        sessionOn: created.sessionOn,
      },
    });

    return created;
  }

  async updateAttendance(
    id: string,
    changes: {
      classGroupId?: string;
      studentId?: string;
      sessionOn?: Date;
      period?: number;
      state?: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
      note?: string;
    },
    organizationId: string,
  ): Promise<AttendanceRow> {
    const existing = await this.attendances.findById(id, organizationId);

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

    const updated = await this.attendances.update(id, changes);

    await this.audit.recordChange({
      action: 'school.attendance.updated',
      entityType: 'Attendance',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- grades ------------------------------------------------------

  listGrades(): Promise<GradeRow[]> {
    return this.grades.list();
  }

  findGrade(id: string, organizationId: string): Promise<GradeRow> {
    return this.grades.findById(id, organizationId);
  }

  async createGrade(
    input: {
      classGroupId: string;
      studentId: string;
      component: string;
      marksAwarded: number;
      maxMarks: number;
      recordedAt: Date;
    },
    organizationId: string,
  ): Promise<GradeRow> {
    await this.classGroups.findById(input.classGroupId, organizationId);

    const created = await this.grades.create({
      classGroupId: input.classGroupId,
      studentId: input.studentId,
      component: input.component,
      marksAwarded: input.marksAwarded,
      maxMarks: input.maxMarks,
      recordedAt: input.recordedAt,
    });

    await this.audit.record({
      action: 'school.grade.created',
      entityType: 'Grade',
      entityId: created.id,
      organizationId,
      after: {
        classGroupId: created.classGroupId,
        studentId: created.studentId,
        component: created.component,
      },
    });

    return created;
  }

  async updateGrade(
    id: string,
    changes: {
      classGroupId?: string;
      studentId?: string;
      component?: string;
      marksAwarded?: number;
      maxMarks?: number;
      recordedAt?: Date;
    },
    organizationId: string,
  ): Promise<GradeRow> {
    const existing = await this.grades.findById(id, organizationId);

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

    const updated = await this.grades.update(id, changes);

    await this.audit.recordChange({
      action: 'school.grade.updated',
      entityType: 'Grade',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- guardians ---------------------------------------------------

  listGuardians(): Promise<GuardianRow[]> {
    return this.guardians.list();
  }

  findGuardian(id: string, organizationId: string): Promise<GuardianRow> {
    return this.guardians.findById(id, organizationId);
  }

  async createGuardian(
    input: {
      studentId: string;
      fullName: string;
      relationship: string;
      phone?: string;
      email?: string;
      isPrimaryContact?: boolean;
    },
    organizationId: string,
  ): Promise<GuardianRow> {
    const created = await this.guardians.create({
      studentId: input.studentId,
      fullName: input.fullName,
      relationship: input.relationship,
      phone: input.phone ?? null,
      email: input.email ?? null,
      isPrimaryContact: input.isPrimaryContact,
    });

    await this.audit.record({
      action: 'school.guardian.created',
      entityType: 'Guardian',
      entityId: created.id,
      organizationId,
      after: {
        studentId: created.studentId,
        fullName: created.fullName,
        relationship: created.relationship,
      },
    });

    return created;
  }

  async updateGuardian(
    id: string,
    changes: {
      studentId?: string;
      fullName?: string;
      relationship?: string;
      phone?: string;
      email?: string;
      isPrimaryContact?: boolean;
    },
    organizationId: string,
  ): Promise<GuardianRow> {
    const existing = await this.guardians.findById(id, organizationId);

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

    const updated = await this.guardians.update(id, changes);

    await this.audit.recordChange({
      action: 'school.guardian.updated',
      entityType: 'Guardian',
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

import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Education domain service.
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

export interface TeacherRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  email: string | null;
  bio: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface StudentRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  email: string | null;
  enrolledOn: Date;
  status: 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'WITHDRAWN';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CourseRow {
  id: string;
  organizationId: string;
  code: string;
  title: string;
  summary: string | null;
  teacherId: string;
  level: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface LessonRow {
  id: string;
  organizationId: string;
  courseId: string;
  title: string;
  position: number;
  body: string | null;
  durationMinutes: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface QuizRow {
  id: string;
  organizationId: string;
  courseId: string;
  lessonId: string | null;
  title: string;
  passMarkPercent: number;
  timeLimitMinutes: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface QuizQuestionRow {
  id: string;
  organizationId: string;
  quizId: string;
  position: number;
  prompt: string;
  options: Record<string, unknown>;
  correctOption: number;
  marks: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface EnrollmentRow {
  id: string;
  organizationId: string;
  courseId: string;
  studentId: string;
  enrolledAt: Date;
  completedAt: Date | null;
  progressPercent: number;
  status: 'ACTIVE' | 'COMPLETED' | 'DROPPED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AssignmentRow {
  id: string;
  organizationId: string;
  courseId: string;
  title: string;
  instructions: string | null;
  dueAt: Date | null;
  maxMarks: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface AssignmentSubmissionRow {
  id: string;
  organizationId: string;
  assignmentId: string;
  studentId: string;
  submittedAt: Date;
  body: string | null;
  marksAwarded: number | null;
  feedback: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'MARKED' | 'RETURNED' | 'LATE';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CertificateRow {
  id: string;
  organizationId: string;
  enrollmentId: string;
  serial: string;
  issuedAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TutorSessionRow {
  id: string;
  organizationId: string;
  studentId: string;
  courseId: string | null;
  prompt: string;
  response: string | null;
  modelId: string | null;
  askedAt: Date;
  status: 'PENDING' | 'ANSWERED' | 'FAILED' | 'BLOCKED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class EducationService {
  private readonly teachers: TenantRepository<TeacherRow>;
  private readonly students: TenantRepository<StudentRow>;
  private readonly courses: TenantRepository<CourseRow>;
  private readonly lessons: TenantRepository<LessonRow>;
  private readonly quizes: TenantRepository<QuizRow>;
  private readonly quizQuestions: TenantRepository<QuizQuestionRow>;
  private readonly enrollments: TenantRepository<EnrollmentRow>;
  private readonly assignments: TenantRepository<AssignmentRow>;
  private readonly assignmentSubmissions: TenantRepository<AssignmentSubmissionRow>;
  private readonly certificates: TenantRepository<CertificateRow>;
  private readonly tutorSessions: TenantRepository<TutorSessionRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.teachers = new TenantRepository<TeacherRow>(prisma, 'teacher');
    this.students = new TenantRepository<StudentRow>(prisma, 'student');
    this.courses = new TenantRepository<CourseRow>(prisma, 'course');
    this.lessons = new TenantRepository<LessonRow>(prisma, 'lesson');
    this.quizes = new TenantRepository<QuizRow>(prisma, 'quiz');
    this.quizQuestions = new TenantRepository<QuizQuestionRow>(prisma, 'quizQuestion');
    this.enrollments = new TenantRepository<EnrollmentRow>(prisma, 'enrollment');
    this.assignments = new TenantRepository<AssignmentRow>(prisma, 'assignment');
    this.assignmentSubmissions = new TenantRepository<AssignmentSubmissionRow>(
      prisma,
      'assignmentSubmission',
    );
    this.certificates = new TenantRepository<CertificateRow>(prisma, 'certificate');
    this.tutorSessions = new TenantRepository<TutorSessionRow>(prisma, 'tutorSession');
  }

  // --- teachers ----------------------------------------------------

  listTeachers(): Promise<TeacherRow[]> {
    return this.teachers.list();
  }

  findTeacher(id: string, organizationId: string): Promise<TeacherRow> {
    return this.teachers.findById(id, organizationId);
  }

  async createTeacher(
    input: {
      userId: string;
      displayName: string;
      email?: string;
      bio?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<TeacherRow> {
    const created = await this.teachers.create({
      userId: input.userId,
      displayName: input.displayName,
      email: input.email ?? null,
      bio: input.bio ?? null,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'education.teacher.created',
      entityType: 'Teacher',
      entityId: created.id,
      organizationId,
      after: { userId: created.userId, displayName: created.displayName, email: created.email },
    });

    return created;
  }

  async updateTeacher(
    id: string,
    changes: {
      userId?: string;
      displayName?: string;
      email?: string;
      bio?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<TeacherRow> {
    const existing = await this.teachers.findById(id, organizationId);

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

    const updated = await this.teachers.update(id, changes);

    await this.audit.recordChange({
      action: 'education.teacher.updated',
      entityType: 'Teacher',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- students ----------------------------------------------------

  listStudents(): Promise<StudentRow[]> {
    return this.students.list();
  }

  findStudent(id: string, organizationId: string): Promise<StudentRow> {
    return this.students.findById(id, organizationId);
  }

  async createStudent(
    input: {
      userId: string;
      displayName: string;
      email?: string;
      enrolledOn: Date;
      status?: 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'WITHDRAWN';
    },
    organizationId: string,
  ): Promise<StudentRow> {
    const created = await this.students.create({
      userId: input.userId,
      displayName: input.displayName,
      email: input.email ?? null,
      enrolledOn: input.enrolledOn,
      status: input.status,
    });

    await this.audit.record({
      action: 'education.student.created',
      entityType: 'Student',
      entityId: created.id,
      organizationId,
      after: { userId: created.userId, displayName: created.displayName, email: created.email },
    });

    return created;
  }

  async updateStudent(
    id: string,
    changes: {
      userId?: string;
      displayName?: string;
      email?: string;
      enrolledOn?: Date;
      status?: 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'WITHDRAWN';
    },
    organizationId: string,
  ): Promise<StudentRow> {
    const existing = await this.students.findById(id, organizationId);

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

    const updated = await this.students.update(id, changes);

    await this.audit.recordChange({
      action: 'education.student.updated',
      entityType: 'Student',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- courses -----------------------------------------------------

  listCourses(): Promise<CourseRow[]> {
    return this.courses.list();
  }

  findCourse(id: string, organizationId: string): Promise<CourseRow> {
    return this.courses.findById(id, organizationId);
  }

  async createCourse(
    input: {
      code: string;
      title: string;
      summary?: string;
      teacherId: string;
      level?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
      status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    },
    organizationId: string,
  ): Promise<CourseRow> {
    await this.teachers.findById(input.teacherId, organizationId);

    const created = await this.courses.create({
      code: input.code,
      title: input.title,
      summary: input.summary ?? null,
      teacherId: input.teacherId,
      level: input.level,
      status: input.status,
    });

    await this.audit.record({
      action: 'education.course.created',
      entityType: 'Course',
      entityId: created.id,
      organizationId,
      after: { code: created.code, title: created.title, summary: created.summary },
    });

    return created;
  }

  async updateCourse(
    id: string,
    changes: {
      title?: string;
      summary?: string;
      teacherId?: string;
      level?: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
      status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
    },
    organizationId: string,
  ): Promise<CourseRow> {
    const existing = await this.courses.findById(id, organizationId);

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

    const updated = await this.courses.update(id, changes);

    await this.audit.recordChange({
      action: 'education.course.updated',
      entityType: 'Course',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- lessons -----------------------------------------------------

  listLessons(): Promise<LessonRow[]> {
    return this.lessons.list();
  }

  findLesson(id: string, organizationId: string): Promise<LessonRow> {
    return this.lessons.findById(id, organizationId);
  }

  async createLesson(
    input: {
      courseId: string;
      title: string;
      position: number;
      body?: string;
      durationMinutes?: number;
      isPublished?: boolean;
    },
    organizationId: string,
  ): Promise<LessonRow> {
    await this.courses.findById(input.courseId, organizationId);

    const created = await this.lessons.create({
      courseId: input.courseId,
      title: input.title,
      position: input.position,
      body: input.body ?? null,
      durationMinutes: input.durationMinutes,
      isPublished: input.isPublished,
    });

    await this.audit.record({
      action: 'education.lesson.created',
      entityType: 'Lesson',
      entityId: created.id,
      organizationId,
      after: { courseId: created.courseId, title: created.title, position: created.position },
    });

    return created;
  }

  async updateLesson(
    id: string,
    changes: {
      courseId?: string;
      title?: string;
      position?: number;
      body?: string;
      durationMinutes?: number;
      isPublished?: boolean;
    },
    organizationId: string,
  ): Promise<LessonRow> {
    const existing = await this.lessons.findById(id, organizationId);

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

    const updated = await this.lessons.update(id, changes);

    await this.audit.recordChange({
      action: 'education.lesson.updated',
      entityType: 'Lesson',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- quizzes -----------------------------------------------------

  listQuizes(): Promise<QuizRow[]> {
    return this.quizes.list();
  }

  findQuiz(id: string, organizationId: string): Promise<QuizRow> {
    return this.quizes.findById(id, organizationId);
  }

  async createQuiz(
    input: {
      courseId: string;
      lessonId?: string;
      title: string;
      passMarkPercent: number;
      timeLimitMinutes?: number;
      isPublished?: boolean;
    },
    organizationId: string,
  ): Promise<QuizRow> {
    await this.courses.findById(input.courseId, organizationId);
    if (input.lessonId !== undefined) {
      await this.lessons.findById(input.lessonId, organizationId);
    }

    const created = await this.quizes.create({
      courseId: input.courseId,
      lessonId: input.lessonId ?? null,
      title: input.title,
      passMarkPercent: input.passMarkPercent,
      timeLimitMinutes: input.timeLimitMinutes,
      isPublished: input.isPublished,
    });

    await this.audit.record({
      action: 'education.quiz.created',
      entityType: 'Quiz',
      entityId: created.id,
      organizationId,
      after: { courseId: created.courseId, lessonId: created.lessonId, title: created.title },
    });

    return created;
  }

  async updateQuiz(
    id: string,
    changes: {
      courseId?: string;
      lessonId?: string;
      title?: string;
      passMarkPercent?: number;
      timeLimitMinutes?: number;
      isPublished?: boolean;
    },
    organizationId: string,
  ): Promise<QuizRow> {
    const existing = await this.quizes.findById(id, organizationId);

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

    const updated = await this.quizes.update(id, changes);

    await this.audit.recordChange({
      action: 'education.quiz.updated',
      entityType: 'Quiz',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- questions ---------------------------------------------------

  listQuizQuestions(): Promise<QuizQuestionRow[]> {
    return this.quizQuestions.list();
  }

  findQuizQuestion(id: string, organizationId: string): Promise<QuizQuestionRow> {
    return this.quizQuestions.findById(id, organizationId);
  }

  async createQuizQuestion(
    input: {
      quizId: string;
      position: number;
      prompt: string;
      options: Record<string, unknown>;
      correctOption: number;
      marks: number;
    },
    organizationId: string,
  ): Promise<QuizQuestionRow> {
    await this.quizes.findById(input.quizId, organizationId);

    const created = await this.quizQuestions.create({
      quizId: input.quizId,
      position: input.position,
      prompt: input.prompt,
      options: input.options,
      correctOption: input.correctOption,
      marks: input.marks,
    });

    await this.audit.record({
      action: 'education.quiz-question.created',
      entityType: 'QuizQuestion',
      entityId: created.id,
      organizationId,
      after: { quizId: created.quizId, position: created.position, prompt: created.prompt },
    });

    return created;
  }

  async updateQuizQuestion(
    id: string,
    changes: {
      quizId?: string;
      position?: number;
      prompt?: string;
      options?: Record<string, unknown>;
      correctOption?: number;
      marks?: number;
    },
    organizationId: string,
  ): Promise<QuizQuestionRow> {
    const existing = await this.quizQuestions.findById(id, organizationId);

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

    const updated = await this.quizQuestions.update(id, changes);

    await this.audit.recordChange({
      action: 'education.quiz-question.updated',
      entityType: 'QuizQuestion',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- enrolments --------------------------------------------------

  listEnrollments(): Promise<EnrollmentRow[]> {
    return this.enrollments.list();
  }

  findEnrollment(id: string, organizationId: string): Promise<EnrollmentRow> {
    return this.enrollments.findById(id, organizationId);
  }

  async createEnrollment(
    input: {
      courseId: string;
      studentId: string;
      enrolledAt: Date;
      completedAt?: Date;
      progressPercent?: number;
      status?: 'ACTIVE' | 'COMPLETED' | 'DROPPED';
    },
    organizationId: string,
  ): Promise<EnrollmentRow> {
    await this.courses.findById(input.courseId, organizationId);
    await this.students.findById(input.studentId, organizationId);

    const created = await this.enrollments.create({
      courseId: input.courseId,
      studentId: input.studentId,
      enrolledAt: input.enrolledAt,
      completedAt: input.completedAt ?? null,
      progressPercent: input.progressPercent,
      status: input.status,
    });

    await this.audit.record({
      action: 'education.enrollment.created',
      entityType: 'Enrollment',
      entityId: created.id,
      organizationId,
      after: {
        courseId: created.courseId,
        studentId: created.studentId,
        enrolledAt: created.enrolledAt,
      },
    });

    return created;
  }

  async updateEnrollment(
    id: string,
    changes: {
      courseId?: string;
      studentId?: string;
      enrolledAt?: Date;
      completedAt?: Date;
      progressPercent?: number;
      status?: 'ACTIVE' | 'COMPLETED' | 'DROPPED';
    },
    organizationId: string,
  ): Promise<EnrollmentRow> {
    const existing = await this.enrollments.findById(id, organizationId);

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

    const updated = await this.enrollments.update(id, changes);

    await this.audit.recordChange({
      action: 'education.enrollment.updated',
      entityType: 'Enrollment',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- assignments -------------------------------------------------

  listAssignments(): Promise<AssignmentRow[]> {
    return this.assignments.list();
  }

  findAssignment(id: string, organizationId: string): Promise<AssignmentRow> {
    return this.assignments.findById(id, organizationId);
  }

  async createAssignment(
    input: {
      courseId: string;
      title: string;
      instructions?: string;
      dueAt?: Date;
      maxMarks: number;
    },
    organizationId: string,
  ): Promise<AssignmentRow> {
    await this.courses.findById(input.courseId, organizationId);

    const created = await this.assignments.create({
      courseId: input.courseId,
      title: input.title,
      instructions: input.instructions ?? null,
      dueAt: input.dueAt ?? null,
      maxMarks: input.maxMarks,
    });

    await this.audit.record({
      action: 'education.assignment.created',
      entityType: 'Assignment',
      entityId: created.id,
      organizationId,
      after: {
        courseId: created.courseId,
        title: created.title,
        instructions: created.instructions,
      },
    });

    return created;
  }

  async updateAssignment(
    id: string,
    changes: {
      courseId?: string;
      title?: string;
      instructions?: string;
      dueAt?: Date;
      maxMarks?: number;
    },
    organizationId: string,
  ): Promise<AssignmentRow> {
    const existing = await this.assignments.findById(id, organizationId);

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

    const updated = await this.assignments.update(id, changes);

    await this.audit.recordChange({
      action: 'education.assignment.updated',
      entityType: 'Assignment',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- submissions -------------------------------------------------

  listAssignmentSubmissions(): Promise<AssignmentSubmissionRow[]> {
    return this.assignmentSubmissions.list();
  }

  findAssignmentSubmission(id: string, organizationId: string): Promise<AssignmentSubmissionRow> {
    return this.assignmentSubmissions.findById(id, organizationId);
  }

  async createAssignmentSubmission(
    input: {
      assignmentId: string;
      studentId: string;
      submittedAt: Date;
      body?: string;
      marksAwarded?: number;
      feedback?: string;
      status?: 'DRAFT' | 'SUBMITTED' | 'MARKED' | 'RETURNED' | 'LATE';
    },
    organizationId: string,
  ): Promise<AssignmentSubmissionRow> {
    await this.assignments.findById(input.assignmentId, organizationId);
    await this.students.findById(input.studentId, organizationId);

    const created = await this.assignmentSubmissions.create({
      assignmentId: input.assignmentId,
      studentId: input.studentId,
      submittedAt: input.submittedAt,
      body: input.body ?? null,
      marksAwarded: input.marksAwarded ?? null,
      feedback: input.feedback ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'education.assignment-submission.created',
      entityType: 'AssignmentSubmission',
      entityId: created.id,
      organizationId,
      after: {
        assignmentId: created.assignmentId,
        studentId: created.studentId,
        submittedAt: created.submittedAt,
      },
    });

    return created;
  }

  async updateAssignmentSubmission(
    id: string,
    changes: {
      assignmentId?: string;
      studentId?: string;
      submittedAt?: Date;
      body?: string;
      marksAwarded?: number;
      feedback?: string;
      status?: 'DRAFT' | 'SUBMITTED' | 'MARKED' | 'RETURNED' | 'LATE';
    },
    organizationId: string,
  ): Promise<AssignmentSubmissionRow> {
    const existing = await this.assignmentSubmissions.findById(id, organizationId);

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

    const updated = await this.assignmentSubmissions.update(id, changes);

    await this.audit.recordChange({
      action: 'education.assignment-submission.updated',
      entityType: 'AssignmentSubmission',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- certificates ------------------------------------------------

  listCertificates(): Promise<CertificateRow[]> {
    return this.certificates.list();
  }

  findCertificate(id: string, organizationId: string): Promise<CertificateRow> {
    return this.certificates.findById(id, organizationId);
  }

  async createCertificate(
    input: {
      enrollmentId: string;
      serial: string;
      issuedAt: Date;
      revokedAt?: Date;
      revocationReason?: string;
    },
    organizationId: string,
  ): Promise<CertificateRow> {
    await this.enrollments.findById(input.enrollmentId, organizationId);

    const created = await this.certificates.create({
      enrollmentId: input.enrollmentId,
      serial: input.serial,
      issuedAt: input.issuedAt,
      revokedAt: input.revokedAt ?? null,
      revocationReason: input.revocationReason ?? null,
    });

    await this.audit.record({
      action: 'education.certificate.created',
      entityType: 'Certificate',
      entityId: created.id,
      organizationId,
      after: {
        enrollmentId: created.enrollmentId,
        serial: created.serial,
        issuedAt: created.issuedAt,
      },
    });

    return created;
  }

  async updateCertificate(
    id: string,
    changes: {
      enrollmentId?: string;
      issuedAt?: Date;
      revokedAt?: Date;
      revocationReason?: string;
    },
    organizationId: string,
  ): Promise<CertificateRow> {
    const existing = await this.certificates.findById(id, organizationId);

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

    const updated = await this.certificates.update(id, changes);

    await this.audit.recordChange({
      action: 'education.certificate.updated',
      entityType: 'Certificate',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- tutor sessions ----------------------------------------------

  listTutorSessions(): Promise<TutorSessionRow[]> {
    return this.tutorSessions.list();
  }

  findTutorSession(id: string, organizationId: string): Promise<TutorSessionRow> {
    return this.tutorSessions.findById(id, organizationId);
  }

  async createTutorSession(
    input: {
      studentId: string;
      courseId?: string;
      prompt: string;
      response?: string;
      modelId?: string;
      askedAt: Date;
      status?: 'PENDING' | 'ANSWERED' | 'FAILED' | 'BLOCKED';
    },
    organizationId: string,
  ): Promise<TutorSessionRow> {
    await this.students.findById(input.studentId, organizationId);
    if (input.courseId !== undefined) {
      await this.courses.findById(input.courseId, organizationId);
    }

    const created = await this.tutorSessions.create({
      studentId: input.studentId,
      courseId: input.courseId ?? null,
      prompt: input.prompt,
      response: input.response ?? null,
      modelId: input.modelId ?? null,
      askedAt: input.askedAt,
      status: input.status,
    });

    await this.audit.record({
      action: 'education.tutor-session.created',
      entityType: 'TutorSession',
      entityId: created.id,
      organizationId,
      after: { studentId: created.studentId, courseId: created.courseId, prompt: created.prompt },
    });

    return created;
  }

  async updateTutorSession(
    id: string,
    changes: {
      studentId?: string;
      courseId?: string;
      prompt?: string;
      response?: string;
      modelId?: string;
      askedAt?: Date;
      status?: 'PENDING' | 'ANSWERED' | 'FAILED' | 'BLOCKED';
    },
    organizationId: string,
  ): Promise<TutorSessionRow> {
    const existing = await this.tutorSessions.findById(id, organizationId);

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

    const updated = await this.tutorSessions.update(id, changes);

    await this.audit.recordChange({
      action: 'education.tutor-session.updated',
      entityType: 'TutorSession',
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

import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import type { AppPrismaService } from '../../core/prisma.service';
import { AUDIT_SERVICE } from '../../tokens';
import { TenantRepository } from '../../common/tenant-repository';

export interface StudentProfileRow {
  id: string;
  organizationId: string;
  userId: string | null;
  displayName: string;
  level: string | null;
  locale: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface LearningSessionRow {
  id: string;
  organizationId: string;
  studentProfileId: string;
  topic: string;
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';
  startedAt: Date | null;
  completedAt: Date | null;
  durationMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface QuizAttemptRow {
  id: string;
  organizationId: string;
  studentProfileId: string;
  learningSessionId: string | null;
  quizKey: string;
  score: number;
  maxScore: number;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ProgressSummary {
  studentProfileId: string;
  displayName: string;
  sessionsCompleted: number;
  sessionsTotal: number;
  attempts: number;
  averageScorePercent: number;
}

/**
 * Learning domain service.
 *
 * Note that student progress is *derived*, never stored: a denormalized
 * counter is one failed write away from lying, and a learner's record is
 * exactly the kind of data nobody notices is wrong until it matters.
 */
@Injectable()
export class ProductService {
  private readonly students: TenantRepository<StudentProfileRow>;
  private readonly sessions: TenantRepository<LearningSessionRow>;
  private readonly attempts: TenantRepository<QuizAttemptRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.students = new TenantRepository<StudentProfileRow>(prisma, 'studentProfile');
    this.sessions = new TenantRepository<LearningSessionRow>(prisma, 'learningSession');
    this.attempts = new TenantRepository<QuizAttemptRow>(prisma, 'quizAttempt');
  }

  // --- students -------------------------------------------------------------

  listStudents(): Promise<StudentProfileRow[]> {
    return this.students.list();
  }

  findStudent(id: string, organizationId: string): Promise<StudentProfileRow> {
    return this.students.findById(id, organizationId);
  }

  async createStudent(
    input: { displayName: string; userId?: string; level?: string; locale?: string },
    organizationId: string,
  ): Promise<StudentProfileRow> {
    const student = await this.students.create({
      displayName: input.displayName,
      userId: input.userId ?? null,
      level: input.level ?? null,
      ...(input.locale ? { locale: input.locale } : {}),
    });

    await this.audit.record({
      action: 'learning.student.created',
      entityType: 'StudentProfile',
      entityId: student.id,
      organizationId,
      // The learner's name is the point of the record; nothing sensitive
      // beyond it is copied in.
      after: { displayName: student.displayName, level: student.level },
    });

    return student;
  }

  // --- sessions -------------------------------------------------------------

  listSessions(): Promise<LearningSessionRow[]> {
    return this.sessions.list();
  }

  async createSession(
    input: { studentProfileId: string; topic: string },
    organizationId: string,
  ): Promise<LearningSessionRow> {
    // Reports not_found for a student in another organization.
    await this.students.findById(input.studentProfileId, organizationId);

    const session = await this.sessions.create({
      studentProfileId: input.studentProfileId,
      topic: input.topic,
      status: 'SCHEDULED',
    });

    await this.audit.record({
      action: 'learning.session.created',
      entityType: 'LearningSession',
      entityId: session.id,
      organizationId,
      after: { studentProfileId: session.studentProfileId, topic: session.topic },
    });

    return session;
  }

  async updateSessionStatus(
    id: string,
    status: LearningSessionRow['status'],
    organizationId: string,
  ): Promise<LearningSessionRow> {
    const existing = await this.sessions.findById(id, organizationId);
    const before = { status: existing.status };

    const data: Record<string, unknown> = { status };
    if (status === 'IN_PROGRESS' && !existing.startedAt) data.startedAt = new Date();
    if (status === 'COMPLETED') data.completedAt = new Date();

    const updated = await this.sessions.update(id, data);

    await this.audit.recordChange({
      action: 'learning.session.status_changed',
      entityType: 'LearningSession',
      entityId: id,
      organizationId,
      before,
      after: { status: updated.status },
    });

    return updated;
  }

  // --- attempts -------------------------------------------------------------

  listAttempts(): Promise<QuizAttemptRow[]> {
    return this.attempts.list();
  }

  async recordAttempt(
    input: {
      studentProfileId: string;
      quizKey: string;
      score: number;
      maxScore: number;
      learningSessionId?: string;
    },
    organizationId: string,
  ): Promise<QuizAttemptRow> {
    await this.students.findById(input.studentProfileId, organizationId);
    if (input.learningSessionId) {
      await this.sessions.findById(input.learningSessionId, organizationId);
    }

    const attempt = await this.attempts.create({
      studentProfileId: input.studentProfileId,
      quizKey: input.quizKey,
      score: input.score,
      maxScore: input.maxScore,
      learningSessionId: input.learningSessionId ?? null,
      submittedAt: new Date(),
    });

    await this.audit.record({
      action: 'learning.attempt.recorded',
      entityType: 'QuizAttempt',
      entityId: attempt.id,
      organizationId,
      after: { quizKey: attempt.quizKey, score: attempt.score, maxScore: attempt.maxScore },
    });

    return attempt;
  }

  // --- progress -------------------------------------------------------------

  /**
   * Progress per student, derived on read.
   *
   * Every underlying read is tenant-scoped, so a summary can only ever be
   * computed from the caller's own organization.
   */
  async progressSummary(): Promise<ProgressSummary[]> {
    const [students, sessions, attempts] = await Promise.all([
      this.students.list(),
      this.sessions.list(),
      this.attempts.list(),
    ]);

    return students.map((student) => {
      const theirSessions = sessions.filter((session) => session.studentProfileId === student.id);
      const theirAttempts = attempts.filter((attempt) => attempt.studentProfileId === student.id);

      const scored = theirAttempts.filter((attempt) => attempt.maxScore > 0);
      const averageScorePercent =
        scored.length === 0
          ? 0
          : Math.round(
              scored.reduce((total, attempt) => total + attempt.score / attempt.maxScore, 0) *
                (100 / scored.length),
            );

      return {
        studentProfileId: student.id,
        displayName: student.displayName,
        sessionsCompleted: theirSessions.filter((session) => session.status === 'COMPLETED').length,
        sessionsTotal: theirSessions.length,
        attempts: theirAttempts.length,
        averageScorePercent,
      };
    });
  }
}

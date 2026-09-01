/**
 * Shared types — TrustOS Education.
 *
 * The shapes the API returns and the admin consumes. One definition, imported by both, so a
 * renamed field is a compile error rather than an empty column.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull a server-only
 * module into a browser bundle. The admin application imports this package directly, so anything
 * reachable from here reaches the client.
 */

/** ISO-8601 timestamp as it crosses the API boundary. */
export type IsoDateTime = string;

/** Fields every tenant-owned entity exposes. */
export interface TenantOwnedSummary {
  id: string;
  organizationId: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Somebody who teaches. `userId` is the framework identity. */
export interface Teacher {
  id: string;
  userId: string;
  displayName: string;
  email: string | null;
  bio: string | null;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Somebody who learns. */
export interface Student {
  id: string;
  userId: string;
  displayName: string;
  email: string | null;
  enrolledOn: Date;
  status: 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'WITHDRAWN';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A body of material a student can enrol in. */
export interface Course {
  id: string;
  code: string;
  title: string;
  summary: string | null;
  teacherId: string;
  level: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One unit of a course. */
export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  position: number;
  body: string | null;
  durationMinutes: number;
  isPublished: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A set of questions attached to a lesson or a course. */
export interface Quiz {
  id: string;
  courseId: string;
  lessonId: string | null;
  title: string;
  passMarkPercent: number;
  timeLimitMinutes: number;
  isPublished: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One question. `correctOption` is never returned to a student — the service strips it, and */
/** there is a test that proves it. */
export interface QuizQuestion {
  id: string;
  quizId: string;
  position: number;
  prompt: string;
  options: Record<string, unknown>;
  correctOption: number;
  marks: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A student on a course. */
export interface Enrollment {
  id: string;
  courseId: string;
  studentId: string;
  enrolledAt: Date;
  completedAt: Date | null;
  progressPercent: number;
  status: 'ACTIVE' | 'COMPLETED' | 'DROPPED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Work a student submits and a teacher marks. */
export interface Assignment {
  id: string;
  courseId: string;
  title: string;
  instructions: string | null;
  dueAt: Date | null;
  maxMarks: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A student handing work in. */
export interface AssignmentSubmission {
  id: string;
  assignmentId: string;
  studentId: string;
  submittedAt: Date;
  body: string | null;
  marksAwarded: number | null;
  feedback: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'MARKED' | 'RETURNED' | 'LATE';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Proof a student finished a course. `serial` is what a third party verifies against, so it is */
/** immutable and unique. */
export interface Certificate {
  id: string;
  enrollmentId: string;
  serial: string;
  issuedAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The AI tutor hook. Records the question, the answer and which model answered — and calls */
/** nothing. Wiring a provider is a deployment decision made through @trustsystem/ai-gateway. */
export interface TutorSession {
  id: string;
  studentId: string;
  courseId: string | null;
  prompt: string;
  response: string | null;
  modelId: string | null;
  askedAt: Date;
  status: 'PENDING' | 'ANSWERED' | 'FAILED' | 'BLOCKED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

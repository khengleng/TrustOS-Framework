/**
 * Types shared between the API and the admin application.
 *
 * Runtime-free by design: no imports, no side effects.
 */

export type LearningSessionStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';

export interface StudentProfileSummary {
  id: string;
  organizationId: string;
  userId: string | null;
  displayName: string;
  level: string | null;
  locale: string;
  isActive: boolean;
  createdAt: string;
}

export interface LearningSessionSummary {
  id: string;
  organizationId: string;
  studentProfileId: string;
  topic: string;
  status: LearningSessionStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMinutes: number | null;
  createdAt: string;
}

export interface QuizAttemptSummary {
  id: string;
  organizationId: string;
  studentProfileId: string;
  learningSessionId: string | null;
  quizKey: string;
  score: number;
  maxScore: number;
  submittedAt: string | null;
}

export interface ProgressSummaryRow {
  studentProfileId: string;
  displayName: string;
  sessionsCompleted: number;
  sessionsTotal: number;
  attempts: number;
  averageScorePercent: number;
}

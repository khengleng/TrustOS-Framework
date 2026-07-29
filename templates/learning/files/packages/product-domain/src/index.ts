/**
 * Product domain — TrustOS Learning.
 *
 * Permission keys are namespaced so they can never collide with a framework
 * key, and they are part of the public contract: add keys freely, never rename
 * one.
 */

export interface ProductPermission {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): ProductPermission {
  const segments = key.split('.');
  return {
    key,
    resource: segments.slice(0, -1).join('.'),
    action: segments[segments.length - 1] as string,
    description,
  };
}

export const LEARNING_PERMISSIONS = {
  STUDENT_READ: define('learning.student.read', 'View student profiles.'),
  STUDENT_CREATE: define('learning.student.create', 'Create a student profile.'),
  STUDENT_UPDATE: define('learning.student.update', 'Modify a student profile.'),

  SESSION_READ: define('learning.session.read', 'View learning sessions.'),
  SESSION_CREATE: define('learning.session.create', 'Start a learning session.'),
  SESSION_UPDATE: define('learning.session.update', 'Update a learning session.'),

  ATTEMPT_READ: define('learning.attempt.read', 'View quiz attempts.'),
  ATTEMPT_CREATE: define('learning.attempt.create', 'Record a quiz attempt.'),

  PROGRESS_READ: define('learning.progress.read', 'View the progress summary.'),
} as const;

export const PRODUCT_PERMISSIONS: ProductPermission[] = Object.values(LEARNING_PERMISSIONS);

const READ_ONLY = [
  LEARNING_PERMISSIONS.STUDENT_READ.key,
  LEARNING_PERMISSIONS.SESSION_READ.key,
  LEARNING_PERMISSIONS.ATTEMPT_READ.key,
  LEARNING_PERMISSIONS.PROGRESS_READ.key,
];

/**
 * Which framework roles receive which product permissions, applied by the seed.
 *
 * `operator` is the teaching role: it runs sessions and records attempts but
 * cannot change a student's profile. `auditor` is read-only by definition.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = {
  organization_owner: PRODUCT_PERMISSIONS.map((permission) => permission.key),
  administrator: PRODUCT_PERMISSIONS.map((permission) => permission.key),
  operator: [
    ...READ_ONLY,
    LEARNING_PERMISSIONS.SESSION_CREATE.key,
    LEARNING_PERMISSIONS.SESSION_UPDATE.key,
    LEARNING_PERMISSIONS.ATTEMPT_CREATE.key,
  ],
  auditor: READ_ONLY,
};

export type LearningSessionStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';

export const LEARNING_SESSION_STATUSES: LearningSessionStatus[] = [
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'ABANDONED',
];

/** Percentage score, rounded. `maxScore` of 0 scores 0 rather than dividing by zero. */
export function scorePercentage(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return Math.round((score / maxScore) * 100);
}

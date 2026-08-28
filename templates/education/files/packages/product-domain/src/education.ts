/**
 * TrustOS Education — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const EDUCATION_PERMISSIONS = {
  TEACHER_READ: definePermission('education.teacher.read', 'View teachers.'),
  TEACHER_CREATE: definePermission('education.teacher.create', 'Create teacher.'),
  TEACHER_UPDATE: definePermission('education.teacher.update', 'Modify teacher.'),
  STUDENT_READ: definePermission('education.student.read', 'View students.'),
  STUDENT_CREATE: definePermission('education.student.create', 'Create student.'),
  STUDENT_UPDATE: definePermission('education.student.update', 'Modify student.'),
  COURSE_READ: definePermission('education.course.read', 'View courses.'),
  COURSE_CREATE: definePermission('education.course.create', 'Create course.'),
  COURSE_UPDATE: definePermission('education.course.update', 'Modify course.'),
  LESSON_READ: definePermission('education.lesson.read', 'View lessons.'),
  LESSON_CREATE: definePermission('education.lesson.create', 'Create lesson.'),
  LESSON_UPDATE: definePermission('education.lesson.update', 'Modify lesson.'),
  QUIZ_READ: definePermission('education.quiz.read', 'View quizzes.'),
  QUIZ_CREATE: definePermission('education.quiz.create', 'Create quiz.'),
  QUIZ_UPDATE: definePermission('education.quiz.update', 'Modify quiz.'),
  QUIZ_QUESTION_READ: definePermission('education.quiz-question.read', 'View questions.'),
  QUIZ_QUESTION_CREATE: definePermission('education.quiz-question.create', 'Create question.'),
  QUIZ_QUESTION_UPDATE: definePermission('education.quiz-question.update', 'Modify question.'),
  ENROLLMENT_READ: definePermission('education.enrollment.read', 'View enrolments.'),
  ENROLLMENT_CREATE: definePermission('education.enrollment.create', 'Create enrolment.'),
  ENROLLMENT_UPDATE: definePermission('education.enrollment.update', 'Modify enrolment.'),
  ASSIGNMENT_READ: definePermission('education.assignment.read', 'View assignments.'),
  ASSIGNMENT_CREATE: definePermission('education.assignment.create', 'Create assignment.'),
  ASSIGNMENT_UPDATE: definePermission('education.assignment.update', 'Modify assignment.'),
  ASSIGNMENT_SUBMISSION_READ: definePermission(
    'education.assignment-submission.read',
    'View submissions.',
  ),
  ASSIGNMENT_SUBMISSION_CREATE: definePermission(
    'education.assignment-submission.create',
    'Create submission.',
  ),
  ASSIGNMENT_SUBMISSION_UPDATE: definePermission(
    'education.assignment-submission.update',
    'Modify submission.',
  ),
  CERTIFICATE_READ: definePermission('education.certificate.read', 'View certificates.'),
  CERTIFICATE_CREATE: definePermission('education.certificate.create', 'Create certificate.'),
  CERTIFICATE_UPDATE: definePermission('education.certificate.update', 'Modify certificate.'),
  TUTOR_SESSION_READ: definePermission('education.tutor-session.read', 'View tutor sessions.'),
  TUTOR_SESSION_CREATE: definePermission('education.tutor-session.create', 'Create tutor session.'),
  TUTOR_SESSION_UPDATE: definePermission('education.tutor-session.update', 'Modify tutor session.'),
} as const;

export const EDUCATION_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(EDUCATION_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  EDUCATION_PERMISSIONS.TEACHER_READ.key,
  EDUCATION_PERMISSIONS.STUDENT_READ.key,
  EDUCATION_PERMISSIONS.COURSE_READ.key,
  EDUCATION_PERMISSIONS.LESSON_READ.key,
  EDUCATION_PERMISSIONS.QUIZ_READ.key,
  EDUCATION_PERMISSIONS.QUIZ_QUESTION_READ.key,
  EDUCATION_PERMISSIONS.ENROLLMENT_READ.key,
  EDUCATION_PERMISSIONS.ASSIGNMENT_READ.key,
  EDUCATION_PERMISSIONS.ASSIGNMENT_SUBMISSION_READ.key,
  EDUCATION_PERMISSIONS.CERTIFICATE_READ.key,
  EDUCATION_PERMISSIONS.TUTOR_SESSION_READ.key,
];

const WRITE = [
  EDUCATION_PERMISSIONS.TEACHER_CREATE.key,
  EDUCATION_PERMISSIONS.TEACHER_UPDATE.key,
  EDUCATION_PERMISSIONS.STUDENT_CREATE.key,
  EDUCATION_PERMISSIONS.STUDENT_UPDATE.key,
  EDUCATION_PERMISSIONS.COURSE_CREATE.key,
  EDUCATION_PERMISSIONS.COURSE_UPDATE.key,
  EDUCATION_PERMISSIONS.LESSON_CREATE.key,
  EDUCATION_PERMISSIONS.LESSON_UPDATE.key,
  EDUCATION_PERMISSIONS.QUIZ_CREATE.key,
  EDUCATION_PERMISSIONS.QUIZ_UPDATE.key,
  EDUCATION_PERMISSIONS.QUIZ_QUESTION_CREATE.key,
  EDUCATION_PERMISSIONS.QUIZ_QUESTION_UPDATE.key,
  EDUCATION_PERMISSIONS.ENROLLMENT_CREATE.key,
  EDUCATION_PERMISSIONS.ENROLLMENT_UPDATE.key,
  EDUCATION_PERMISSIONS.ASSIGNMENT_CREATE.key,
  EDUCATION_PERMISSIONS.ASSIGNMENT_UPDATE.key,
  EDUCATION_PERMISSIONS.ASSIGNMENT_SUBMISSION_CREATE.key,
  EDUCATION_PERMISSIONS.ASSIGNMENT_SUBMISSION_UPDATE.key,
  EDUCATION_PERMISSIONS.CERTIFICATE_CREATE.key,
  EDUCATION_PERMISSIONS.CERTIFICATE_UPDATE.key,
  EDUCATION_PERMISSIONS.TUTOR_SESSION_CREATE.key,
  EDUCATION_PERMISSIONS.TUTOR_SESSION_UPDATE.key,
];

export const EDUCATION_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: EDUCATION_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type StudentStatus = 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'WITHDRAWN';
export const STUDENT_STATUS_VALUES: StudentStatus[] = [
  'ACTIVE',
  'PAUSED',
  'GRADUATED',
  'WITHDRAWN',
];

export type CourseLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
export const COURSE_LEVEL_VALUES: CourseLevel[] = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];

export type CourseStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export const COURSE_STATUS_VALUES: CourseStatus[] = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

export type EnrollmentStatus = 'ACTIVE' | 'COMPLETED' | 'DROPPED';
export const ENROLLMENT_STATUS_VALUES: EnrollmentStatus[] = ['ACTIVE', 'COMPLETED', 'DROPPED'];

export type SubmissionStatus = 'DRAFT' | 'SUBMITTED' | 'MARKED' | 'RETURNED' | 'LATE';
export const SUBMISSION_STATUS_VALUES: SubmissionStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'MARKED',
  'RETURNED',
  'LATE',
];

export type TutorSessionStatus = 'PENDING' | 'ANSWERED' | 'FAILED' | 'BLOCKED';
export const TUTOR_SESSION_STATUS_VALUES: TutorSessionStatus[] = [
  'PENDING',
  'ANSWERED',
  'FAILED',
  'BLOCKED',
];

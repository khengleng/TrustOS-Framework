import type { ResourceDefinition } from './resource-types';

/** Learning console screens. */
export const RESOURCES: ResourceDefinition[] = [
  {
    key: 'students',
    label: 'Student profiles',
    endpoint: '/students',
    description: 'Learners in this organization.',
    emptyHint: 'Create one with POST /api/students.',
    columns: [
      { key: 'displayName', label: 'Student' },
      { key: 'level', label: 'Level', badge: true },
      { key: 'locale', label: 'Locale' },
      { key: 'isActive', label: 'Active', badge: true },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
  {
    key: 'learning-sessions',
    label: 'Sessions',
    endpoint: '/learning-sessions',
    description: 'Periods of study, and where each one got to.',
    emptyHint: 'Schedule one with POST /api/learning-sessions.',
    columns: [
      { key: 'topic', label: 'Topic' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'startedAt', label: 'Started', date: true },
      { key: 'completedAt', label: 'Completed', date: true },
    ],
  },
  {
    key: 'progress',
    label: 'Progress summary',
    endpoint: '/progress',
    description: 'Derived on read from sessions and attempts — never stored, so it cannot drift.',
    emptyHint: 'Add students and record attempts to populate this.',
    columns: [
      { key: 'displayName', label: 'Student' },
      { key: 'sessionsCompleted', label: 'Completed' },
      { key: 'sessionsTotal', label: 'Sessions' },
      { key: 'attempts', label: 'Attempts' },
      { key: 'averageScorePercent', label: 'Average %' },
    ],
  },
  {
    key: 'quiz-attempts',
    label: 'Admin review',
    endpoint: '/quiz-attempts',
    description: 'Every recorded attempt, for review.',
    emptyHint: 'Record one with POST /api/quiz-attempts.',
    columns: [
      { key: 'quizKey', label: 'Quiz' },
      { key: 'score', label: 'Score' },
      { key: 'maxScore', label: 'Out of' },
      { key: 'submittedAt', label: 'Submitted', date: true },
    ],
  },
];

/**
 * Shared types — TrustOS School.
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

/** A teaching period. Half-open `[startsOn, endsOn)`, so two consecutive terms tile without the */
/** boundary day belonging to both. */
export interface AcademicTerm {
  id: string;
  name: string;
  code: string;
  startsOn: Date;
  endsOn: Date;
  isCurrent: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A set of students taught together for a term. */
export interface ClassGroup {
  id: string;
  termId: string;
  courseId: string;
  teacherId: string;
  name: string;
  room: string | null;
  capacity: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One student, one session. See the migration note before summarizing it. */
export interface Attendance {
  id: string;
  classGroupId: string;
  studentId: string;
  sessionOn: Date;
  period: number;
  state: 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
  note: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A mark for a student in a class, for a term. */
export interface Grade {
  id: string;
  classGroupId: string;
  studentId: string;
  component: string;
  marksAwarded: number;
  maxMarks: number;
  recordedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A parent or carer. Contact details are personal data — the API returns them only to roles */
/** holding the PII permission. */
export interface Guardian {
  id: string;
  studentId: string;
  fullName: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  isPrimaryContact: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

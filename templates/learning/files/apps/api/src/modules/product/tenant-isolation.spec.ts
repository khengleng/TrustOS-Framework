import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import type { ApiError } from '@trustsystem/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { ProductService } from './product.service';

/**
 * Tenant isolation for the learning domain.
 *
 * A learner's record is exactly the kind of data that must never cross an
 * organization boundary, and exactly the kind nobody notices is wrong until it
 * matters. These assertions are the ones to copy for every entity you add.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

function buildService(): { service: ProductService; sink: InMemoryAuditSink } {
  const prisma = {
    studentProfile: new FakeModelDelegate([
      {
        id: 'st_acme',
        organizationId: ACME,
        userId: null,
        displayName: 'Acme Learner',
        level: 'Beginner',
        locale: 'en',
        isActive: true,
        ...timestamps,
      },
      {
        id: 'st_rival',
        organizationId: RIVAL,
        userId: null,
        displayName: 'Rival Learner',
        level: 'Beginner',
        locale: 'en',
        isActive: true,
        ...timestamps,
      },
    ]),
    learningSession: new FakeModelDelegate([
      {
        id: 'se_acme',
        organizationId: ACME,
        studentProfileId: 'st_acme',
        topic: 'Fractions',
        status: 'SCHEDULED',
        startedAt: null,
        completedAt: null,
        durationMinutes: null,
        ...timestamps,
      },
      {
        id: 'se_rival',
        organizationId: RIVAL,
        studentProfileId: 'st_rival',
        topic: 'Fractions',
        status: 'SCHEDULED',
        startedAt: null,
        completedAt: null,
        durationMinutes: null,
        ...timestamps,
      },
    ]),
    quizAttempt: new FakeModelDelegate([
      {
        id: 'qa_acme',
        organizationId: ACME,
        studentProfileId: 'st_acme',
        learningSessionId: 'se_acme',
        quizKey: 'q1',
        score: 8,
        maxScore: 10,
        submittedAt: new Date('2026-01-02T00:00:00.000Z'),
        ...timestamps,
      },
      {
        id: 'qa_rival',
        organizationId: RIVAL,
        studentProfileId: 'st_rival',
        learningSessionId: 'se_rival',
        quizKey: 'q1',
        score: 2,
        maxScore: 10,
        submittedAt: new Date('2026-01-02T00:00:00.000Z'),
        ...timestamps,
      },
    ]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new ProductService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('learning tenant isolation', () => {
  let service: ProductService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization students, sessions and attempts', async () => {
    expect((await asAcme(() => service.listStudents())).map((row) => row.displayName)).toEqual([
      'Acme Learner',
    ]);
    expect((await asRival(() => service.listSessions())).map((row) => row.id)).toEqual([
      'se_rival',
    ]);
    expect((await asAcme(() => service.listAttempts())).map((row) => row.id)).toEqual(['qa_acme']);
  });

  it('stamps new rows with the calling organization', async () => {
    const student = await asAcme(() => service.createStudent({ displayName: 'New' }, ACME));
    expect(student.organizationId).toBe(ACME);
  });

  it('reports another organization student as not_found', async () => {
    try {
      await asAcme(() => service.findStudent('st_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('refuses to open a session for another organization student', async () => {
    await expect(
      asAcme(() => service.createSession({ studentProfileId: 'st_rival', topic: 'Sneaky' }, ACME)),
    ).rejects.toThrow();
  });

  it('refuses to record an attempt against another organization student or session', async () => {
    await expect(
      asAcme(() =>
        service.recordAttempt(
          { studentProfileId: 'st_rival', quizKey: 'q1', score: 1, maxScore: 10 },
          ACME,
        ),
      ),
    ).rejects.toThrow();

    await expect(
      asAcme(() =>
        service.recordAttempt(
          {
            studentProfileId: 'st_acme',
            learningSessionId: 'se_rival',
            quizKey: 'q1',
            score: 1,
            maxScore: 10,
          },
          ACME,
        ),
      ),
    ).rejects.toThrow();
  });

  it('never mixes another organization data into the progress summary', async () => {
    const summary = await asAcme(() => service.progressSummary());

    expect(summary).toHaveLength(1);
    expect(summary[0]?.displayName).toBe('Acme Learner');
    // 8/10 for Acme. The rival's 2/10 must not move this number.
    expect(summary[0]?.averageScorePercent).toBe(80);
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(service.listStudents()).rejects.toThrow(/Organization context is required/);
    await expect(service.progressSummary()).rejects.toThrow(/Organization context is required/);
  });

  it('audits mutations with the organization attached, and audits no reads', async () => {
    await asAcme(() => service.progressSummary());
    expect(sink.records).toHaveLength(0);

    await asAcme(() => service.createStudent({ displayName: 'Audited' }, ACME));
    await asAcme(() => service.updateSessionStatus('se_acme', 'IN_PROGRESS', ACME));

    expect(sink.records.map((record) => record.action)).toEqual([
      'learning.student.created',
      'learning.session.status_changed',
    ]);
    expect(sink.records.every((record) => record.organizationId === ACME)).toBe(true);
  });

  it('records the previous status on a session change', async () => {
    await asAcme(() => service.updateSessionStatus('se_acme', 'COMPLETED', ACME));

    const record = sink.find('learning.session.status_changed');
    expect(record?.before).toEqual({ status: 'SCHEDULED' });
    expect(record?.after).toEqual({ status: 'COMPLETED' });
  });
});

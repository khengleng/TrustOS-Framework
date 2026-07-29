import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '@trustos/logging';
import type { RequestContext } from '@trustos/shared-types';
import { AUDIT_ACTIONS, AUDIT_ENTITY } from './actions';
import { AuditService, diffEntities } from './audit.service';
import { FailingAuditSink, InMemoryAuditSink } from './testing/in-memory-sink';

const FIXED_NOW = new Date('2026-07-29T09:15:00.000Z');

function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req_abc123',
    method: 'POST',
    path: '/api/organizations/org_acme/members',
    ipAddress: '203.0.113.9',
    userAgent: 'Mozilla/5.0 (admin console)',
    receivedAt: FIXED_NOW,
    actor: {
      userId: 'user_admin',
      email: 'admin@acme.test',
      organizationId: 'org_acme',
      roles: ['administrator'],
      permissions: ['organization.member.invite'],
      isSuperAdmin: false,
      tokenId: 'jti_1',
    },
    organizationId: 'org_acme',
    ...overrides,
  };
}

describe('AuditService', () => {
  let sink: InMemoryAuditSink;
  let audit: AuditService;

  beforeEach(() => {
    sink = new InMemoryAuditSink();
    audit = new AuditService({ sink, now: () => FIXED_NOW });
  });

  it('writes every field the audit contract requires', async () => {
    await runWithRequestContext(requestContext(), () =>
      audit.record({
        action: AUDIT_ACTIONS.MEMBER_INVITED,
        entityType: AUDIT_ENTITY.ORGANIZATION_MEMBER,
        entityId: 'member_1',
        before: null,
        after: { email: 'new@acme.test', role: 'operator' },
      }),
    );

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toEqual({
      action: 'organization.member.invited',
      entityType: 'OrganizationMember',
      entityId: 'member_1',
      actorId: 'user_admin',
      organizationId: 'org_acme',
      before: null,
      after: { email: 'new@acme.test', role: 'operator' },
      requestId: 'req_abc123',
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (admin console)',
      occurredAt: FIXED_NOW,
    });
  });

  it('fills actor, organization and request metadata from the ambient context', async () => {
    await runWithRequestContext(requestContext(), () =>
      audit.record({ action: AUDIT_ACTIONS.LOGIN, entityType: AUDIT_ENTITY.USER }),
    );

    const record = sink.records[0];
    expect(record?.actorId).toBe('user_admin');
    expect(record?.organizationId).toBe('org_acme');
    expect(record?.requestId).toBe('req_abc123');
  });

  it('lets an explicit value override the ambient context', async () => {
    await runWithRequestContext(requestContext(), () =>
      audit.record({
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: AUDIT_ENTITY.USER,
        actorId: null,
        organizationId: null,
      }),
    );

    expect(sink.records[0]?.actorId).toBeNull();
    expect(sink.records[0]?.organizationId).toBeNull();
  });

  it('still writes a usable record outside any request context', async () => {
    await audit.record({
      action: AUDIT_ACTIONS.CONFIGURATION_CHANGED,
      entityType: AUDIT_ENTITY.CONFIGURATION,
      entityId: 'feature_flags',
    });

    expect(sink.records[0]).toMatchObject({
      requestId: null,
      ipAddress: null,
      actorId: null,
      occurredAt: FIXED_NOW,
    });
  });

  it('redacts credentials out of before/after snapshots', async () => {
    await audit.record({
      action: AUDIT_ACTIONS.USER_UPDATED,
      entityType: AUDIT_ENTITY.USER,
      entityId: 'user_1',
      before: { email: 'ada@example.com', passwordHash: '$2b$12$oldhash' },
      after: { email: 'ada@example.com', passwordHash: '$2b$12$newhash', refreshToken: 'rt_live' },
    });

    const serialized = JSON.stringify(sink.records[0]);
    expect(serialized).not.toContain('$2b$12$oldhash');
    expect(serialized).not.toContain('rt_live');
    expect(serialized).toContain('ada@example.com');
  });

  it('does not fail the caller when the sink is down', async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const fragile = new AuditService({
      sink: new FailingAuditSink(),
      logger: logger as never,
      now: () => FIXED_NOW,
    });

    await expect(
      fragile.record({ action: AUDIT_ACTIONS.LOGIN, entityType: AUDIT_ENTITY.USER }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login' }),
      'audit record could not be written',
    );
  });

  it('covers every action the framework is required to audit', () => {
    for (const action of [
      AUDIT_ACTIONS.LOGIN,
      AUDIT_ACTIONS.LOGOUT,
      AUDIT_ACTIONS.USER_CREATED,
      AUDIT_ACTIONS.ROLE_ASSIGNED,
      AUDIT_ACTIONS.PERMISSION_CHANGED,
      AUDIT_ACTIONS.ORGANIZATION_CREATED,
      AUDIT_ACTIONS.CONFIGURATION_CHANGED,
    ]) {
      expect(typeof action).toBe('string');
      expect(action).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });
});

describe('recordChange', () => {
  it('stores only the fields that actually changed', async () => {
    const sink = new InMemoryAuditSink();
    const audit = new AuditService({ sink, now: () => FIXED_NOW });

    await audit.recordChange({
      action: AUDIT_ACTIONS.ORGANIZATION_UPDATED,
      entityType: AUDIT_ENTITY.ORGANIZATION,
      entityId: 'org_acme',
      before: { name: 'Acme', slug: 'acme', isActive: true },
      after: { name: 'Acme Holdings', slug: 'acme', isActive: true },
    });

    expect(sink.records[0]?.before).toEqual({ name: 'Acme' });
    expect(sink.records[0]?.after).toEqual({ name: 'Acme Holdings' });
  });
});

describe('diffEntities', () => {
  it('returns nulls when nothing changed', () => {
    expect(diffEntities({ a: 1 }, { a: 1 })).toEqual({ before: null, after: null });
  });

  it('keeps whole snapshots for creation and deletion', () => {
    expect(diffEntities(null, { a: 1 })).toEqual({ before: null, after: { a: 1 } });
    expect(diffEntities({ a: 1 }, null)).toEqual({ before: { a: 1 }, after: null });
  });

  it('compares dates and nested objects by value', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(diffEntities({ at: date, tags: ['a'] }, { at: new Date(date), tags: ['a'] })).toEqual({
      before: null,
      after: null,
    });

    expect(diffEntities({ tags: ['a'] }, { tags: ['a', 'b'] }).after).toEqual({ tags: ['a', 'b'] });
  });

  it('reports a field that appears or disappears', () => {
    expect(diffEntities({ a: 1 }, { a: 1, b: 2 })).toEqual({
      before: { b: null },
      after: { b: 2 },
    });
  });
});

describe('audit query scoping', () => {
  it('never returns another organization records for a scoped query', async () => {
    const sink = new InMemoryAuditSink();
    const audit = new AuditService({ sink, now: () => FIXED_NOW });

    await audit.record({
      action: AUDIT_ACTIONS.LOGIN,
      entityType: AUDIT_ENTITY.USER,
      organizationId: 'org_acme',
    });
    await audit.record({
      action: AUDIT_ACTIONS.LOGIN,
      entityType: AUDIT_ENTITY.USER,
      organizationId: 'org_rival',
    });

    const result = await audit.query({ organizationId: 'org_acme', page: 1, pageSize: 25 });
    expect(result.totalItems).toBe(1);
    expect(result.items[0]?.organizationId).toBe('org_acme');
  });
});

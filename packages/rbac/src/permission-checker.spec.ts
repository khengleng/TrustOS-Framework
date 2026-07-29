import { describe, expect, it } from 'vitest';
import type { ActorContext } from '@trustos/shared-types';
import type { ApiError } from '@trustos/errors';
import {
  assertPermissions,
  hasPermission,
  hasPermissions,
  permissionMatches,
  resolvePermissions,
} from './permission-checker';
import { PERMISSIONS } from './permissions';
import { SYSTEM_ROLES, canGrantRole } from './roles';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: 'user_1',
    email: 'ada@example.com',
    organizationId: 'org_1',
    roles: ['operator'],
    permissions: [PERMISSIONS.ORGANIZATION_READ.key, PERMISSIONS.MEMBER_READ.key],
    isSuperAdmin: false,
    tokenId: 'jti_1',
    ...overrides,
  };
}

describe('permissionMatches', () => {
  it('matches exactly, by resource wildcard, and by global wildcard', () => {
    expect(permissionMatches('audit.read', 'audit.read')).toBe(true);
    expect(permissionMatches('organization.*', 'organization.member.invite')).toBe(true);
    expect(permissionMatches('*', 'anything.at.all')).toBe(true);
  });

  it('does not let a prefix wildcard escape its resource', () => {
    expect(permissionMatches('organization.*', 'organizationsettings.read')).toBe(false);
    expect(permissionMatches('audit.read', 'audit.write')).toBe(false);
    expect(permissionMatches('audit.read', 'audit.read.all')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('denies when there is no actor', () => {
    expect(hasPermission(null, PERMISSIONS.ORGANIZATION_READ.key)).toBe(false);
  });

  it('grants everything to a super admin', () => {
    expect(hasPermission(actor({ isSuperAdmin: true, permissions: [] }), 'audit.read')).toBe(true);
  });

  it('denies a permission the actor does not hold', () => {
    expect(hasPermission(actor(), PERMISSIONS.MEMBER_REMOVE.key)).toBe(false);
  });
});

describe('hasPermissions', () => {
  it('requires all permissions by default', () => {
    expect(
      hasPermissions(actor(), [PERMISSIONS.ORGANIZATION_READ.key, PERMISSIONS.MEMBER_REMOVE.key]),
    ).toBe(false);
  });

  it('requires only one in "any" mode', () => {
    expect(
      hasPermissions(actor(), [PERMISSIONS.ORGANIZATION_READ.key, PERMISSIONS.MEMBER_REMOVE.key], {
        mode: 'any',
      }),
    ).toBe(true);
  });

  it('denies an empty requirement rather than treating it as "no requirement"', () => {
    expect(hasPermissions(actor(), [])).toBe(false);
  });
});

describe('assertPermissions', () => {
  it('raises unauthorized without an actor and forbidden with one', () => {
    expect(() => assertPermissions(null, ['audit.read'])).toThrowError(
      /Authentication is required/,
    );
    expect(() => assertPermissions(actor(), ['audit.read'])).toThrowError(/do not have permission/);
  });

  it('keeps the required-permission detail out of the client message', () => {
    try {
      assertPermissions(actor(), [PERMISSIONS.AUDIT_READ.key]);
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.message).not.toContain('audit.read');
      expect(apiError.context?.requiredPermissions).toEqual(['audit.read']);
    }
  });
});

describe('system roles', () => {
  it('grants the wildcard to super_admin only', () => {
    expect(SYSTEM_ROLES.super_admin.permissions).toEqual(['*']);
    for (const role of ['organization_owner', 'administrator', 'operator', 'auditor'] as const) {
      expect(SYSTEM_ROLES[role].permissions).not.toContain('*');
    }
  });

  it('keeps read-only roles read-only', () => {
    const writeish = /\.(create|update|invite|remove|assign|revoke|manage)$/;
    for (const role of ['operator', 'auditor'] as const) {
      expect(SYSTEM_ROLES[role].permissions.filter((key) => writeish.test(key))).toEqual([]);
    }
  });

  it('never grants platform.admin to an organization role', () => {
    for (const role of ['organization_owner', 'administrator', 'operator', 'auditor'] as const) {
      expect(SYSTEM_ROLES[role].permissions).not.toContain(PERMISSIONS.PLATFORM_ADMIN.key);
    }
  });

  it('gives the auditor read access to the trail and nothing else', () => {
    expect(SYSTEM_ROLES.auditor.permissions).toContain(PERMISSIONS.AUDIT_READ.key);
    expect(SYSTEM_ROLES.auditor.permissions).not.toContain(PERMISSIONS.MEMBER_INVITE.key);
  });
});

describe('canGrantRole', () => {
  it('stops an administrator escalating anyone to owner or administrator', () => {
    expect(canGrantRole(['administrator'], 'organization_owner')).toBe(false);
    expect(canGrantRole(['administrator'], 'administrator')).toBe(false);
    expect(canGrantRole(['administrator'], 'operator')).toBe(true);
  });

  it('lets an owner grant any organization role', () => {
    expect(canGrantRole(['organization_owner'], 'administrator')).toBe(true);
    expect(canGrantRole(['organization_owner'], 'organization_owner')).toBe(true);
  });

  it('grants nothing to roles with no grant rights', () => {
    expect(canGrantRole(['operator'], 'auditor')).toBe(false);
    expect(canGrantRole(['auditor'], 'auditor')).toBe(false);
    expect(canGrantRole([], 'operator')).toBe(false);
    expect(canGrantRole(['not_a_role'], 'operator')).toBe(false);
  });
});

describe('resolvePermissions', () => {
  it('merges and de-duplicates role permission sets', () => {
    expect(
      resolvePermissions([
        { name: 'a', permissions: ['audit.read', 'organization.read'] },
        { name: 'b', permissions: ['organization.read', 'user.read'] },
      ]),
    ).toEqual(['audit.read', 'organization.read', 'user.read']);
  });
});

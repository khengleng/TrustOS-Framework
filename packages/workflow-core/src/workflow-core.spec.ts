import { describe, expect, it } from 'vitest';
import type { ActorContext } from '@trustos/shared-types';
import {
  ALL_WORKFLOW_PERMISSION_KEYS,
  INCOMPATIBLE_GRANT_PAIRS,
  SUGGESTED_WORKFLOW_ROLE_GRANTS,
  TERMINAL_CASE_STATUSES,
  TERMINAL_TASK_STATUSES,
  WORKFLOW_PERMISSIONS,
  actorHasAnyPermission,
  actorHasPermission,
  findIncompatibleGrants,
  isSameActor,
  toWorkflowActor,
} from './index';

/**
 * `workflow-core` holds types and a handful of pure functions, so most of it is checked by the
 * compiler. What is worth a test is the small amount that is *policy* rather than shape — the
 * grant matrix and the actor comparison — because both are one careless edit away from turning a
 * control off with no other symptom.
 */

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorType: 'user',
    userId: 'user_a',
    email: 'a@acme.test',
    organizationId: 'org_acme',
    roles: ['workflow_maker'],
    permissions: [WORKFLOW_PERMISSIONS.INSTANCE_START.key],
    isSuperAdmin: false,
    tokenId: 'tok',
    ...overrides,
  };
}

describe('the suggested role grants', () => {
  it('never give one role both halves of a separation-of-duty pair', () => {
    /*
     * The assertion `docs/maker-checker.md` promises.
     *
     * `allowSelfApproval: false` protects one *instance* from its own submitter. This protects the
     * *population*: a role holding both `instance.start` and `approval.decide` means every holder
     * is both maker and checker, and no per-instance check helps when there is only one of them.
     *
     * An edit that gave `workflow_author` the approve grant would fail here rather than ship.
     */
    const findings = findIncompatibleGrants(SUGGESTED_WORKFLOW_ROLE_GRANTS);

    expect(
      findings,
      findings.map((f) => `${f.role} holds both ${f.permissions.join(' and ')}`).join('; '),
    ).toEqual([]);
  });

  it('keeps the maker away from approving and the checker away from starting', () => {
    const maker = SUGGESTED_WORKFLOW_ROLE_GRANTS.workflow_maker ?? [];
    const checker = SUGGESTED_WORKFLOW_ROLE_GRANTS.workflow_checker ?? [];

    expect(maker).not.toContain(WORKFLOW_PERMISSIONS.APPROVAL_DECIDE.key);
    expect(checker).not.toContain(WORKFLOW_PERMISSIONS.INSTANCE_START.key);
  });

  it('keeps the author away from approving and publishing their own definitions', () => {
    // The control that stops the whole engine being circumvented: an author who could also publish
    // could ship `allowSelfApproval: true` and approve their own requests through it.
    const author = SUGGESTED_WORKFLOW_ROLE_GRANTS.workflow_author ?? [];

    expect(author).not.toContain(WORKFLOW_PERMISSIONS.DEFINITION_APPROVE.key);
    expect(author).not.toContain(WORKFLOW_PERMISSIONS.DEFINITION_PUBLISH.key);
  });

  it('keeps the administrator away from authoring and from deciding', () => {
    const admin = SUGGESTED_WORKFLOW_ROLE_GRANTS.workflow_administrator ?? [];

    expect(admin).not.toContain(WORKFLOW_PERMISSIONS.DEFINITION_CREATE.key);
    expect(admin).not.toContain(WORKFLOW_PERMISSIONS.APPROVAL_DECIDE.key);
  });

  it('grants only permissions that exist', () => {
    // A misspelled key in a role grant is a permission nobody holds, and the symptom is a 403 that
    // looks like a policy problem.
    for (const [role, permissions] of Object.entries(SUGGESTED_WORKFLOW_ROLE_GRANTS)) {
      for (const permission of permissions) {
        expect(ALL_WORKFLOW_PERMISSION_KEYS, `${role} → ${permission}`).toContain(permission);
      }
    }
  });

  it('reports a role that does hold an incompatible pair', () => {
    // The check has to actually fire, or the assertion above proves nothing.
    const findings = findIncompatibleGrants({
      does_everything: [
        WORKFLOW_PERMISSIONS.INSTANCE_START.key,
        WORKFLOW_PERMISSIONS.APPROVAL_DECIDE.key,
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.role).toBe('does_everything');
  });

  it('exempts super_admin and the wildcard', () => {
    // Platform-wide power is governed by who is given it, not by which pairs it avoids.
    expect(findIncompatibleGrants({ super_admin: ['*'] })).toEqual([]);
    expect(findIncompatibleGrants({ anything: ['*'] })).toEqual([]);
  });

  it('names a small, reviewable set of incompatible pairs', () => {
    // Separation of duties is a few rules applied consistently, not a large table of special
    // cases. A list that grew past a dozen would be one nobody reads.
    expect(INCOMPATIBLE_GRANT_PAIRS.length).toBeLessThanOrEqual(8);
  });
});

describe('the permission catalog', () => {
  it('has a unique key and a description for every entry', () => {
    const keys = ALL_WORKFLOW_PERMISSION_KEYS;
    expect(new Set(keys).size).toBe(keys.length);

    for (const permission of Object.values(WORKFLOW_PERMISSIONS)) {
      expect(permission.description.length, permission.key).toBeGreaterThan(10);
    }
  });

  it('splits read from write everywhere it matters', () => {
    // An auditor needs to see what exists without being able to change it, and an incident
    // responder needs to act without being able to author.
    for (const resource of ['definition', 'instance', 'task', 'comment', 'attachment', 'sla']) {
      const keys = ALL_WORKFLOW_PERMISSION_KEYS.filter((key) => key.includes(`.${resource}.`));
      expect(
        keys.some((key) => key.endsWith('.read')),
        resource,
      ).toBe(true);
      expect(keys.length, resource).toBeGreaterThan(1);
    }
  });
});

describe('the actor projection', () => {
  it('carries the fields resolved server-side and nothing else', () => {
    const projected = toWorkflowActor(actor({ roles: ['a'], permissions: ['b'] }));

    expect(projected).toMatchObject({
      userId: 'user_a',
      organizationId: 'org_acme',
      roles: ['a'],
      permissions: ['b'],
    });

    /*
     * The absences are the point. There is no `submittedBy`, no `approvalStatus` and no
     * `taskOwner`, because none of those may come from a caller — and a projection that had a
     * field for one would eventually be populated from a request body.
     */
    expect(projected).not.toHaveProperty('submittedBy');
    expect(projected).not.toHaveProperty('approvalStatus');
    expect(projected).not.toHaveProperty('taskOwner');
    expect(projected).not.toHaveProperty('currentState');
  });

  it('refuses an actor with no organization', () => {
    // A workflow operation with no tenant is a query with no WHERE clause. The check is here
    // rather than at every call site, because there are dozens of call sites and one would forget.
    expect(() => toWorkflowActor(actor({ organizationId: null }))).toThrow(/needs an organization/);
  });
});

describe('permission checks', () => {
  it('honour the wildcard', () => {
    expect(actorHasPermission(toWorkflowActor(actor({ permissions: ['*'] })), 'anything')).toBe(
      true,
    );
  });

  it('are exact otherwise', () => {
    const projected = toWorkflowActor(actor({ permissions: ['workflow.instance.start'] }));

    expect(actorHasPermission(projected, 'workflow.instance.start')).toBe(true);
    // No prefix matching. `workflow.instance` must not imply `workflow.instance.cancel`.
    expect(actorHasPermission(projected, 'workflow.instance.cancel')).toBe(false);
    expect(actorHasPermission(projected, 'workflow.instance')).toBe(false);
  });

  it('treat an empty requirement list as no', () => {
    expect(actorHasAnyPermission(toWorkflowActor(actor()), [])).toBe(false);
  });
});

describe('actor comparison', () => {
  it('matches the same id', () => {
    expect(isSameActor('user_a', 'user_a')).toBe(true);
    expect(isSameActor('user_a', 'user_b')).toBe(false);
  });

  it('never treats two absent ids as the same actor', () => {
    /*
     * The subtle one, and the reason this is a named function rather than `===` at thirty call
     * sites.
     *
     * A system-initiated workflow has no initiator. Treating "nobody" as matching "nobody" would
     * silently disable the self-approval check on exactly the instances where the bug would be
     * hardest to see.
     */
    expect(isSameActor(null, null)).toBe(false);
    expect(isSameActor(undefined, undefined)).toBe(false);
    expect(isSameActor('', '')).toBe(false);
    expect(isSameActor('user_a', null)).toBe(false);
  });
});

describe('terminal states', () => {
  it('name every status from which no further work is possible', () => {
    expect([...TERMINAL_TASK_STATUSES].sort()).toEqual([
      'cancelled',
      'completed',
      'expired',
      'rejected',
    ]);
    expect([...TERMINAL_CASE_STATUSES].sort()).toEqual(['cancelled', 'closed']);
  });

  it('does not include a status that is still workable', () => {
    // `resolved` is deliberately absent: a resolved case reopens when the resolution turns out to
    // be wrong, and treating it as terminal would force a duplicate case.
    expect(TERMINAL_CASE_STATUSES).not.toContain('resolved');
    expect(TERMINAL_TASK_STATUSES).not.toContain('claimed');
  });
});

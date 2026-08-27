import { describe, expect, it } from 'vitest';
import {
  actorAuditMetadata,
  assertTenantResolved,
  authenticationLevelFrom,
  mapGroupsToRoles,
  normalizeActor,
} from './index';

const GROUP_MAP = { 'okta-finance': 'finance', 'okta-risk': 'risk' };

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'usr_7',
    iss: 'https://sso.example.test',
    sid: 'ses_1',
    amr: ['pwd'],
    groups: ['okta-finance'],
    name: 'A Person',
    email: 'a.person@example.test',
    ...overrides,
  };
}

async function normalize(
  overrides: Record<string, unknown> = {},
  organizationId: string | null = 'org_a',
) {
  return normalizeActor({
    claims: claims(overrides),
    groupRoleMap: GROUP_MAP,
    resolveOrganization: async () => organizationId,
    allowedIssuers: ['https://sso.example.test'],
  });
}

describe('normalizing an enterprise identity', () => {
  it('returns an empty permission list, always', async () => {
    const { actor } = await normalize({
      permissions: ['financial.product.publish'],
      roles: ['admin'],
    });

    // Permissions are resolved per request from the membership tables. Returning them here would
    // make the token the authorization decision.
    expect(actor.permissions).toEqual([]);
  });

  it('never reads the organization from a claim', async () => {
    const { actor } = await normalize(
      { organization: 'org_someone_else', org_id: 'org_b' },
      'org_a',
    );
    expect(actor.organizationId).toBe('org_a');
  });

  it('refuses a token from an issuer this deployment does not accept', async () => {
    await expect(
      normalizeActor({
        claims: claims({ iss: 'https://attacker.example.test' }),
        groupRoleMap: GROUP_MAP,
        resolveOrganization: async () => 'org_a',
        allowedIssuers: ['https://sso.example.test'],
      }),
    ).rejects.toThrow(/does not accept/);
  });

  it('maps groups explicitly and reports what it could not map', async () => {
    const { actor, unmappedGroups } = await normalize({
      groups: ['okta-finance', 'finance-team-v2'],
    });

    expect(actor.roles).toEqual(['finance']);
    // A provider that starts emitting a new group name should produce a visible gap, not a
    // silent loss of access — and certainly not a silent gain.
    expect(unmappedGroups).toEqual(['finance-team-v2']);
  });

  it('has no fallback role for an unmapped group', () => {
    expect(mapGroupsToRoles(['unknown-group'], GROUP_MAP).roles).toEqual([]);
  });

  it('guesses authentication strength downward, never upward', () => {
    expect(authenticationLevelFrom(claims({ amr: ['pwd'] }) as never)).toBe('password');
    expect(authenticationLevelFrom(claims({ amr: ['otp'] }) as never)).toBe('mfa');
    expect(authenticationLevelFrom(claims({ amr: ['hwk'] }) as never)).toBe('strong');
    // An unrecognised method reads as the weakest, so the assurance guard is not fooled by a
    // provider adding a method name nobody has mapped.
    expect(authenticationLevelFrom(claims({ amr: ['some-new-method'] }) as never)).toBe('password');
    expect(authenticationLevelFrom(claims({ amr: undefined }) as never)).toBe('password');
  });

  it('carries the issuer and session for the audit record', async () => {
    const { actor } = await normalize();
    const metadata = actorAuditMetadata(actor);

    expect(metadata.issuer).toBe('https://sso.example.test');
    expect(metadata.sessionId).toBe('ses_1');
    // An audit record is not a directory.
    expect(metadata.email).toBeUndefined();
    expect(metadata.displayName).toBeUndefined();
  });

  it('refuses an actor who belongs to no organization', async () => {
    const { actor } = await normalize({}, null);
    expect(() => assertTenantResolved(actor)).toThrow(/belong to no organization/);
  });

  it('returns the organization when one resolves', async () => {
    const { actor } = await normalize();
    expect(assertTenantResolved(actor)).toBe('org_a');
  });

  it('ignores claims it does not know rather than failing on them', async () => {
    // A provider adds claims for its own reasons; a normalizer that failed on an unknown one
    // would break on a provider upgrade.
    await expect(normalize({ some_new_claim: 'value' })).resolves.toBeDefined();
  });
});

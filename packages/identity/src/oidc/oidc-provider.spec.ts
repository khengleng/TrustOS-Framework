import { describe, expect, it } from 'vitest';
import type { ApiError } from '@trustos/errors';
import { securityPolicySchema } from '@trustos/security-policy';
import {
  algNoneToken,
  createTestIdentityKeys,
  expiredToken,
  notYetValidToken,
  signTestToken,
  signedByAnotherKey,
  tamperedPayload,
  wrongAudience,
  wrongIssuer,
  type TestIdentityProviderKeys,
} from '@trustos/security-testing';
import { OidcIdentityProvider } from './oidc-provider';

/**
 * Token validation.
 *
 * Every test below is a token that is *almost* right. That is the whole value of the
 * file: an implementation that decodes without verifying, or that skips the issuer,
 * or that accepts any algorithm, passes a happy-path suite perfectly.
 */

const ISSUER = 'https://idp.test/realms/trustos';
const CLIENT_ID = 'trustos-api';

const policy = securityPolicySchema.parse({ environment: 'test' });

async function buildProvider(keys: TestIdentityProviderKeys, overrides = {}) {
  return new OidcIdentityProvider(
    {
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      fetchJwks: keys.jwks,
      roleMap: {
        'trustos-admin': 'administrator',
        'trustos-operator': 'operator',
        '/engineering': 'operator',
      },
      superAdminRoles: ['platform-staff'],
      organizationClaim: 'organization_id',
      ...overrides,
    },
    policy.tokens,
    policy.mfa,
  );
}

describe('a correct token', () => {
  it('verifies and produces an identity', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const token = await signTestToken(keys, {
      subject: 'user_ada',
      email: 'ada@example.test',
      realmRoles: ['trustos-admin'],
      jti: 'jti_1',
    });

    const identity = await provider.validateAccessToken(token);

    expect(identity.subject).toBe('user_ada');
    expect(identity.email).toBe('ada@example.test');
    expect(identity.providerRoles).toContain('trustos-admin');
    expect(identity.tokenId).toBe('jti_1');
    expect(identity.issuer).toBe(ISSUER);
    expect(identity.provider).toBe('oidc');
  });
});

describe('rejecting a token that is almost right', () => {
  it('refuses a token whose payload was edited after signing', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const token = await signTestToken(keys, { subject: 'user_ada' });
    // The classic: an implementation that decodes rather than verifies accepts this
    // and grants whatever the edited claims say.
    const tampered = tamperedPayload(token, {
      sub: 'user_admin',
      realm_access: { roles: ['admin'] },
    });

    await expect(provider.validateAccessToken(tampered)).rejects.toThrow();
  });

  it('refuses a token from another issuer', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // Correctly signed by the same key, wrong `iss`. Without the issuer check, any
    // provider whose keys are fetchable is trusted.
    await expect(provider.validateAccessToken(await wrongIssuer(keys))).rejects.toThrow();
  });

  it('refuses a token minted for another service in the same realm', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // The mistake that turns one compromised low-value client into access
    // everywhere.
    await expect(provider.validateAccessToken(await wrongAudience(keys))).rejects.toThrow();
  });

  it('refuses a token whose authorized party is another client', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // Keycloak issues tokens whose `aud` is a resource server while `azp` names the
    // requesting client. Checking only `aud` accepts a token minted for a different
    // client against the same resource server.
    const token = await signTestToken(keys, {
      audience: CLIENT_ID,
      authorizedParty: 'some-other-client',
    });

    await expect(provider.validateAccessToken(token)).rejects.toThrow();
  });

  it('refuses an expired token', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    await expect(provider.validateAccessToken(await expiredToken(keys))).rejects.toThrow();
  });

  it('refuses a token that is not valid yet', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    await expect(provider.validateAccessToken(await notYetValidToken(keys))).rejects.toThrow();
  });

  it('refuses a token signed by a key the provider does not publish', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // An attacker with their own key pair, everything else correct.
    await expect(provider.validateAccessToken(await signedByAnotherKey())).rejects.toThrow();
  });

  it('refuses an unsigned token claiming alg: none', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // The oldest JWT bypass there is, and it still works against any implementation
    // that does not pin the algorithm list.
    await expect(provider.validateAccessToken(algNoneToken())).rejects.toThrow();
  });

  it('refuses a correctly signed token that carries no subject', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // An implementation that assumes `sub` is present derives an actor with an empty
    // id, which then matches nothing — or everything, depending on the query.
    const token = await signTestToken(keys, { omitSubject: true });

    await expect(provider.validateAccessToken(token)).rejects.toThrow();
  });

  it('says only that the token did not work', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    try {
      await provider.validateAccessToken(await wrongAudience(keys));
      expect.unreachable('should have thrown');
    } catch (error) {
      // Which of the four checks failed is operator detail. Telling a caller is how a
      // token gets iteratively repaired.
      expect((error as ApiError).code).toBe('unauthorized');
      expect((error as ApiError).message).not.toMatch(/audience|issuer|signature/i);
      expect((error as ApiError).context?.reason).toBe('oidc_token_rejected');
    }
  });
});

describe('authentication assurance', () => {
  it('reports high assurance for a multi-factor acr', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { acr: 'gold', amr: ['pwd', 'otp'] }),
    );

    expect(identity.authentication.mfa).toBe(true);
    expect(identity.authentication.level).toBe('high');
  });

  it('reports high assurance for a multi-factor amr alone', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { amr: ['pwd', 'webauthn'] }),
    );

    expect(identity.authentication.mfa).toBe(true);
  });

  it('reports medium for a single factor', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { amr: ['pwd'] }),
    );

    expect(identity.authentication.mfa).toBe(false);
    expect(identity.authentication.level).toBe('medium');
  });

  it('reports low for an acr the deployment has not configured', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // "The framework does not know what happened" reads safely only one way.
    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { acr: 'something-bespoke' }),
    );

    expect(identity.authentication.mfa).toBe(false);
    expect(identity.authentication.level).toBe('low');
  });
});

describe('role mapping', () => {
  it('maps realm and client roles onto TrustOS roles', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const identity = await provider.validateAccessToken(
      await signTestToken(keys, {
        realmRoles: ['trustos-admin'],
        clientRoles: { [CLIENT_ID]: ['trustos-operator'] },
      }),
    );

    const mapping = provider.mapRoles(identity);
    expect(mapping.roles).toEqual(['administrator', 'operator']);
  });

  it('maps a group, stripping the leading slash Keycloak adds', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { groups: ['/engineering'] }),
    );

    expect(provider.mapRoles(identity).roles).toEqual(['operator']);
  });

  it('does not pass an unmapped provider role through as a TrustOS role', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // A provider that could name a TrustOS role directly could grant `super_admin`
    // by adding a realm role.
    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { realmRoles: ['super_admin', 'organization_owner'] }),
    );

    const mapping = provider.mapRoles(identity);
    expect(mapping.roles).toEqual([]);
    expect(mapping.isSuperAdmin).toBe(false);
    // Reported, so the misconfiguration is fixable rather than silently ignored.
    expect(mapping.unmapped).toEqual(['organization_owner', 'super_admin']);
  });

  it('recognises platform staff only through the configured role', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { realmRoles: ['platform-staff'] }),
    );

    expect(provider.mapRoles(identity).isSuperAdmin).toBe(true);
  });

  it('reads the organization from the configured claim, not from a header', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const identity = await provider.validateAccessToken(
      await signTestToken(keys, { extra: { organization_id: 'org_acme' } }),
    );

    expect(provider.mapRoles(identity).organizationId).toBe('org_acme');
  });
});

describe('unsupported operations', () => {
  it('refuses password authentication rather than offering a weaker path', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // With OIDC the browser authenticates against the provider directly and this
    // service never sees a password. A provider that quietly accepted one would be an
    // invitation to build a second, weaker login beside the real one.
    await expect(
      provider.authenticate(
        { email: 'ada@example.test', password: 'irrelevant' },
        { ipAddress: null, userAgent: null, requestId: null },
      ),
    ).rejects.toThrow(/authorization code flow/);
  });

  it('says so when it cannot revoke centrally, rather than reporting success', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    // An administrator who clicks "revoke" and gets a success they did not earn is
    // worse off than one who is told to use the provider.
    expect(provider.supportsCentralSessionRevocation).toBe(false);
    await expect(provider.revokeSessions('user_ada')).rejects.toThrow(/no back-channel/i);
  });

  it('builds an end-session URL when one is configured', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys, {
      endSessionEndpoint: `${ISSUER}/protocol/openid-connect/logout`,
    });

    const url = provider.endSessionUrl({
      idTokenHint: 'id-token',
      postLogoutRedirectUri: 'https://app.test/signed-out',
    });

    expect(url).toContain('id_token_hint=id-token');
    expect(url).toContain('post_logout_redirect_uri=https%3A%2F%2Fapp.test%2Fsigned-out');
  });
});

describe('health', () => {
  it('reports ok before any token is validated, without probing the provider', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const health = await provider.health();
    expect(health.ok).toBe(true);
    expect(health.metadata).toMatchObject({ issuer: ISSUER, clientId: CLIENT_ID });
  });

  it('degrades after repeated verification failures', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await provider.validateAccessToken(algNoneToken()).catch(() => undefined);
    }

    expect((await provider.health()).ok).toBe(false);
  });

  it('never puts a key or a discovery document in its health detail', async () => {
    const keys = await createTestIdentityKeys();
    const provider = await buildProvider(keys);

    const health = await provider.health();
    expect(JSON.stringify(health)).not.toContain('BEGIN');
    expect(JSON.stringify(health)).not.toContain(keys.publicJwk.n ?? 'modulus');
  });
});

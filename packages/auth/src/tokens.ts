import { createHash, randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { ApiError } from '@trustos/errors';
import type { AppConfig } from '@trustos/config';

/**
 * Access-token claims.
 *
 * Kept small: a JWT travels in a header on every request, and every claim is
 * a value that cannot be revoked until the token expires. `perms` is the
 * exception — carrying the resolved permission set removes a database round
 * trip from every authorized request, at the cost of a 15-minute window where
 * a revoked permission still works. That trade is documented in
 * docs/security-standards.md; shorten `ACCESS_TOKEN_TTL` to narrow it.
 */
export interface AccessTokenClaims extends JwtPayload {
  sub: string;
  email: string;
  /** Selected organization, or null before one is chosen. */
  org: string | null;
  roles: string[];
  perms: string[];
  /** isSuperAdmin */
  sa: boolean;
  /** Token version, for bulk revocation. */
  tv: number;
  jti: string;
}

export interface RefreshTokenClaims extends JwtPayload {
  sub: string;
  /** Rotation family id. */
  fam: string;
  /**
   * Selected organization, carried so a refresh preserves the user's context
   * instead of dropping them back to the organization picker. Membership is
   * re-verified against the database on every refresh, so a stale claim here
   * grants nothing.
   */
  org: string | null;
  tv: number;
  jti: string;
}

export interface IssueAccessTokenInput {
  userId: string;
  email: string;
  organizationId: string | null;
  roles: string[];
  permissions: string[];
  isSuperAdmin: boolean;
  tokenVersion: number;
}

export interface IssuedToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

/**
 * Signs and verifies the two token types.
 *
 * Access and refresh tokens are signed with *different* secrets so that a leak
 * of the access-token key does not let an attacker mint refresh tokens, which
 * are long-lived. `@trustos/config` refuses to boot production if the two
 * secrets match.
 */
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(config: AppConfig) {
    this.accessSecret = config.auth.jwtSecret;
    this.refreshSecret = config.auth.jwtRefreshSecret;
    this.issuer = config.auth.issuer;
    this.audience = config.auth.audience;
    this.accessTtlSeconds = config.auth.accessTokenTtlSeconds;
    this.refreshTtlSeconds = config.auth.refreshTokenTtlSeconds;
  }

  get accessTokenTtlSeconds(): number {
    return this.accessTtlSeconds;
  }

  get refreshTokenTtlSeconds(): number {
    return this.refreshTtlSeconds;
  }

  issueAccessToken(input: IssueAccessTokenInput): IssuedToken {
    const jti = randomUUID();
    const token = jwt.sign(
      {
        email: input.email,
        org: input.organizationId,
        roles: input.roles,
        perms: input.permissions,
        sa: input.isSuperAdmin,
        tv: input.tokenVersion,
      },
      this.accessSecret,
      {
        subject: input.userId,
        jwtid: jti,
        issuer: this.issuer,
        audience: this.audience,
        expiresIn: this.accessTtlSeconds,
        algorithm: 'HS256',
      },
    );
    return { token, jti, expiresAt: new Date(Date.now() + this.accessTtlSeconds * 1000) };
  }

  issueRefreshToken(input: {
    userId: string;
    familyId: string;
    organizationId: string | null;
    tokenVersion: number;
  }): IssuedToken {
    const jti = randomUUID();
    const claims = { fam: input.familyId, org: input.organizationId, tv: input.tokenVersion };
    const token = jwt.sign(claims, this.refreshSecret, {
      subject: input.userId,
      jwtid: jti,
      issuer: this.issuer,
      audience: this.audience,
      expiresIn: this.refreshTtlSeconds,
      algorithm: 'HS256',
    });
    return { token, jti, expiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000) };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    return this.verify<AccessTokenClaims>(token, this.accessSecret);
  }

  verifyRefreshToken(token: string): RefreshTokenClaims {
    return this.verify<RefreshTokenClaims>(token, this.refreshSecret);
  }

  private verify<T extends JwtPayload>(token: string, secret: string): T {
    try {
      // `algorithms` is pinned: without it, a token signed with "none" (or with
      // a public key treated as an HMAC secret) would be accepted.
      return jwt.verify(token, secret, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['HS256'],
      }) as T;
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown';
      // The caller learns only that the token did not work. Whether it expired,
      // was signed with the wrong key, or was truncated is operator detail.
      throw ApiError.unauthorized(undefined, { reason: `token_${reason}` });
    }
  }
}

/**
 * Hash used to store a refresh token.
 *
 * SHA-256 rather than bcrypt: the token is 200+ bits of server-generated
 * entropy, so it is not brute-forcible and does not need a slow KDF — and the
 * refresh path would otherwise pay bcrypt's cost on every call.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

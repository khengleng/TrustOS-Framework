/**
 * Storage ports.
 *
 * `AuthService` is written against these interfaces rather than against
 * Prisma, for two reasons: the authentication rules can be tested exhaustively
 * with in-memory fakes (no database, no fixtures, no flake), and a product that
 * stores users elsewhere can reuse the same logic. The Prisma implementations
 * live in `prisma-auth-store.ts`.
 */

export interface AuthUserRecord {
  id: string;
  email: string;
  /**
   * Null for an account provisioned through an identity provider.
   *
   * Such an account has no local password and must not be able to sign in with one.
   * `AuthService.login` refuses a null hash with the same message a wrong password
   * gets, so the response does not reveal which kind of account an address belongs to.
   */
  passwordHash: string | null;
  displayName: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  tokenVersion: number;
  deletedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName: string | null;
}

export interface AuthUserStore {
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findById(userId: string): Promise<AuthUserRecord | null>;
  create(input: CreateUserInput): Promise<AuthUserRecord>;
  recordLogin(userId: string, at: Date): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  /** Invalidates every token already issued for the user. */
  incrementTokenVersion(userId: string): Promise<number>;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface SaveRefreshTokenInput {
  tokenHash: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export type RevocationReason =
  'rotated' | 'logout' | 'reuse_detected' | 'admin' | 'password_change';

export interface RefreshTokenStore {
  save(input: SaveRefreshTokenInput): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  revoke(tokenHash: string, reason: RevocationReason, replacedByHash?: string): Promise<void>;
  /** Revokes every token in a rotation family — the response to token reuse. */
  revokeFamily(familyId: string, reason: RevocationReason): Promise<void>;
  revokeAllForUser(userId: string, reason: RevocationReason): Promise<void>;
}

/** Organization membership and effective access, resolved at token-issue time. */
export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  organizationIsActive: boolean;
  organizationCreatedAt: Date;
  organizationUpdatedAt: Date;
  roles: string[];
  permissions: string[];
}

export interface MembershipResolver {
  /** Active memberships, used to populate the organization picker. */
  listMemberships(userId: string): Promise<MembershipSummary[]>;
  /**
   * Roles and permissions for one organization, or null if the user is not an
   * active member. Called every time a token is minted — membership is
   * verified at issue time, so later requests can trust the token's `org`.
   */
  resolveAccess(userId: string, organizationId: string): Promise<MembershipSummary | null>;
}

/** Metadata about the HTTP request that triggered an auth operation. */
export interface AuthRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export const EMPTY_REQUEST_META: AuthRequestMeta = {
  ipAddress: null,
  userAgent: null,
  requestId: null,
};

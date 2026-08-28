import type {
  AuthenticatedUser,
  OrganizationMemberSummary,
  OrganizationSummary,
  RoleSummary,
} from './entities';

/**
 * Request/response contracts shared by the example API and the admin app.
 *
 * Product apps should extend these in their own module rather than editing
 * them in place — see docs/coding-standards.md, "API compatibility".
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName?: string;
  /** Optional: create an organization and make the new user its owner. */
  organizationName?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface AuthResponse extends AuthenticatedUser {
  tokens: TokenPair;
}

export interface CreateOrganizationRequest {
  name: string;
  slug?: string;
}

export interface InviteMemberRequest {
  email: string;
  roleName: string;
}

export interface AssignRoleRequest {
  roleName: string;
}

export interface OrganizationResponse {
  organization: OrganizationSummary;
}

export interface MembersResponse {
  members: OrganizationMemberSummary[];
}

export interface RolesResponse {
  roles: RoleSummary[];
}

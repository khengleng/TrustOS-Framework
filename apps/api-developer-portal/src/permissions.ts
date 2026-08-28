/**
 * Portal permissions.
 *
 * Four, and the split is between what a developer does and what somebody inside the platform does
 * on their behalf. `REQUEST_ACCESS` and `APPROVE_ACCESS` are never held by the same person, which
 * is the whole reason production access is a request rather than a button.
 */
export interface PortalPermission {
  key: string;
  description: string;
}

const define = (key: string, description: string): PortalPermission => ({ key, description });

export const PORTAL_PERMISSIONS = {
  READ: define('portal.read', 'Browse the catalog this viewer may see, and their own usage.'),
  REGISTER: define('portal.register', 'Register as a developer and receive sandbox credentials.'),
  REQUEST_ACCESS: define('portal.access.request', 'Request access to an API.'),
  /** Held inside the platform, never by the requester. */
  APPROVE_ACCESS: define('portal.access.approve', 'Approve or reject an access request.'),
} as const;

/** A role holding both halves grants itself production API access. */
export const SEGREGATED_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  [PORTAL_PERMISSIONS.REQUEST_ACCESS.key, PORTAL_PERMISSIONS.APPROVE_ACCESS.key],
]);

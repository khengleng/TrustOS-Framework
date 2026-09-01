/**
 * TrustOS Wallet — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const WALLET_PERMISSIONS = {
  WALLET_PROFILE_READ: definePermission('wallet.wallet-profile.read', 'View wallets.'),
  WALLET_PROFILE_CREATE: definePermission('wallet.wallet-profile.create', 'Create wallet.'),
  WALLET_PROFILE_UPDATE: definePermission('wallet.wallet-profile.update', 'Modify wallet.'),
  WALLET_TRANSFER_READ: definePermission('wallet.wallet-transfer.read', 'View transfers.'),
  WALLET_TRANSFER_CREATE: definePermission('wallet.wallet-transfer.create', 'Create transfer.'),
  WALLET_TRANSFER_UPDATE: definePermission('wallet.wallet-transfer.update', 'Modify transfer.'),
  TRANSFER_LIMIT_PROFILE_READ: definePermission(
    'wallet.transfer-limit-profile.read',
    'View limit profiles.',
  ),
  TRANSFER_LIMIT_PROFILE_CREATE: definePermission(
    'wallet.transfer-limit-profile.create',
    'Create limit profile.',
  ),
  TRANSFER_LIMIT_PROFILE_UPDATE: definePermission(
    'wallet.transfer-limit-profile.update',
    'Modify limit profile.',
  ),
} as const;

export const WALLET_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(WALLET_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  WALLET_PERMISSIONS.WALLET_PROFILE_READ.key,
  WALLET_PERMISSIONS.WALLET_TRANSFER_READ.key,
  WALLET_PERMISSIONS.TRANSFER_LIMIT_PROFILE_READ.key,
];

const WRITE = [
  WALLET_PERMISSIONS.WALLET_PROFILE_CREATE.key,
  WALLET_PERMISSIONS.WALLET_PROFILE_UPDATE.key,
  WALLET_PERMISSIONS.WALLET_TRANSFER_CREATE.key,
  WALLET_PERMISSIONS.WALLET_TRANSFER_UPDATE.key,
  WALLET_PERMISSIONS.TRANSFER_LIMIT_PROFILE_CREATE.key,
  WALLET_PERMISSIONS.TRANSFER_LIMIT_PROFILE_UPDATE.key,
];

export const WALLET_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: WALLET_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type WalletTier = 'BASIC' | 'VERIFIED' | 'PREMIUM';
export const WALLET_TIER_VALUES: WalletTier[] = ['BASIC', 'VERIFIED', 'PREMIUM'];

export type WalletProfileStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';
export const WALLET_PROFILE_STATUS_VALUES: WalletProfileStatus[] = ['ACTIVE', 'FROZEN', 'CLOSED'];

export type TransferStatus = 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';
export const TRANSFER_STATUS_VALUES: TransferStatus[] = ['PENDING', 'POSTED', 'FAILED', 'REVERSED'];

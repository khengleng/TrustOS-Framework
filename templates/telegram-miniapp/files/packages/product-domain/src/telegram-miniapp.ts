/**
 * TrustOS Telegram Mini App — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const TELEGRAM_MINIAPP_PERMISSIONS = {
  MINI_APP_USER_READ: definePermission('telegramminiapp.mini-app-user.read', 'View users.'),
  MINI_APP_USER_CREATE: definePermission('telegramminiapp.mini-app-user.create', 'Create user.'),
  MINI_APP_USER_UPDATE: definePermission('telegramminiapp.mini-app-user.update', 'Modify user.'),
  MINI_APP_SESSION_READ: definePermission(
    'telegramminiapp.mini-app-session.read',
    'View sessions.',
  ),
  MINI_APP_SESSION_CREATE: definePermission(
    'telegramminiapp.mini-app-session.create',
    'Create session.',
  ),
  MINI_APP_SESSION_UPDATE: definePermission(
    'telegramminiapp.mini-app-session.update',
    'Modify session.',
  ),
  DEEP_LINK_READ: definePermission('telegramminiapp.deep-link.read', 'View deep links.'),
  DEEP_LINK_CREATE: definePermission('telegramminiapp.deep-link.create', 'Create deep link.'),
  DEEP_LINK_UPDATE: definePermission('telegramminiapp.deep-link.update', 'Modify deep link.'),
  MENU_ENTRY_READ: definePermission('telegramminiapp.menu-entry.read', 'View menu.'),
  MENU_ENTRY_CREATE: definePermission('telegramminiapp.menu-entry.create', 'Create menu entry.'),
  MENU_ENTRY_UPDATE: definePermission('telegramminiapp.menu-entry.update', 'Modify menu entry.'),
  MINI_APP_NOTIFICATION_SETTING_READ: definePermission(
    'telegramminiapp.mini-app-notification-setting.read',
    'View notification settings.',
  ),
  MINI_APP_NOTIFICATION_SETTING_CREATE: definePermission(
    'telegramminiapp.mini-app-notification-setting.create',
    'Create notification setting.',
  ),
  MINI_APP_NOTIFICATION_SETTING_UPDATE: definePermission(
    'telegramminiapp.mini-app-notification-setting.update',
    'Modify notification setting.',
  ),
} as const;

export const TELEGRAM_MINIAPP_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(
  TELEGRAM_MINIAPP_PERMISSIONS,
);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_USER_READ.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_SESSION_READ.key,
  TELEGRAM_MINIAPP_PERMISSIONS.DEEP_LINK_READ.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MENU_ENTRY_READ.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_NOTIFICATION_SETTING_READ.key,
];

const WRITE = [
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_USER_CREATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_USER_UPDATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_SESSION_CREATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_SESSION_UPDATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.DEEP_LINK_CREATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.DEEP_LINK_UPDATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MENU_ENTRY_CREATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MENU_ENTRY_UPDATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_NOTIFICATION_SETTING_CREATE.key,
  TELEGRAM_MINIAPP_PERMISSIONS.MINI_APP_NOTIFICATION_SETTING_UPDATE.key,
];

export const TELEGRAM_MINIAPP_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: TELEGRAM_MINIAPP_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type MiniAppPlatform = 'TELEGRAM' | 'WHATSAPP' | 'MESSENGER';
export const MINI_APP_PLATFORM_VALUES: MiniAppPlatform[] = ['TELEGRAM', 'WHATSAPP', 'MESSENGER'];

export type MiniAppUserStatus = 'ACTIVE' | 'BLOCKED';
export const MINI_APP_USER_STATUS_VALUES: MiniAppUserStatus[] = ['ACTIVE', 'BLOCKED'];

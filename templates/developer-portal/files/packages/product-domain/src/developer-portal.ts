/**
 * TrustOS Developer Portal — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const DEVELOPER_PORTAL_PERMISSIONS = {
  API_APPLICATION_READ: definePermission(
    'developerportal.api-application.read',
    'View applications.',
  ),
  API_APPLICATION_CREATE: definePermission(
    'developerportal.api-application.create',
    'Create application.',
  ),
  API_APPLICATION_UPDATE: definePermission(
    'developerportal.api-application.update',
    'Modify application.',
  ),
  API_KEY_RECORD_READ: definePermission('developerportal.api-key-record.read', 'View api keys.'),
  API_KEY_RECORD_CREATE: definePermission(
    'developerportal.api-key-record.create',
    'Create api key.',
  ),
  API_KEY_RECORD_UPDATE: definePermission(
    'developerportal.api-key-record.update',
    'Modify api key.',
  ),
  API_USAGE_RECORD_READ: definePermission('developerportal.api-usage-record.read', 'View usage.'),
  API_USAGE_RECORD_CREATE: definePermission(
    'developerportal.api-usage-record.create',
    'Create usage record.',
  ),
  API_USAGE_RECORD_UPDATE: definePermission(
    'developerportal.api-usage-record.update',
    'Modify usage record.',
  ),
  CODE_EXAMPLE_READ: definePermission('developerportal.code-example.read', 'View examples.'),
  CODE_EXAMPLE_CREATE: definePermission('developerportal.code-example.create', 'Create example.'),
  CODE_EXAMPLE_UPDATE: definePermission('developerportal.code-example.update', 'Modify example.'),
  SDK_RELEASE_READ: definePermission('developerportal.sdk-release.read', 'View sdk downloads.'),
  SDK_RELEASE_CREATE: definePermission('developerportal.sdk-release.create', 'Create sdk release.'),
  SDK_RELEASE_UPDATE: definePermission('developerportal.sdk-release.update', 'Modify sdk release.'),
} as const;

export const DEVELOPER_PORTAL_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(
  DEVELOPER_PORTAL_PERMISSIONS,
);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  DEVELOPER_PORTAL_PERMISSIONS.API_APPLICATION_READ.key,
  DEVELOPER_PORTAL_PERMISSIONS.API_KEY_RECORD_READ.key,
  DEVELOPER_PORTAL_PERMISSIONS.API_USAGE_RECORD_READ.key,
  DEVELOPER_PORTAL_PERMISSIONS.CODE_EXAMPLE_READ.key,
  DEVELOPER_PORTAL_PERMISSIONS.SDK_RELEASE_READ.key,
];

const WRITE = [
  DEVELOPER_PORTAL_PERMISSIONS.API_APPLICATION_CREATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.API_APPLICATION_UPDATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.API_KEY_RECORD_CREATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.API_KEY_RECORD_UPDATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.API_USAGE_RECORD_CREATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.API_USAGE_RECORD_UPDATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.CODE_EXAMPLE_CREATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.CODE_EXAMPLE_UPDATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.SDK_RELEASE_CREATE.key,
  DEVELOPER_PORTAL_PERMISSIONS.SDK_RELEASE_UPDATE.key,
];

export const DEVELOPER_PORTAL_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: DEVELOPER_PORTAL_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type ApiEnvironment = 'SANDBOX' | 'PRODUCTION';
export const API_ENVIRONMENT_VALUES: ApiEnvironment[] = ['SANDBOX', 'PRODUCTION'];

export type ApiApplicationStatus = 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REVOKED';
export const API_APPLICATION_STATUS_VALUES: ApiApplicationStatus[] = [
  'PENDING',
  'APPROVED',
  'SUSPENDED',
  'REVOKED',
];

export type ExampleLanguage = 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
export const EXAMPLE_LANGUAGE_VALUES: ExampleLanguage[] = [
  'CURL',
  'TYPESCRIPT',
  'PYTHON',
  'GO',
  'PHP',
  'JAVA',
];

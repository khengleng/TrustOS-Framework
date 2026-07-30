import { registrySchema, type TemplateManifest, type TemplateVariable } from './schema';

/**
 * The approved template catalog.
 *
 * Templates are local and version-controlled. There is deliberately no remote
 * fetch, no plugin resolution and no marketplace: the generator will only ever
 * write files that are already in this repository and have been through review.
 */

/** Variables every template needs, so they cannot drift apart per template. */
const COMMON_VARIABLES: TemplateVariable[] = [
  {
    name: 'applicationName',
    description: 'Directory and human-readable name of the new application.',
    required: true,
  },
  {
    name: 'packageName',
    description: 'npm package name, e.g. @acme/merchant.',
    required: true,
  },
  {
    name: 'organizationName',
    description: 'Owning organization, recorded in the generated README.',
    required: true,
  },
  {
    name: 'productDisplayName',
    description: 'Product name shown in the UI and API documentation.',
    required: true,
  },
  {
    name: 'description',
    description: 'One-line description of the product.',
    required: true,
  },
  {
    name: 'port',
    description: 'Port the API listens on in development.',
    required: false,
    default: 3000,
  },
  {
    name: 'deploymentTarget',
    description: 'railway or local.',
    required: false,
    default: 'railway',
  },
  {
    name: 'includeApi',
    description: 'Generate the NestJS API.',
    required: false,
    default: true,
  },
  {
    name: 'includeAdmin',
    description: 'Generate the Next.js admin application.',
    required: false,
    default: true,
  },
  {
    name: 'authEnabled',
    description: 'Wire authentication into the generated API.',
    required: false,
    default: true,
  },
  {
    name: 'identityProvider',
    description:
      'local or oidc. Selects which identity provider the generated API authenticates against.',
    required: false,
    default: 'local',
  },
  {
    name: 'initialRoles',
    description: 'Comma-separated role names seeded for the product.',
    required: false,
    default: 'organization_owner,administrator,operator,auditor',
  },
];

const BASE_MODULES = [
  'config',
  'database',
  'errors',
  'logging',
  'validation',
  'observability',
] as const;

const TENANT_MODULES = ['auth', 'rbac', 'tenancy', 'audit'] as const;

const manifests: TemplateManifest[] = [
  {
    id: 'generic-saas',
    displayName: 'TrustOS Generic SaaS',
    description:
      'Multi-tenant SaaS foundation: NestJS API, Next.js admin, organizations, RBAC, audit, and one example domain entity.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'admin'],
    includedModules: [...BASE_MODULES, ...TENANT_MODULES],
    requiredVariables: COMMON_VARIABLES,
    deploymentTargets: ['railway', 'local'],
    entities: ['WorkspaceItem'],
    migrationNotes:
      'Initial release. WorkspaceItem is a worked example — rename or replace it before building real features on top.',
    owner: 'TrustOS Platform Team',
    outOfScope: ['payments', 'notifications', 'billing', 'reporting'],
  },

  {
    id: 'merchant',
    displayName: 'TrustOS Merchant',
    description:
      'Merchant foundation: merchants, stores, branches and merchant members, with an admin console over all four.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'admin'],
    includedModules: [...BASE_MODULES, ...TENANT_MODULES],
    requiredVariables: COMMON_VARIABLES,
    deploymentTargets: ['railway', 'local'],
    entities: ['Merchant', 'Store', 'Branch', 'MerchantMember'],
    migrationNotes:
      'Initial release. Structure only — payments, loyalty, campaigns, inventory and settlement are deliberately absent.',
    owner: 'TrustOS Merchant Team',
    outOfScope: ['payments', 'loyalty', 'campaigns', 'inventory', 'settlement'],
  },

  {
    id: 'learning',
    displayName: 'TrustOS Learning',
    description:
      'Learning foundation: student profiles, learning sessions and quiz attempts, with progress and review screens.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'admin'],
    includedModules: [...BASE_MODULES, ...TENANT_MODULES],
    requiredVariables: COMMON_VARIABLES,
    deploymentTargets: ['railway', 'local'],
    entities: ['StudentProfile', 'LearningSession', 'QuizAttempt'],
    migrationNotes:
      'Initial release. Records learning activity only — AI quiz generation, payments, school management and the teacher marketplace are out of scope.',
    owner: 'TrustOS Learn Team',
    outOfScope: ['AI quiz generation', 'payments', 'school management', 'teacher marketplace'],
  },

  {
    id: 'payment-gateway',
    displayName: 'TrustOS Payment Gateway',
    description:
      'Payment-gateway skeleton: merchant accounts, hashed API keys, payment records with status history, webhook registration and a mock provider interface.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'admin'],
    includedModules: [...BASE_MODULES, ...TENANT_MODULES],
    requiredVariables: COMMON_VARIABLES,
    deploymentTargets: ['railway', 'local'],
    entities: ['MerchantAccount', 'ApiKey', 'Payment', 'PaymentStatusHistory', 'WebhookEndpoint'],
    migrationNotes:
      'Initial release. The provider interface is a mock. Bakong, KHQR, settlement, refunds and any real provider integration are out of scope and must not be added without approval.',
    owner: 'payKH Team',
    outOfScope: [
      'Bakong integration',
      'KHQR',
      'settlement',
      'refunds',
      'real payment providers',
      'PCI-scoped card handling',
    ],
  },

  {
    id: 'telegram-mini-app',
    displayName: 'TrustOS Telegram Mini App',
    description:
      'Telegram Mini App foundation: initData validation, session creation, authenticated user context, and an example Task feature.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'miniapp'],
    includedModules: [...BASE_MODULES, ...TENANT_MODULES],
    requiredVariables: [
      ...COMMON_VARIABLES,
      {
        name: 'telegramBotName',
        description: 'Telegram bot username the Mini App is served from.',
        required: false,
        default: 'your_bot',
      },
    ],
    deploymentTargets: ['railway', 'local'],
    entities: ['Task'],
    migrationNotes:
      'Initial release. initData validation is implemented against the documented Telegram algorithm; payments, games, referrals and rewards are out of scope.',
    owner: 'TrustOS Platform Team',
    outOfScope: ['payments', 'games', 'referrals', 'rewards'],
  },
];

/** Parsed once at module load, so an invalid manifest cannot reach a caller. */
export const TEMPLATES: readonly TemplateManifest[] = Object.freeze(
  registrySchema.parse(manifests),
);

export function listTemplates(): readonly TemplateManifest[] {
  return TEMPLATES;
}

export function findTemplate(id: string): TemplateManifest | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

/**
 * Looks a template up or throws with the valid ids listed.
 *
 * The error names the alternatives because a mistyped template id is the most
 * likely first failure a new user hits.
 */
export function requireTemplate(id: string): TemplateManifest {
  const template = findTemplate(id);
  if (!template) {
    throw new Error(
      `Unknown template "${id}". Available templates: ${TEMPLATES.map((t) => t.id).join(', ')}.`,
    );
  }
  return template;
}

/** True when `frameworkVersion` satisfies the template's minimum. */
export function isFrameworkCompatible(
  template: TemplateManifest,
  frameworkVersion: string,
): boolean {
  return compareSemver(frameworkVersion, template.minimumFrameworkVersion) >= 0;
}

/** Numeric semantic-version comparison. Returns -1, 0 or 1. */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number(part) || 0);
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(a);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(b);

  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

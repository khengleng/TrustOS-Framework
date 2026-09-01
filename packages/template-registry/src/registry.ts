import { compareVersions } from '@trustsystem/version-manager';
import { industryManifests } from './industry';
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

/**
 * The workflow packages a governed template wires in.
 *
 * The engine and its dependencies. Not every workflow package — a template that does not use
 * cases does not declare `case-management`, because a manifest that over-declares is a
 * manifest nobody trusts.
 */
const WORKFLOW_MODULES = [
  // The authorization engine the workflow policies plug into, and the two packages the
  // engine reports its decisions through. Not optional: the policies are the separation of
  // duty, and without the authorizer they are not evaluated.
  'authorization',
  'security-policy',
  'security-events',

  'workflow-core',
  'workflow-definition',
  'workflow-runtime',
  'workflow-approvals',
  'workflow-tasks',
  'workflow-sla',
  'workflow-escalation',
  'workflow-history',
  'workflow-policy',
] as const;

const manifests: TemplateManifest[] = [
  {
    id: 'generic-saas',
    category: 'foundation',
    status: 'stable',
    documentation: 'docs/templates.md',
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
    id: 'workflow-enabled-saas',
    category: 'foundation',
    status: 'stable',
    documentation: 'docs/templates.md',
    displayName: 'TrustOS Workflow-Enabled SaaS',
    description:
      'Multi-tenant SaaS with a governed approval workflow: maker-checker, conditional ' +
      'routing, SLAs, escalation, rework and a full audit history over one example business ' +
      'object.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'admin'],
    includedModules: [...BASE_MODULES, ...TENANT_MODULES, ...WORKFLOW_MODULES],
    requiredVariables: COMMON_VARIABLES,
    deploymentTargets: ['railway', 'local'],
    entities: ['ChangeRequest'],
    migrationNotes:
      'Initial release. ChangeRequest is a worked example — an amount and a risk rating, which ' +
      'is the shape of a limit increase or a configuration change without being either. The ' +
      'workflow definition in workflows/ is meant to be edited; validate it with ' +
      '`trustos workflow validate` before publishing.',
    owner: 'TrustOS Platform Team',
    outOfScope: [
      'payments',
      'settlement',
      'visual workflow designer',
      'BPMN',
      'external workflow engine',
    ],
  },

  {
    id: 'merchant',
    category: 'commerce',
    status: 'stable',
    documentation: 'docs/industry-reference.md',
    displayName: 'TrustOS Merchant',
    description:
      'Merchant foundation: merchants, stores, branches and merchant members, with an admin console over all four.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'admin'],
    /*
     * `template-sdk` because merchant is a parent template: its aggregator files compose the
     * chain's resources and permissions, and those are SDK types. A template that is extended
     * declares it even when its own domain files do not import it.
     */
    includedModules: [...BASE_MODULES, ...TENANT_MODULES, 'template-sdk'],
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
    category: 'education',
    status: 'stable',
    documentation: 'docs/industry-reference.md',
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
    category: 'financial-services',
    status: 'stable',
    documentation: 'docs/industry-reference.md',
    displayName: 'TrustOS Payment Gateway',
    description:
      'Payment-gateway skeleton: merchant accounts, hashed API keys, payment records with status history, webhook registration and a mock provider interface.',
    version: '0.1.0',
    minimumFrameworkVersion: '0.1.0',
    includedApps: ['api', 'admin'],
    includedModules: [...BASE_MODULES, ...TENANT_MODULES],
    requiredVariables: COMMON_VARIABLES,
    deploymentTargets: ['railway', 'local'],
    entities: [
      'MerchantAccount',
      'GatewayApiKey',
      'Payment',
      'PaymentStatusHistory',
      'GatewayWebhookEndpoint',
    ],
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
    category: 'messaging',
    status: 'deprecated',
    documentation: 'docs/industry-reference.md',
    supersededBy: 'telegram-miniapp',
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

/**
 * Parsed once at module load, so an invalid manifest cannot reach a caller.
 *
 * The industry catalog is generated from `scripts/template-specs.mjs` — see `industry.ts`. It is
 * concatenated rather than merged, so a hand-written manifest and a generated one can never both
 * claim the same id: the schema's enum has one entry per id, and a duplicate would fail here at
 * import time rather than at generation time.
 */
export const TEMPLATES: readonly TemplateManifest[] = Object.freeze(
  registrySchema.parse([...manifests, ...industryManifests(COMMON_VARIABLES)]),
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

/**
 * The layer chain for a template, parent first.
 *
 * `['hospital', 'clinic']` for a clinic — `_base` is added by the generator, which owns the
 * universal layer. Returned outermost-last so the caller can apply them in order and let a child
 * override its parent.
 *
 * Refuses a cycle by name. A cycle is only reachable by hand-editing the registry, and the
 * alternative to refusing is the generator hanging with no output, which is the worst way to
 * learn about a typo.
 */
export function resolveTemplateChain(id: string): TemplateManifest[] {
  const chain: TemplateManifest[] = [];
  const seen = new Set<string>();

  let current: TemplateManifest | undefined = requireTemplate(id);

  while (current) {
    if (seen.has(current.id)) {
      throw new Error(
        `Template inheritance cycle: ${[...seen, current.id].join(' -> ')}. A template chain is ` +
          'a line, not a loop.',
      );
    }

    seen.add(current.id);
    chain.unshift(current);
    current = current.extends ? requireTemplate(current.extends) : undefined;
  }

  return chain;
}

/**
 * Every module a template ends up with, including those inherited from its parents.
 *
 * A child never *removes* a parent's module. It could not honestly: the parent's files are
 * layered in and they import what they import, so a child that dropped a module would generate
 * an application that does not compile.
 */
export function effectiveModules(id: string): string[] {
  const modules = new Set<string>();

  for (const template of resolveTemplateChain(id)) {
    for (const module of template.includedModules) modules.add(module);
  }

  return [...modules].sort();
}

/** Templates in a category, in registry order. */
export function templatesByCategory(category: string): TemplateManifest[] {
  return TEMPLATES.filter((template) => template.category === category);
}

/** Templates that extend the given one, directly. */
export function templateChildren(id: string): TemplateManifest[] {
  return TEMPLATES.filter((template) => template.extends === id);
}

/**
 * A compatibility verdict for a template against a framework version.
 *
 * Separate from `isFrameworkCompatible` because the CLI needs to say *why*, and because a
 * deprecated or experimental template is generatable with a warning rather than compatible or
 * not — three states, and a boolean can only carry two.
 */
export interface CompatibilityReport {
  templateId: string;
  frameworkVersion: string;
  compatible: boolean;
  warnings: string[];
  reason?: string;
}

export function checkCompatibility(
  template: TemplateManifest,
  frameworkVersion: string,
): CompatibilityReport {
  const warnings: string[] = [];

  if (template.status === 'deprecated') {
    warnings.push(
      `"${template.id}" is deprecated. Use "${template.supersededBy}" for new projects; this one ` +
        'still generates so existing applications can keep upgrading.',
    );
  }

  if (template.status === 'experimental') {
    warnings.push(
      `"${template.id}" is experimental: its entities and permission keys may change between ` +
        'versions, and a rename of either is a migration.',
    );
  }

  const compatible = isFrameworkCompatible(template, frameworkVersion);

  return {
    templateId: template.id,
    frameworkVersion,
    compatible,
    warnings,
    reason: compatible
      ? undefined
      : `Needs framework ${template.minimumFrameworkVersion} or newer; this checkout is ${frameworkVersion}.`,
  };
}

/**
 * Semantic-version comparison.
 *
 * Delegates to `@trustsystem/version-manager`, which is the framework's one complete implementation.
 *
 * This used to be a local copy that stripped everything after the patch, so `1.0.0-rc.1` and
 * `1.0.0` compared *equal* — and `isFrameworkCompatible` therefore accepted a release candidate
 * wherever the release was required. A template generated against an rc while its author believed
 * it was the stable release, and nothing said otherwise.
 *
 * The reason the copy existed — keeping this package dependency-free for the CLI — did not
 * survive examination: `version-manager` depends only on `@trustsystem/errors`, which the CLI already
 * installs. Three implementations of one thing is the duplication the framework refuses
 * everywhere else, and it was wrong in two of them.
 */
export function compareSemver(a: string, b: string): number {
  return compareVersions(a, b);
}

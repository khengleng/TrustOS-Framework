import { z } from 'zod';

/**
 * Template metadata schema.
 *
 * The registry is the trust boundary of the generator: a template describes
 * what it will write, and the CLI refuses to run one whose metadata does not
 * parse. Keeping the schema strict (`.strict()`) means a typo in a template
 * manifest is a loud failure at validation time rather than a silently ignored
 * field at generation time.
 */

export const TEMPLATE_IDS = [
  // Foundations. Not an industry — the shape everything else starts from.
  'generic-saas',
  'workflow-enabled-saas',

  // Commerce
  'merchant',
  'ecommerce',
  'marketplace',
  'gold-shop',

  // Financial services
  'payment-gateway',
  'wallet',
  'digital-bank',
  'microloan',
  'collection',
  'insurance',

  // Business operations
  'crm',
  'erp',
  'helpdesk',

  // Education
  'learning',
  'education',
  'school',

  // Health
  'hospital',
  'clinic',

  // Public and social
  'ngo',
  'government',

  // Messaging mini apps
  'telegram-mini-app',
  'telegram-miniapp',
  'whatsapp-miniapp',
  'messenger-miniapp',

  // Portals
  'admin-portal',
  'customer-portal',
  'staff-portal',
  'developer-portal',
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const templateIdSchema = z.enum(TEMPLATE_IDS);

/**
 * What a template is for, used to group `trustos templates` and to answer "is there something
 * close to what I need" without reading thirty descriptions.
 */
export const TEMPLATE_CATEGORIES = [
  'foundation',
  'commerce',
  'financial-services',
  'business-operations',
  'education',
  'health',
  'public-sector',
  'messaging',
  'portal',
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const templateCategorySchema = z.enum(TEMPLATE_CATEGORIES);

/**
 * Where a template is in its life.
 *
 * `experimental` generates with a warning; `deprecated` generates with a louder one naming its
 * successor. Neither is blocked — a template someone has already built on must keep generating,
 * or an upgrade becomes a rewrite. `stable` is the only one that generates quietly, and promoting
 * a template to it is a decision a person makes, not one the passing of time makes for them.
 */
export const TEMPLATE_STATUSES = ['experimental', 'stable', 'deprecated'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
export const templateStatusSchema = z.enum(TEMPLATE_STATUSES);

/** Semantic version, without ranges — a template pins, it does not float. */
export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'Must be an exact semantic version such as 0.1.0.');

export const deploymentTargetSchema = z.enum(['railway', 'local']);
export type DeploymentTarget = z.infer<typeof deploymentTargetSchema>;

export const includedAppSchema = z.enum(['api', 'admin', 'miniapp']);
export type IncludedApp = z.infer<typeof includedAppSchema>;

/**
 * Framework capabilities a template wires in. These name existing
 * `@trustsystem/*` packages — a template never reimplements one.
 */
export const includedModuleSchema = z.enum([
  'auth',
  'rbac',
  'tenancy',
  'audit',
  'logging',
  'errors',
  'validation',
  'observability',
  'config',
  'database',

  /*
   * Phase 5. A template that governs a business object with a workflow declares these, and
   * `validate-template` fails on a template that imports a framework package it did not
   * declare — which is how the manifest stays an accurate description of what a template
   * writes rather than a wish.
   */
  'workflow-core',
  'workflow-definition',
  'workflow-runtime',
  'workflow-approvals',
  'workflow-tasks',
  'workflow-sla',
  'workflow-escalation',
  'workflow-history',
  'workflow-policy',
  'case-management',

  /*
   * Phase 4. A workflow template needs the authorization engine the workflow policies plug
   * into, plus the policy loader and the event emitter the engine reports denials through.
   */
  'authorization',
  'security-policy',
  'security-events',

  /*
   * Phase 9. The shared building blocks for navigation, forms, tables, filters, search,
   * pagination, dashboards, charts, CRUD, uploads and notifications.
   *
   * Almost every industry template declares this. The ones that do not are the ones with no
   * screens at all, and there are none of those yet — it is listed rather than assumed because
   * `validate-template` checks declarations against imports, and an assumed dependency is one
   * nothing verifies.
   */
  'template-sdk',

  /*
   * Phase 8. A template that moves money declares these.
   *
   * `wallet` implies `ledger` implies `accounts` implies `financial-core` — the dependency
   * chain is real, and `validate-template` fails a manifest that names a package without the
   * ones it needs, so a template cannot half-declare the financial platform.
   */
  'financial-core',
  'ledger',
  'accounts',
  'wallet',
  'transactions',
  'payments',
  'fees',
  'limits',
  'settlement',
  'reconciliation',
  'fx',
  'financial-events',
  'financial-policy',
  'financial-risk',
  'financial-reporting',

  /*
   * Phases 6 and 7. Integration and platform capabilities a template wires when it has an
   * outward-facing edge: a developer portal issues API keys, a payment gateway sends webhooks,
   * a collection product schedules work.
   */
  'api-keys',
  'webhooks',
  'webhook-runtime',
  'scheduler',
  'job-runtime',
  'export',
  'import',
  'identity',
  'service-accounts',
]);
export type IncludedModule = z.infer<typeof includedModuleSchema>;

/**
 * Framework packages each package needs to work.
 *
 * Declared here rather than read from `package.json` because the registry is what
 * `validate-template` checks against, and a manifest that names `wallet` without `ledger`
 * generates an application whose wallet cannot compute a balance. The failure is at runtime, on
 * the first request, in a generated project nobody has looked at yet.
 *
 * Only the edges that are not obvious are listed. `auth` needing `rbac` is not in here because
 * `TENANT_MODULES` always ships them together.
 */
export const MODULE_DEPENDENCIES: Partial<Record<IncludedModule, IncludedModule[]>> = {
  ledger: ['financial-core'],
  accounts: ['financial-core', 'ledger'],
  wallet: ['financial-core', 'ledger', 'accounts'],
  transactions: ['financial-core'],
  payments: ['financial-core', 'transactions'],
  fees: ['financial-core'],
  limits: ['financial-core'],
  settlement: ['financial-core', 'ledger', 'accounts'],
  reconciliation: ['financial-core'],
  fx: ['financial-core'],
  'financial-reporting': ['financial-core'],
  'financial-risk': ['financial-core'],
  'financial-policy': ['financial-core'],
  'financial-events': ['financial-core'],
  'webhook-runtime': ['webhooks'],
  'workflow-runtime': ['workflow-core', 'workflow-definition'],
  'workflow-approvals': ['workflow-core'],
  'workflow-tasks': ['workflow-core'],
  'workflow-sla': ['workflow-core'],
  'workflow-escalation': ['workflow-core'],
  'workflow-history': ['workflow-core'],
  'workflow-policy': ['workflow-core', 'authorization'],
  'case-management': ['workflow-core'],
};

/**
 * Framework packages a manifest names but has not declared the prerequisites for.
 *
 * Returns the missing ones, so the caller can name them. Empty means the declaration is closed
 * under its own dependencies.
 */
export function missingModuleDependencies(modules: readonly IncludedModule[]): IncludedModule[] {
  const declared = new Set(modules);
  const missing = new Set<IncludedModule>();

  for (const module of modules) {
    for (const dependency of MODULE_DEPENDENCIES[module] ?? []) {
      if (!declared.has(dependency)) missing.add(dependency);
    }
  }

  return [...missing].sort();
}

/**
 * A variable the generator must have a value for before rendering.
 *
 * `name` is the Handlebars key. Templates may only reference declared
 * variables — `validate-template` fails on any placeholder that is not in this
 * list, which is what stops a template rendering `{{undefined}}` into a
 * production config file.
 */
export const templateVariableSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'Must be lowerCamelCase.'),
    description: z.string().min(1),
    required: z.boolean().default(true),
    /** Only used when `required` is false. */
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

export type TemplateVariable = z.infer<typeof templateVariableSchema>;

export const templateManifestSchema = z
  .object({
    id: templateIdSchema,
    displayName: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    version: semverSchema,

    /** Grouping for `trustos templates`. See `TEMPLATE_CATEGORIES`. */
    category: templateCategorySchema.default('foundation'),

    /**
     * Life stage. See `TEMPLATE_STATUSES` — none of them block generation.
     */
    status: templateStatusSchema.default('experimental'),

    /**
     * The template this one is built on, layered between `_base` and this template's own files.
     *
     * The whole reason it exists: a clinic is a hospital with fewer departments, and a school is
     * an education platform with terms and attendance. Copying the parent would give two files
     * that are identical on the day they are written and quietly different a year later — which
     * is exactly the duplication the framework refuses everywhere else, and there is no reason
     * templates should be the exception.
     *
     * A chain, not a graph: one parent, and `resolveTemplateChain` refuses a cycle.
     */
    extends: templateIdSchema.optional(),

    /**
     * Where the successor lives, for a deprecated template.
     *
     * Required when `status` is `deprecated` and refused otherwise — a deprecation notice with
     * nowhere to go is a dead end, and a "use X instead" on a template nobody is leaving is
     * noise.
     */
    supersededBy: templateIdSchema.optional(),

    /** Documentation path, relative to the repository root. Checked to exist by the validator. */
    documentation: z.string().min(1).default('docs/templates.md'),
    /**
     * Lowest framework version this template is known to work against.
     * `trustos new` refuses to generate when the installed framework is older.
     */
    minimumFrameworkVersion: semverSchema,
    includedApps: z.array(includedAppSchema).min(1),
    includedModules: z.array(includedModuleSchema).min(1),
    requiredVariables: z.array(templateVariableSchema).default([]),
    deploymentTargets: z.array(deploymentTargetSchema).min(1),
    /** Domain entities the template generates, for `list-templates --verbose`. */
    entities: z.array(z.string().min(1)).default([]),
    /** What a maintainer must know when moving between template versions. */
    migrationNotes: z.string().default(''),
    /** Team accountable for this template. Not decorative — see docs/templates.md. */
    owner: z.string().min(1),
    /** Capabilities deliberately excluded, echoed into the generated README. */
    outOfScope: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.status === 'deprecated' && !manifest.supersededBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message:
          'A deprecated template must name its successor. A deprecation notice with nowhere to ' +
          'go leaves the reader on the deprecated template.',
      });
    }

    if (manifest.status !== 'deprecated' && manifest.supersededBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message: `"${manifest.id}" is not deprecated, so nothing supersedes it.`,
      });
    }

    if (manifest.extends === manifest.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extends'],
        message: 'A template cannot extend itself.',
      });
    }

    const missing = missingModuleDependencies(manifest.includedModules);

    if (missing.length > 0) {
      /*
       * A manifest naming `wallet` without `ledger` generates an application whose wallet cannot
       * compute a balance — and it fails on the first request, in a project nobody has opened
       * yet. Caught here, it fails when the manifest is written.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includedModules'],
        message:
          `"${manifest.id}" declares module(s) whose prerequisites are missing: ` +
          `${missing.join(', ')}. Add them to includedModules.`,
      });
    }
  });

export type TemplateManifest = z.infer<typeof templateManifestSchema>;

export const registrySchema = z.array(templateManifestSchema).min(1);

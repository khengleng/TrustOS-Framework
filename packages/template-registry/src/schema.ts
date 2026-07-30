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
  'generic-saas',
  'workflow-enabled-saas',
  'merchant',
  'learning',
  'payment-gateway',
  'telegram-mini-app',
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const templateIdSchema = z.enum(TEMPLATE_IDS);

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
 * `@trustos/*` packages — a template never reimplements one.
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
]);
export type IncludedModule = z.infer<typeof includedModuleSchema>;

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
  .strict();

export type TemplateManifest = z.infer<typeof templateManifestSchema>;

export const registrySchema = z.array(templateManifestSchema).min(1);

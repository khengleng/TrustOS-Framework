import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  effectiveModules,
  isFrameworkCompatible,
  requireTemplate,
  resolveTemplateChain,
  type TemplateManifest,
} from '@trustsystem/template-registry';
import { GeneratorError } from './errors';
import {
  assertSafeValue,
  assertValidApplicationName,
  assertValidDisplayText,
  assertValidPackageName,
  assertValidPort,
  parseRoleList,
} from './naming';
import { resolveWithin } from './paths';
import { buildPlan, isDirectoryEmpty, type GenerationPlan, type TemplateLayer } from './plan';
import { parseTemplateConfig } from './template-config';
import { applyPlan, type ApplyOptions, type ApplyResult } from './writer';

/**
 * Answers collected from flags or prompts. Everything here is untrusted.
 */
export interface GenerationRequest {
  templateId: string;
  applicationName: string;
  packageName: string;
  organizationName: string;
  productDisplayName: string;
  description: string;
  port?: number;
  deploymentTarget?: 'railway' | 'local';
  includeApi?: boolean;
  includeAdmin?: boolean;
  authEnabled?: boolean;
  identityProvider?: 'local' | 'oidc';
  initialRoles?: string;
  telegramBotName?: string;
  /** Where the project directory is created. Defaults to the process cwd. */
  targetDirectory?: string;
  /**
   * Generation timestamp.
   *
   * An explicit input rather than ambient state, which is what lets
   * "same inputs produce identical output" hold while `trustos.json` still
   * records when a project was generated.
   */
  generatedAt?: string;
  /**
   * Rewrites `@trustsystem/*` dependencies to `file:` paths pointing at this
   * framework checkout. Needed until the packages are published to npm.
   */
  frameworkPath?: string;
}

export interface GenerationContext {
  template: TemplateManifest;
  projectRoot: string;
  values: Record<string, unknown>;
  layers: TemplateLayer[];
}

/**
 * Framework packages every generated application depends on.
 *
 * The floor, not the ceiling. A template's own `includedModules` are unioned with this — see
 * `buildFrameworkDependencies` — so a template that wires the workflow engine gets its
 * packages without this list having to know that workflows exist.
 *
 * `shared-types` is here and not in any manifest because it is not a capability a template
 * chooses; every application needs the actor context.
 */
export const FRAMEWORK_PACKAGES = [
  'config',
  'database',
  'errors',
  'logging',
  'validation',
  'observability',
  'auth',
  'rbac',
  'tenancy',
  'audit',
  'shared-types',

  /*
   * Not a capability a template chooses, for the same reason as `shared-types`: the shared
   * `_base` layer itself uses the SDK's descriptors, so every generated application has it
   * whether or not its manifest thought to ask.
   */
  'template-sdk',
] as const;

/**
 * Locates the `templates/` directory.
 *
 * Walks upward from a starting point looking for a directory that contains
 * `_base`, so the CLI works from a source checkout, from `dist/`, and from an
 * npm install without any of them needing to agree on a relative depth.
 */
export function resolveTemplatesRoot(startDirectory: string = __dirname): string {
  let current = resolve(startDirectory);

  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(current, 'templates');
    if (existsSync(join(candidate, '_base', 'files'))) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new GeneratorError(
    'template_not_found',
    'Could not locate the templates directory.',
    'Run the CLI from a TrustOS framework checkout, or pass --templates-root.',
  );
}

/** Reads the framework version from the monorepo root package.json. */
export async function readFrameworkVersion(templatesRoot: string): Promise<string> {
  const packageJsonPath = join(dirname(templatesRoot), 'package.json');
  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Validates the request and assembles everything needed to build a plan.
 *
 * All input validation happens here, once, before any file-system work — so a
 * bad answer fails before a directory is created rather than halfway through.
 */
export async function prepareGeneration(
  request: GenerationRequest,
  options: { templatesRoot?: string; frameworkVersion?: string; cliVersion: string },
): Promise<GenerationContext> {
  const template = requireTemplate(request.templateId);
  const templatesRoot = options.templatesRoot ?? resolveTemplatesRoot();
  const frameworkVersion = options.frameworkVersion ?? (await readFrameworkVersion(templatesRoot));

  if (!isFrameworkCompatible(template, frameworkVersion)) {
    throw new GeneratorError(
      'framework_incompatible',
      `Template "${template.id}" needs framework ${template.minimumFrameworkVersion} or newer, but this checkout is ${frameworkVersion}.`,
    );
  }

  const applicationName = assertValidApplicationName(request.applicationName);
  const packageName = assertValidPackageName(request.packageName);
  const organizationName = assertValidDisplayText('Organization name', request.organizationName);
  const productDisplayName = assertValidDisplayText(
    'Product display name',
    request.productDisplayName,
  );
  const description = assertValidDisplayText('Description', request.description, 400);
  const port = assertValidPort(request.port ?? 3000);
  const roles = parseRoleList(
    request.initialRoles ?? 'organization_owner,administrator,operator,auditor',
  );

  const deploymentTarget = request.deploymentTarget ?? 'railway';
  if (!template.deploymentTargets.includes(deploymentTarget)) {
    throw new GeneratorError(
      'invalid_input',
      `Template "${template.id}" does not support deployment target "${deploymentTarget}".`,
      `Supported: ${template.deploymentTargets.join(', ')}.`,
    );
  }

  const telegramBotName = request.telegramBotName ?? 'your_bot';
  assertSafeValue('telegramBotName', telegramBotName);

  // The project directory is the only place user input becomes a path. It is
  // validated above and contained here.
  const baseDirectory = resolve(request.targetDirectory ?? process.cwd());
  const projectRoot = resolveWithin(baseDirectory, applicationName);

  const includeApi = request.includeApi ?? template.includedApps.includes('api');
  const includeAdmin = request.includeAdmin ?? template.includedApps.includes('admin');
  const includeMiniapp = template.includedApps.includes('miniapp');

  if (!includeApi && !includeAdmin && !includeMiniapp) {
    throw new GeneratorError(
      'invalid_input',
      'Nothing to generate: at least one application must be included.',
    );
  }

  const values: Record<string, unknown> = {
    applicationName,
    packageName,
    organizationName,
    productDisplayName,
    description,
    port,
    adminPort: port + 1,
    miniappPort: port + 2,
    deploymentTarget,
    isRailway: deploymentTarget === 'railway',
    includeApi,
    includeAdmin,
    includeMiniapp,
    authEnabled: request.authEnabled ?? true,
    identityProvider: request.identityProvider ?? 'local',
    initialRoles: roles,
    initialRolesCsv: roles.join(','),
    telegramBotName,

    databaseProvider: 'postgresql',
    frameworkVersion,
    frameworkDependency: request.frameworkPath ? null : `^${frameworkVersion}`,
    templateId: template.id,
    templateVersion: template.version,
    templateDisplayName: template.displayName,
    templateOwner: template.owner,
    templateOutOfScope: template.outOfScope,
    templateEntities: template.entities,
    cliVersion: options.cliVersion,
    generatedAt: request.generatedAt ?? new Date().toISOString(),

    // Dependency specs for the framework packages, so a generated
    // package.json can be rendered without repeating the list per template.
    frameworkDependencies: buildFrameworkDependencies(
      frameworkVersion,
      request.frameworkPath,
      /*
       * The chain's capabilities, not just this manifest's. A child's generated project contains
       * its parents' files, and those files import their parents' packages — so a dependency
       * list built from one manifest generates a project that does not install.
       */
      effectiveModules(template.id),
    ),
  };

  for (const [key, value] of Object.entries(values)) assertSafeValue(key, value);

  const layers = await loadLayers(templatesRoot, template.id);

  return { template, projectRoot, values, layers };
}

/**
 * Dependency specifiers for the `@trustsystem/*` packages.
 *
 * Until the framework is published to npm, a generated project cannot resolve
 * `^0.1.0` from a registry. `--framework-path` rewrites them to `file:` links
 * so the generated app installs and builds today; CI relies on it.
 *
 * `extraPackages` comes from the template's `includedModules`. Deriving the dependency list
 * from the manifest rather than keeping a second list here means the two cannot drift — and
 * `validate-template` already fails a template that imports a package it did not declare, so
 * the manifest is the accurate description of what a template needs.
 *
 * Sorted, because an unsorted dependency block makes every generated `package.json` differ by
 * key order and breaks the byte-identical determinism check.
 */
export function buildFrameworkDependencies(
  frameworkVersion: string,
  frameworkPath?: string,
  extraPackages: readonly string[] = [],
): Record<string, string> {
  const names = [...new Set([...FRAMEWORK_PACKAGES, ...extraPackages])].sort();

  const entries = names.map((name) => {
    const specifier = frameworkPath
      ? `file:${join(frameworkPath, 'packages', name)}`
      : `^${frameworkVersion}`;
    return [`@trustsystem/${name}`, specifier] as const;
  });

  return Object.fromEntries(entries);
}

/**
 * The layers to apply, in order: `_base`, then every ancestor, then the template itself.
 *
 * Later layers override earlier ones, which is what makes inheritance work without duplication.
 * A template contributes additive files — its Prisma fragment, its Nest module folder, its own
 * resource list — plus three aggregators it *does* override, each of which is a list of imports
 * naming every layer in the chain.
 *
 * So `hospital` extending `clinic` restates no patient field. It adds its folder and re-lists
 * the chain, and the clinic files arrive from the layer beneath untouched. Without this, a child
 * template would be a copy of its parent, and the copy would be correct on the day it was made.
 */
async function loadLayers(templatesRoot: string, templateId: string): Promise<TemplateLayer[]> {
  const layers: TemplateLayer[] = [];

  const chain = resolveTemplateChain(templateId).map((template) => template.id);

  for (const name of ['_base', ...chain]) {
    const root = join(templatesRoot, name);
    const configPath = join(root, 'template.json');

    if (!existsSync(join(root, 'files'))) {
      throw new GeneratorError(
        'template_not_found',
        `Template layer "${name}" is missing its files directory (${join(root, 'files')}).`,
      );
    }

    const conditions = existsSync(configPath)
      ? parseTemplateConfig(JSON.parse(await readFile(configPath, 'utf8')), `${name}/template.json`)
          .conditionalPaths
      : [];

    layers.push({ name, root: join(root, 'files'), conditions });
  }

  return layers;
}

export interface GenerateOptions extends ApplyOptions {
  templatesRoot?: string;
  frameworkVersion?: string;
  cliVersion: string;
}

export interface GenerateResult extends ApplyResult {
  projectRoot: string;
  template: TemplateManifest;
  plan: GenerationPlan;
}

/**
 * End-to-end generation: validate, plan, then apply.
 */
export async function generateApplication(
  request: GenerationRequest,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const context = await prepareGeneration(request, options);

  if (!options.force && !options.dryRun) {
    const empty = await isDirectoryEmpty(context.projectRoot);
    if (!empty) {
      throw new GeneratorError(
        'target_not_empty',
        `Directory "${context.projectRoot}" already exists and is not empty.`,
        'Choose another name, remove the directory, or re-run with --force.',
      );
    }
  }

  const plan = await buildPlan({
    projectRoot: context.projectRoot,
    layers: context.layers,
    values: context.values,
  });

  const result = await applyPlan(plan, options);

  return { ...result, projectRoot: context.projectRoot, template: context.template, plan };
}

/** Builds a plan without writing. Used by `--dry-run` and by the tests. */
export async function planApplication(
  request: GenerationRequest,
  options: { templatesRoot?: string; frameworkVersion?: string; cliVersion: string },
): Promise<GenerationPlan> {
  const context = await prepareGeneration(request, options);
  return buildPlan({
    projectRoot: context.projectRoot,
    layers: context.layers,
    values: context.values,
  });
}

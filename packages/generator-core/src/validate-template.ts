import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkCompatibility,
  missingModuleDependencies,
  requireTemplate,
  resolveTemplateChain,
  type TemplateManifest,
} from '@trustsystem/template-registry';
import { GeneratorError } from './errors';
import { collectTemplateVariables } from './render';
import { listFilesRecursively, toTargetPath } from './plan';
import { parseTemplateConfig } from './template-config';
import { resolveTemplatesRoot } from './generate';

/**
 * Template validation.
 *
 * A template is a promise that "generating this produces a working, secure
 * application". These checks are the part of that promise a machine can keep:
 * they catch the mistakes that would otherwise be discovered by a developer
 * three days into a new product.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface ValidationCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ValidationReport {
  templateId: string;
  checks: ValidationCheck[];
  ok: boolean;
}

/** Files every generated application must contain, whatever the template. */
const REQUIRED_TARGET_FILES = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'trustos.json',
  '.gitignore',
  '.env.example',
  'docs/architecture.md',
  'docs/deployment.md',
  'docs/security.md',
];

/** Patterns that must never appear in a template file. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key block' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/, label: 'GitHub token' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/, label: 'API secret key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
  {
    // A JWT secret with a real-looking value, as opposed to a placeholder.
    pattern:
      /JWT_(?:REFRESH_)?SECRET\s*=\s*(?!.*(?:change|example|placeholder|generate|<))\S{24,}/i,
    label: 'hardcoded JWT secret',
  },
];

export async function validateTemplate(
  templateId: string,
  options: { templatesRoot?: string; frameworkVersion?: string } = {},
): Promise<ValidationReport> {
  const template = requireTemplate(templateId);
  const templatesRoot = options.templatesRoot ?? resolveTemplatesRoot();
  const checks: ValidationCheck[] = [];

  const templateRoot = join(templatesRoot, template.id);

  if (!existsSync(join(templateRoot, 'files'))) {
    throw new GeneratorError(
      'template_not_found',
      `Template "${template.id}" has no files directory at ${join(templateRoot, 'files')}.`,
    );
  }

  /*
   * Every layer that will actually be applied — `_base`, each ancestor, then the template. A
   * validator that checked only the template's own directory would pass a child whose parent
   * ships a secret, and would fail one whose imports are satisfied by a parent layer.
   */
  const layerNames = ['_base', ...resolveTemplateChain(template.id).map((entry) => entry.id)];
  const layers: Array<{ root: string; files: string[] }> = [];

  for (const name of layerNames) {
    const root = join(templatesRoot, name, 'files');
    layers.push({ root, files: await listFilesRecursively(root) });
  }

  const allFiles = layers.flatMap((layer) => layer.files);
  const targets = new Set(allFiles.map((file) => toTargetPath(file)));

  // --- registry metadata ----------------------------------------------------
  checks.push(await checkManifest(template, templateRoot));
  checks.push(checkFrameworkVersion(template, options.frameworkVersion));
  checks.push(checkDependencies(template));
  checks.push(await checkDocumentation(template, templatesRoot));

  // --- the file set ---------------------------------------------------------
  checks.push(checkRequiredFiles(targets));
  checks.push(checkUnsafePaths(allFiles));
  checks.push(checkBuildConfiguration(targets));
  checks.push(checkHealthEndpoint(targets));
  checks.push(checkTestConfiguration(targets));
  checks.push(checkDeploymentConfiguration(template, targets));
  checks.push(checkRequiredModules(template, targets));

  // --- file contents --------------------------------------------------------
  checks.push(await checkPlaceholders(template, layers));
  checks.push(await checkNoSecrets(layers));
  checks.push(await checkPackageReferences(template, layers));
  checks.push(await checkMonetaryPrecision(layers));
  checks.push(await checkTenantScope(layers));
  checks.push(await checkModelCollisions(layers));

  return {
    templateId: template.id,
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

/**
 * Whether the template can run on this checkout.
 *
 * Skipped when no version is supplied — `trustos validate-template` in a source tree is checking
 * the template, not the checkout, and failing every template because the caller did not pass a
 * flag is how a validator gets ignored.
 */
function checkFrameworkVersion(
  template: TemplateManifest,
  frameworkVersion: string | undefined,
): ValidationCheck {
  if (!frameworkVersion) {
    return {
      name: 'framework version',
      status: 'pass',
      detail: `Requires ${template.minimumFrameworkVersion} or newer; no checkout version supplied.`,
    };
  }

  const report = checkCompatibility(template, frameworkVersion);

  if (!report.compatible) {
    return { name: 'framework version', status: 'fail', detail: report.reason ?? 'Incompatible.' };
  }

  return report.warnings.length > 0
    ? { name: 'framework version', status: 'warn', detail: report.warnings.join(' ') }
    : {
        name: 'framework version',
        status: 'pass',
        detail: `Compatible with ${frameworkVersion}.`,
      };
}

/**
 * Whether the declared modules are closed under their own prerequisites.
 *
 * The manifest schema refuses one that is not, so reaching this with a failure means a manifest
 * was constructed around the schema. Checked anyway, because a validator that trusts the thing it
 * is validating has nothing to say.
 */
function checkDependencies(template: TemplateManifest): ValidationCheck {
  const missing = missingModuleDependencies(template.includedModules);

  return missing.length === 0
    ? {
        name: 'dependencies',
        status: 'pass',
        detail: `${template.includedModules.length} module(s) declared, prerequisites all present.`,
      }
    : {
        name: 'dependencies',
        status: 'fail',
        detail:
          `Declares module(s) whose prerequisites are missing: ${missing.join(', ')}. The ` +
          'generated application would compile and fail on the first request.',
      };
}

/** Whether the documentation the manifest points at exists. */
async function checkDocumentation(
  template: TemplateManifest,
  templatesRoot: string,
): Promise<ValidationCheck> {
  const repositoryRoot = join(templatesRoot, '..');
  const path = join(repositoryRoot, template.documentation);

  if (!existsSync(path)) {
    return {
      name: 'documentation',
      status: 'fail',
      detail: `documentation points at "${template.documentation}", which does not exist.`,
    };
  }

  const source = await readFile(path, 'utf8');

  /*
   * A page that never mentions the template is a page the manifest points at rather than
   * documents. A warning, not a failure: a shared reference page is legitimate, and a template
   * blocked from generating over a missing paragraph helps nobody.
   */
  return source.includes(template.id)
    ? {
        name: 'documentation',
        status: 'pass',
        detail: `${template.documentation} exists and covers "${template.id}".`,
      }
    : {
        name: 'documentation',
        status: 'warn',
        detail: `${template.documentation} exists but never mentions "${template.id}".`,
      };
}

/**
 * Whether the template ships the modules its manifest claims.
 *
 * Specifically: a template declaring an app must ship files for it. A manifest that promises an
 * admin console and generates none is a manifest somebody chose the template on.
 */
function checkRequiredModules(template: TemplateManifest, targets: Set<string>): ValidationCheck {
  const missing: string[] = [];

  for (const app of template.includedApps) {
    const prefix = app === 'miniapp' ? 'apps/miniapp/' : `apps/${app}/`;
    if (![...targets].some((target) => target.startsWith(prefix))) missing.push(app);
  }

  if (template.entities.length === 0) missing.push('entities');

  const hasProductModule = targets.has('apps/api/src/modules/product/product.module.ts');

  if (template.includedApps.includes('api') && !hasProductModule) {
    missing.push('apps/api/src/modules/product/product.module.ts');
  }

  return missing.length === 0
    ? {
        name: 'required modules',
        status: 'pass',
        detail: `Ships every declared app (${template.includedApps.join(', ')}) and a product module.`,
      }
    : {
        name: 'required modules',
        status: 'fail',
        detail: `Declared but not generated: ${missing.join(', ')}.`,
      };
}

/**
 * No monetary value stored as a float.
 *
 * Phase 8's rule, enforced at template review rather than at runtime. A `Float` amount column
 * accepts every value, agrees with every test, and disagrees with the counterparty once in ten
 * thousand transactions — by which time there is production data in it.
 */
async function checkMonetaryPrecision(
  layers: Array<{ root: string; files: string[] }>,
): Promise<ValidationCheck> {
  const findings: string[] = [];

  for (const layer of layers) {
    for (const file of layer.files) {
      /*
       * Product fragments only. `00-framework.prisma` is the framework's own copy — a template
       * did not write it, cannot change it, and failing every template over a framework column
       * makes the check noise that gets switched off.
       */
      if (!file.endsWith('.prisma') || file.includes('00-framework')) continue;

      const source = await readFile(join(layer.root, file), 'utf8');

      const lines = source.split('\n');

      for (let index = 0; index < lines.length; index += 1) {
        const match =
          /^\s*(\w*(?:[Aa]mount|[Pp]rice|[Bb]alance|[Tt]otal|[Cc]ost|[Ff]ee|[Ss]alary)\w*)\s+(Float|Int)\b/.exec(
            lines[index] ?? '',
          );

        if (!match) continue;

        const name = match[1] ?? '';

        // Float is never right for money, whatever the comment above it says.
        if (match[2] === 'Int') {
          /*
           * `Int` is right for a count, and right for a whole number of minor units. The name is
           * a weak signal, so the documented convention counts too: a column whose doc comment
           * says "minor units" has made the decision explicitly, and that is exactly the habit
           * this check should reward rather than punish.
           */
          if (
            /count|quantity|days|months|minutes|seconds|tokens|permillion|cents|minor/i.test(name)
          ) {
            continue;
          }

          const preceding = lines
            .slice(Math.max(0, index - 3), index)
            .filter((line) => line.trimStart().startsWith('///'))
            .join(' ');

          if (/minor unit|in cents/i.test(preceding)) continue;
        }

        findings.push(`${name} ${match[2]} in ${file}`);
      }
    }
  }

  return findings.length === 0
    ? {
        name: 'monetary precision',
        status: 'pass',
        detail: 'No monetary column declared Float or Int.',
      }
    : {
        name: 'monetary precision',
        status: 'fail',
        detail:
          `${findings.join('; ')}. Use Decimal @db.Decimal(28, 8), or document the column as ` +
          'minor units. A float agrees with every test and disagrees with the counterparty once ' +
          'in ten thousand transactions.',
      };
}

/**
 * No two layers define the same Prisma model.
 *
 * Prisma concatenates every fragment in `prisma/schema/`, so two models with one name is a schema
 * that does not compile — and the failure surfaces at `prisma generate` in a project the developer
 * has already installed, with a message that names the model and not the template.
 *
 * Inheritance makes this much likelier: a child no longer sees its parent's fragment while
 * writing, and the framework's own copy grows models every phase. `ApiKey` and `WebhookEndpoint`
 * both became framework models after a template had already claimed them, which is exactly the
 * collision this check exists to catch before it ships.
 */
async function checkModelCollisions(
  layers: Array<{ root: string; files: string[] }>,
): Promise<ValidationCheck> {
  const owners = new Map<string, string[]>();

  for (const layer of layers) {
    for (const file of layer.files) {
      if (!file.endsWith('.prisma')) continue;

      const source = await readFile(join(layer.root, file), 'utf8');

      for (const match of source.matchAll(/^(?:model|enum)\s+(\w+)\s*\{/gm)) {
        const name = match[1] as string;
        owners.set(name, [...(owners.get(name) ?? []), file]);
      }
    }
  }

  const collisions = [...owners.entries()].filter(([, files]) => files.length > 1);

  return collisions.length === 0
    ? {
        name: 'model collisions',
        status: 'pass',
        detail: `${owners.size} model/enum name(s) across the chain, all distinct.`,
      }
    : {
        name: 'model collisions',
        status: 'fail',
        detail:
          collisions
            .map(([name, files]) => `${name} (${[...new Set(files)].join(' and ')})`)
            .join('; ') +
          '. Prisma concatenates every fragment, so a duplicate name is a schema that does not ' +
          'compile. Prefix the product model — GatewayApiKey rather than ApiKey.',
      };
}

/**
 * Every product model carries an `organizationId`.
 *
 * The quietest failure a generated application can have. A model without the column cannot be
 * scoped, so every query over it returns every tenant's rows — and nothing fails, which is why
 * this is checked mechanically rather than left to review.
 */
async function checkTenantScope(
  layers: Array<{ root: string; files: string[] }>,
): Promise<ValidationCheck> {
  const unscoped: string[] = [];
  let models = 0;

  for (const layer of layers) {
    for (const file of layer.files) {
      // Only product fragments. `00-framework.prisma` owns the framework's own models, some of
      // which are deliberately global — Organization itself, for one.
      if (!file.endsWith('.prisma') || file.includes('00-framework')) continue;

      const source = await readFile(join(layer.root, file), 'utf8');

      for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
        models += 1;
        if (!/^\s*organizationId\s+String/m.test(match[2] ?? '')) {
          unscoped.push(`${match[1]} (${file})`);
        }
      }
    }
  }

  return unscoped.length === 0
    ? {
        name: 'tenant scope',
        status: 'pass',
        detail: `${models} product model(s), every one carrying organizationId.`,
      }
    : {
        name: 'tenant scope',
        status: 'fail',
        detail:
          `Model(s) with no organizationId: ${unscoped.join(', ')}. A model that cannot be ` +
          'scoped returns every tenant’s rows, and nothing fails.',
      };
}

// ---------------------------------------------------------------------------

async function checkManifest(
  template: TemplateManifest,
  templateRoot: string,
): Promise<ValidationCheck> {
  const configPath = join(templateRoot, 'template.json');
  if (!existsSync(configPath)) {
    return {
      name: 'registry metadata',
      status: 'pass',
      detail: 'Manifest valid; no template.json (no conditional paths).',
    };
  }

  try {
    const config = parseTemplateConfig(
      JSON.parse(await readFile(configPath, 'utf8')),
      `${template.id}/template.json`,
    );
    if (config.id !== template.id) {
      return {
        name: 'registry metadata',
        status: 'fail',
        detail: `template.json declares id "${config.id}" but the registry says "${template.id}".`,
      };
    }
    return {
      name: 'registry metadata',
      status: 'pass',
      detail: `Manifest valid; ${config.conditionalPaths.length} conditional path rule(s).`,
    };
  } catch (error) {
    return {
      name: 'registry metadata',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkRequiredFiles(targets: Set<string>): ValidationCheck {
  const missing = REQUIRED_TARGET_FILES.filter((file) => !targets.has(file));
  return missing.length === 0
    ? { name: 'required files', status: 'pass', detail: `${REQUIRED_TARGET_FILES.length} present.` }
    : { name: 'required files', status: 'fail', detail: `Missing: ${missing.join(', ')}.` };
}

function checkUnsafePaths(sourceFiles: string[]): ValidationCheck {
  const unsafe = sourceFiles.filter((file) => {
    const target = toTargetPath(file);
    return (
      target.startsWith('/') ||
      target.includes('..') ||
      target.includes('\0') ||
      /^[a-zA-Z]:/.test(target)
    );
  });

  return unsafe.length === 0
    ? {
        name: 'safe paths',
        status: 'pass',
        detail: `${sourceFiles.length} paths are relative and contained.`,
      }
    : { name: 'safe paths', status: 'fail', detail: `Unsafe: ${unsafe.join(', ')}.` };
}

function checkBuildConfiguration(targets: Set<string>): ValidationCheck {
  const required = ['package.json', 'tsconfig.base.json'];
  const missing = required.filter((file) => !targets.has(file));
  return missing.length === 0
    ? { name: 'build configuration', status: 'pass', detail: 'package.json and tsconfig present.' }
    : { name: 'build configuration', status: 'fail', detail: `Missing: ${missing.join(', ')}.` };
}

function checkHealthEndpoint(targets: Set<string>): ValidationCheck {
  // The framework's ObservabilityModule provides /health and /ready; a
  // generated API must import it in its composition root.
  const hasApi = [...targets].some((target) => target.startsWith('apps/api/src/'));
  if (!hasApi) {
    return {
      name: 'health endpoint',
      status: 'warn',
      detail: 'No API generated; nothing to check.',
    };
  }
  return targets.has('apps/api/src/app.module.ts')
    ? {
        name: 'health endpoint',
        status: 'pass',
        detail: 'API composition root present (provides /health and /ready).',
      }
    : { name: 'health endpoint', status: 'fail', detail: 'apps/api/src/app.module.ts is missing.' };
}

function checkTestConfiguration(targets: Set<string>): ValidationCheck {
  const hasConfig = targets.has('vitest.config.ts');
  const specs = [...targets].filter((target) => target.endsWith('.spec.ts'));

  if (!hasConfig) {
    return { name: 'test configuration', status: 'fail', detail: 'vitest.config.ts is missing.' };
  }
  if (specs.length === 0) {
    return { name: 'test configuration', status: 'fail', detail: 'Template ships no tests.' };
  }
  const isolation = specs.some((spec) => spec.includes('isolation') || spec.includes('tenant'));
  return isolation
    ? {
        name: 'test configuration',
        status: 'pass',
        detail: `${specs.length} spec file(s), including tenant isolation.`,
      }
    : {
        name: 'test configuration',
        status: 'fail',
        detail: `${specs.length} spec file(s) but none covering tenant isolation.`,
      };
}

function checkDeploymentConfiguration(
  template: TemplateManifest,
  targets: Set<string>,
): ValidationCheck {
  if (!template.deploymentTargets.includes('railway')) {
    return {
      name: 'deployment configuration',
      status: 'pass',
      detail: 'Railway not supported; nothing required.',
    };
  }
  return targets.has('railway.toml')
    ? { name: 'deployment configuration', status: 'pass', detail: 'railway.toml present.' }
    : {
        name: 'deployment configuration',
        status: 'fail',
        detail: 'Template supports Railway but ships no railway.toml.',
      };
}

/**
 * Every `{{placeholder}}` must correspond to a declared variable.
 *
 * This is what stops a template rendering an empty string into a generated
 * config file. Handlebars' strict mode would throw at generation time; this
 * check moves the failure to review time.
 */
async function checkPlaceholders(
  template: TemplateManifest,
  layers: Array<{ root: string; files: string[] }>,
): Promise<ValidationCheck> {
  const declared = new Set([
    ...template.requiredVariables.map((variable) => variable.name),
    // Values the generator always supplies.
    'adminPort',
    'miniappPort',
    'isRailway',
    'includeMiniapp',
    'databaseProvider',
    'frameworkVersion',
    'frameworkDependency',
    'frameworkDependencies',
    'templateId',
    'templateVersion',
    'templateDisplayName',
    'templateOwner',
    'templateOutOfScope',
    'templateEntities',
    'cliVersion',
    'generatedAt',
    'initialRolesCsv',
    'this',
  ]);

  const unresolved = new Map<string, string[]>();

  for (const layer of layers) {
    for (const file of layer.files) {
      if (!file.endsWith('.hbs')) continue;
      const source = await readFile(join(layer.root, file), 'utf8');
      for (const variable of collectTemplateVariables(source, file)) {
        if (declared.has(variable)) continue;
        unresolved.set(variable, [...(unresolved.get(variable) ?? []), file]);
      }
    }
  }

  if (unresolved.size === 0) {
    return {
      name: 'no unresolved placeholders',
      status: 'pass',
      detail: 'Every placeholder is declared.',
    };
  }

  const detail = [...unresolved.entries()]
    .map(([variable, files]) => `${variable} (${files[0]})`)
    .join(', ');
  return { name: 'no unresolved placeholders', status: 'fail', detail: `Undeclared: ${detail}.` };
}

async function checkNoSecrets(
  layers: Array<{ root: string; files: string[] }>,
): Promise<ValidationCheck> {
  const findings: string[] = [];

  for (const layer of layers) {
    for (const file of layer.files) {
      const source = await readFile(join(layer.root, file), 'utf8');
      for (const { pattern, label } of SECRET_PATTERNS) {
        if (pattern.test(source)) findings.push(`${label} in ${file}`);
      }
      if (toTargetPath(file) === '.env') findings.push(`.env would be generated from ${file}`);
    }
  }

  return findings.length === 0
    ? { name: 'no committed secrets', status: 'pass', detail: 'No secret-shaped content found.' }
    : { name: 'no committed secrets', status: 'fail', detail: findings.join('; ') };
}

/**
 * Removes comments before scanning for package references.
 *
 * A doc comment that *mentions* a package is not a dependency on it. The framework schema
 * carries lines like "Redacted by @trustsystem/security-events before it lands", and counting those
 * as references would force every template to declare packages it never imports — which would
 * make the check useless in the direction that matters, since a template declaring everything
 * cannot be caught depending on something it should not.
 *
 * Whole comment lines only, plus block comments. A trailing `//` on a code line is left alone,
 * because stripping it would also truncate a URL — and a code line containing both a URL and a
 * package reference is a line whose reference we do want to see.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('#') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/**
 * Framework packages referenced by the template must exist in the registry's
 * module list, so a template cannot quietly depend on something the framework
 * does not ship — or reimplement one it does.
 */
async function checkPackageReferences(
  template: TemplateManifest,
  layers: Array<{ root: string; files: string[] }>,
): Promise<ValidationCheck> {
  const referenced = new Set<string>();

  for (const layer of layers) {
    for (const file of layer.files) {
      const source = await readFile(join(layer.root, file), 'utf8');

      for (const match of stripComments(source).matchAll(/@trustsystem\/([a-z-]+)/g)) {
        const name = match[1];
        if (name) referenced.add(name);
      }
    }
  }

  const known = new Set([
    ...template.includedModules,
    // Always installed. See FRAMEWORK_PACKAGES in generate.ts.
    'shared-types',
    'template-sdk',
    'template-registry',
    'generator-core',
    'cli',
  ]);

  const unknown = [...referenced].filter((name) => !known.has(name));

  return unknown.length === 0
    ? {
        name: 'valid package references',
        status: 'pass',
        detail: `References ${referenced.size} framework package(s), all declared.`,
      }
    : {
        name: 'valid package references',
        status: 'fail',
        detail: `Undeclared framework packages: ${unknown.join(', ')}. Add them to includedModules.`,
      };
}

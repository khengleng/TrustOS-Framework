import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireTemplate, type TemplateManifest } from '@trustos/template-registry';
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
  options: { templatesRoot?: string } = {},
): Promise<ValidationReport> {
  const template = requireTemplate(templateId);
  const templatesRoot = options.templatesRoot ?? resolveTemplatesRoot();
  const checks: ValidationCheck[] = [];

  const templateRoot = join(templatesRoot, template.id);
  const baseRoot = join(templatesRoot, '_base');

  if (!existsSync(join(templateRoot, 'files'))) {
    throw new GeneratorError(
      'template_not_found',
      `Template "${template.id}" has no files directory at ${join(templateRoot, 'files')}.`,
    );
  }

  // --- registry metadata ----------------------------------------------------
  checks.push(await checkManifest(template, templateRoot));

  // --- the file set ---------------------------------------------------------
  const baseFiles = await listFilesRecursively(join(baseRoot, 'files'));
  const templateFiles = await listFilesRecursively(join(templateRoot, 'files'));
  const targets = new Set([...baseFiles, ...templateFiles].map((file) => toTargetPath(file)));

  checks.push(checkRequiredFiles(targets));
  checks.push(checkUnsafePaths([...baseFiles, ...templateFiles]));
  checks.push(checkBuildConfiguration(targets));
  checks.push(checkHealthEndpoint(targets));
  checks.push(checkTestConfiguration(targets));
  checks.push(checkDeploymentConfiguration(template, targets));

  // --- file contents --------------------------------------------------------
  checks.push(
    await checkPlaceholders(template, [
      { root: join(baseRoot, 'files'), files: baseFiles },
      { root: join(templateRoot, 'files'), files: templateFiles },
    ]),
  );
  checks.push(
    await checkNoSecrets([
      { root: join(baseRoot, 'files'), files: baseFiles },
      { root: join(templateRoot, 'files'), files: templateFiles },
    ]),
  );
  checks.push(
    await checkPackageReferences(template, [
      { root: join(baseRoot, 'files'), files: baseFiles },
      { root: join(templateRoot, 'files'), files: templateFiles },
    ]),
  );

  return {
    templateId: template.id,
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
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
      for (const match of source.matchAll(/@trustos\/([a-z-]+)/g)) {
        const name = match[1];
        if (name) referenced.add(name);
      }
    }
  }

  const known = new Set([
    ...template.includedModules,
    'shared-types',
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

import { checkbox, confirm, input, select } from '@inquirer/prompts';
import {
  GeneratorError,
  assertValidApplicationName,
  assertValidDisplayText,
  assertValidPackageName,
  assertValidPort,
  parseRoleList,
} from '@trustos/generator-core';
import { SYSTEM_ROLE_SUGGESTIONS } from './roles';
import type { TemplateManifest } from '@trustos/template-registry';

/**
 * Interactive answers.
 *
 * Every prompt validates with the same function the non-interactive path uses,
 * so a value accepted at the prompt cannot be rejected later — the two paths
 * cannot drift because there is only one validator per field.
 */

export interface NewCommandFlags {
  name?: string;
  packageName?: string;
  organization?: string;
  displayName?: string;
  description?: string;
  port?: string;
  deploy?: string;
  api?: boolean;
  admin?: boolean;
  auth?: boolean;
  roles?: string;
  git?: boolean;
  yes?: boolean;
}

export interface CollectedAnswers {
  applicationName: string;
  packageName: string;
  organizationName: string;
  productDisplayName: string;
  description: string;
  port: number;
  deploymentTarget: 'railway' | 'local';
  includeApi: boolean;
  includeAdmin: boolean;
  authEnabled: boolean;
  initialRoles: string;
  gitInit: boolean;
}

/**
 * Wraps a validator so inquirer shows the message inline rather than crashing.
 * Returning the string is inquirer's contract for "invalid, here is why".
 */
function validator<T>(fn: (value: T) => unknown): (value: T) => true | string {
  return (value: T) => {
    try {
      fn(value);
      return true;
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid value.';
    }
  };
}

/** Derives a sensible default package name from the application name. */
export function defaultPackageName(applicationName: string): string {
  return applicationName;
}

/** Derives a display name: "merchant-portal" -> "Merchant Portal". */
export function defaultDisplayName(applicationName: string): string {
  return applicationName
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Non-interactive resolution: flags and defaults only.
 *
 * Used with `--yes`, and automatically when stdin is not a TTY so the CLI
 * cannot hang forever waiting for input in CI.
 */
export function resolveAnswersFromFlags(
  template: TemplateManifest,
  flags: NewCommandFlags,
): CollectedAnswers {
  const applicationName = assertValidApplicationName(flags.name ?? template.id);

  return {
    applicationName,
    packageName: assertValidPackageName(flags.packageName ?? defaultPackageName(applicationName)),
    organizationName: assertValidDisplayText('Organization name', flags.organization ?? 'TrustOS'),
    productDisplayName: assertValidDisplayText(
      'Product display name',
      flags.displayName ?? defaultDisplayName(applicationName),
    ),
    description: assertValidDisplayText(
      'Description',
      flags.description ?? template.description,
      400,
    ),
    port: assertValidPort(flags.port ? Number(flags.port) : 3000),
    deploymentTarget: resolveDeploymentTarget(template, flags.deploy),
    includeApi: flags.api ?? template.includedApps.includes('api'),
    includeAdmin: flags.admin ?? template.includedApps.includes('admin'),
    authEnabled: flags.auth ?? true,
    initialRoles: parseRoleList(flags.roles ?? SYSTEM_ROLE_SUGGESTIONS.join(',')).join(','),
    gitInit: flags.git ?? true,
  };
}

function resolveDeploymentTarget(
  template: TemplateManifest,
  value: string | undefined,
): 'railway' | 'local' {
  const target = (value ?? 'railway').toLowerCase();
  if (target !== 'railway' && target !== 'local') {
    throw new GeneratorError(
      'invalid_input',
      `Unknown deployment target "${value}".`,
      'Use --deploy railway or --deploy local.',
    );
  }
  if (!template.deploymentTargets.includes(target)) {
    throw new GeneratorError(
      'invalid_input',
      `Template "${template.id}" does not support "${target}".`,
      `Supported: ${template.deploymentTargets.join(', ')}.`,
    );
  }
  return target;
}

/**
 * Interactive prompts, pre-filled from any flags already supplied.
 *
 * The order follows how someone thinks about a new product: what it is called,
 * who owns it, what it contains, then where it runs.
 */
export async function promptForAnswers(
  template: TemplateManifest,
  flags: NewCommandFlags,
): Promise<CollectedAnswers> {
  const applicationName =
    flags.name ??
    (await input({
      message: 'Application name (directory)',
      default: template.id,
      validate: validator(assertValidApplicationName),
    }));
  assertValidApplicationName(applicationName);

  const packageName =
    flags.packageName ??
    (await input({
      message: 'npm package name',
      default: defaultPackageName(applicationName),
      validate: validator(assertValidPackageName),
    }));

  const organizationName =
    flags.organization ??
    (await input({
      message: 'Organization name',
      default: 'TrustOS',
      validate: validator((value: string) => assertValidDisplayText('Organization name', value)),
    }));

  const productDisplayName =
    flags.displayName ??
    (await input({
      message: 'Product display name',
      default: defaultDisplayName(applicationName),
      validate: validator((value: string) => assertValidDisplayText('Product display name', value)),
    }));

  const description =
    flags.description ??
    (await input({
      message: 'Description',
      default: template.description,
      validate: validator((value: string) => assertValidDisplayText('Description', value, 400)),
    }));

  const includeApi =
    flags.api ??
    (template.includedApps.includes('api')
      ? await confirm({ message: 'Include the API?', default: true })
      : false);

  const includeAdmin =
    flags.admin ??
    (template.includedApps.includes('admin')
      ? await confirm({ message: 'Include the admin application?', default: true })
      : false);

  const authEnabled =
    flags.auth ?? (await confirm({ message: 'Enable authentication?', default: true }));

  const selectedRoles = flags.roles
    ? parseRoleList(flags.roles)
    : await checkbox({
        message: 'Initial roles',
        choices: SYSTEM_ROLE_SUGGESTIONS.map((role) => ({
          name: role,
          value: role,
          checked: true,
        })),
        validate: (choices) => (choices.length > 0 ? true : 'Select at least one role.'),
      });

  const deploymentTarget =
    (flags.deploy as 'railway' | 'local' | undefined) ??
    (await select({
      message: 'Deployment target',
      choices: template.deploymentTargets.map((target) => ({
        name: target === 'railway' ? 'Railway' : 'Local only',
        value: target,
      })),
      default: template.deploymentTargets[0],
    }));

  const port =
    (flags.port ? Number(flags.port) : undefined) ??
    Number(
      await input({
        message: 'API port (development)',
        default: '3000',
        validate: validator((value: string) => assertValidPort(Number(value))),
      }),
    );

  const gitInit =
    flags.git ?? (await confirm({ message: 'Initialize a git repository?', default: true }));

  // The database is PostgreSQL in this phase. Asking a question with one
  // possible answer wastes the user's time, so it is stated rather than asked.

  return {
    applicationName,
    packageName: assertValidPackageName(packageName),
    organizationName: assertValidDisplayText('Organization name', organizationName),
    productDisplayName: assertValidDisplayText('Product display name', productDisplayName),
    description: assertValidDisplayText('Description', description, 400),
    port: assertValidPort(port),
    deploymentTarget: resolveDeploymentTarget(template, deploymentTarget),
    includeApi,
    includeAdmin,
    authEnabled,
    initialRoles: parseRoleList(selectedRoles.join(',')).join(','),
    gitInit,
  };
}

/** True when prompting is possible and not suppressed. */
export function shouldPrompt(flags: NewCommandFlags): boolean {
  if (flags.yes) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

import { confirm } from '@inquirer/prompts';
import {
  installModules,
  isGeneratorError,
  planModuleInstall,
  resolveApplicationRoot,
  resolveFrameworkPath,
  type InstallModulePlan,
} from '@trustsystem/generator-core';
import { listModules } from '@trustsystem/module-registry';
import { formatRows, style, type Output } from '../output';

/**
 * `trustos add-module`.
 *
 * Local installation only: every module is already in this repository and has been
 * through review. There is no download, no registry lookup and no post-install
 * script — a module contributes files, dependencies and documentation, and nothing
 * that executes during the install.
 */

export interface AddModuleOptions {
  path?: string;
  frameworkPath?: string;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
  yes?: boolean;
  json?: boolean;
  includeOptional?: boolean;
  generatedAt?: string;
}

export async function runAddModule(
  moduleIds: string[],
  options: AddModuleOptions,
  output: Output,
): Promise<number> {
  if (moduleIds.length === 0) {
    output.error('Name at least one module to install.');
    output.blank();
    output.info(style.bold('Available'));
    for (const entry of listModules()) {
      output.detail(`  ${entry.metadata.id.padEnd(16)} ${entry.metadata.description}`);
    }
    output.blank();
    output.detail('  trustos list-modules --verbose   for permissions, routes and configuration');
    return 1;
  }

  const applicationRoot = options.path
    ? resolveApplicationRoot(options.path)
    : resolveApplicationRoot(process.cwd());

  const frameworkPath = options.frameworkPath ?? resolveFrameworkPath();

  const planned = await planModuleInstall({
    moduleIds,
    applicationRoot,
    frameworkPath,
    ...(options.includeOptional === undefined ? {} : { includeOptional: options.includeOptional }),
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(options.force ? { allowDeprecated: true } : {}),
  });

  if (options.json) {
    output.info(
      JSON.stringify(
        {
          applicationRoot: planned.applicationRoot,
          install: planned.order.map((entry) => entry.metadata.id),
          addedForDependencies: planned.addedForDependencies,
          alreadyInstalled: planned.alreadyInstalled,
          files: planned.plan.files.map((file) => file.path),
          migrations: planned.migrations,
          dryRun: Boolean(options.dryRun),
        },
        null,
        2,
      ),
    );
    if (options.dryRun) return 0;
  } else {
    printPlan(planned, applicationRoot, output);
  }

  if (planned.order.length === 0) {
    output.blank();
    output.success('Nothing to do: every requested module is already installed.');
    return 0;
  }

  if (options.dryRun) {
    output.blank();
    output.info('Nothing was written.');
    return 0;
  }

  if (!options.yes) {
    // Asked once, before anything is written. An install changes package.json and
    // the Prisma schema, both of which have consequences beyond the file itself.
    const proceed = await confirm({
      message: `Install ${planned.order.length} module(s) into ${applicationRoot}?`,
      default: true,
    });
    if (!proceed) {
      output.info('Cancelled.');
      return 130;
    }
  }

  const result = await installModules(
    {
      moduleIds,
      applicationRoot,
      frameworkPath,
      ...(options.includeOptional === undefined
        ? {}
        : { includeOptional: options.includeOptional }),
      ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
      ...(options.force ? { allowDeprecated: true } : {}),
    },
    {
      ...(options.verbose
        ? {
            onFile: (event) => output.detail(`  ${event.action.padEnd(11)} ${event.path}`),
          }
        : {}),
      onRollback: (event) =>
        output.warn(`Rolled back ${event.removed} change(s); the application is unchanged.`),
    },
  );

  output.blank();
  output.success(`Installed ${result.installed.join(', ')}.`);
  output.blank();

  output.info(style.bold('Next'));
  result.nextSteps.forEach((step, index) => output.detail(`  ${index + 1}. ${step}`));

  if (result.migrations.length > 0) {
    output.blank();
    output.detail(
      `  The schema fragments are copied but not migrated: run db:migrate to generate\n  the SQL against your real schema.`,
    );
  }

  return 0;
}

function printPlan(planned: InstallModulePlan, applicationRoot: string, output: Output): void {
  output.info(style.bold('Install plan'));
  output.blank();

  output.detail(
    formatRows([
      ['application', applicationRoot],
      ['modules', planned.order.map((entry) => entry.metadata.id).join(', ') || '(none)'],
      [
        'pulled in',
        planned.addedForDependencies.length ? planned.addedForDependencies.join(', ') : '(none)',
      ],
      [
        'already installed',
        planned.alreadyInstalled.length ? planned.alreadyInstalled.join(', ') : '(none)',
      ],
      ['files', String(planned.plan.files.length)],
      ['migrations', planned.migrations.length ? planned.migrations.join(', ') : '(none)'],
    ]),
  );

  if (planned.skippedOptional.length > 0) {
    output.blank();
    output.detail(
      `  Optional dependencies not installed: ${planned.skippedOptional.join(', ')} (pass --include-optional).`,
    );
  }

  const permissions = planned.order.flatMap((entry) => entry.permissions);
  if (permissions.length > 0) {
    output.blank();
    output.info(style.bold('Permissions introduced'));
    // Printed rather than granted: nothing in the module system can grant a
    // permission, and the application's seed decides.
    for (const permission of permissions) {
      output.detail(
        `  ${permission.key.padEnd(38)} ${permission.suggestedRoles.join(', ') || '—'}`,
      );
    }
  }
}

/** Whether an error came from the generator, so the caller can phrase it. */
export { isGeneratorError };

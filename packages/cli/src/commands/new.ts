import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { relative } from 'node:path';
import {
  generateApplication,
  planApplication,
  type GenerationRequest,
} from '@trustos/generator-core';
import { requireTemplate } from '@trustos/template-registry';
import type { Output } from '../output';
import { formatRows, style } from '../output';
import {
  promptForAnswers,
  resolveAnswersFromFlags,
  shouldPrompt,
  type NewCommandFlags,
} from '../prompts';

const execFileAsync = promisify(execFile);

export interface NewCommandOptions extends NewCommandFlags {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  templatesRoot?: string;
  frameworkPath?: string;
  /**
   * Commander derives this name from `--target-dir`. The spelling has to match
   * exactly: an option that silently does not arrive is worse than one that
   * errors, because generation still succeeds — in the wrong directory.
   */
  targetDir?: string;
  generatedAt?: string;
  cliVersion: string;
}

/**
 * `trustos new <template>`.
 *
 * Order of operations is deliberate: collect and validate every answer, then
 * build the whole plan, then write. Nothing touches the disk until the plan is
 * complete, so an invalid answer or a broken template fails before a directory
 * exists.
 */
export async function runNew(
  templateId: string,
  options: NewCommandOptions,
  output: Output,
): Promise<number> {
  const template = requireTemplate(templateId);

  const answers = shouldPrompt(options)
    ? await promptForAnswers(template, options)
    : resolveAnswersFromFlags(template, options);

  const request: GenerationRequest = {
    templateId: template.id,
    applicationName: answers.applicationName,
    packageName: answers.packageName,
    organizationName: answers.organizationName,
    productDisplayName: answers.productDisplayName,
    description: answers.description,
    port: answers.port,
    deploymentTarget: answers.deploymentTarget,
    includeApi: answers.includeApi,
    includeAdmin: answers.includeAdmin,
    authEnabled: answers.authEnabled,
    identityProvider: answers.identityProvider,
    initialRoles: answers.initialRoles,
    ...(options.targetDir ? { targetDirectory: options.targetDir } : {}),
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(options.frameworkPath ? { frameworkPath: options.frameworkPath } : {}),
  };

  const generateOptions = {
    cliVersion: options.cliVersion,
    ...(options.templatesRoot ? { templatesRoot: options.templatesRoot } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.force ? { force: true } : {}),
  };

  if (options.dryRun) {
    const plan = await planApplication(request, generateOptions);

    output.info(`${style.bold('Dry run')} — ${template.displayName}`);
    output.detail(`  ${plan.files.length} file(s) would be written to ${plan.projectRoot}`);
    output.blank();

    if (options.verbose) {
      for (const file of plan.files) {
        output.detail(`  ${file.exists ? 'overwrite' : 'create   '} ${file.path}`);
      }
    } else {
      for (const file of plan.files.slice(0, 15)) {
        output.detail(`  create    ${file.path}`);
      }
      if (plan.files.length > 15) {
        output.detail(`  … and ${plan.files.length - 15} more (use --verbose to list all)`);
      }
    }

    const conflicts = plan.files.filter((file) => file.exists);
    if (conflicts.length > 0) {
      output.blank();
      output.warn(`${conflicts.length} file(s) already exist. A real run needs --force.`);
    }

    output.blank();
    output.info('Nothing was written.');
    return 0;
  }

  const result = await generateApplication(request, {
    ...generateOptions,
    onFile: options.verbose
      ? (event) => output.detail(`  ${event.action.padEnd(11)} ${event.path}`)
      : undefined,
    onRollback: (event) => output.warn(`Generation failed; rolled back ${event.removed} path(s).`),
  });

  output.blank();
  output.success(
    `Created ${style.bold(answers.productDisplayName)} in ${relative(process.cwd(), result.projectRoot) || '.'}`,
  );
  output.detail(
    formatRows([
      ['template', `${template.displayName} v${template.version}`],
      ['files', String(result.created.length + result.overwritten.length)],
      ['entities', template.entities.join(', ') || '—'],
      ['deployment', answers.deploymentTarget],
      ['identity', answers.identityProvider],
    ]),
  );

  if (answers.gitInit) {
    await initializeGit(result.projectRoot, output);
  }

  output.blank();
  output.info(style.bold('Next steps'));
  output.info(
    formatRows([
      ['1.', `cd ${relative(process.cwd(), result.projectRoot) || '.'}`],
      ['2.', 'cp .env.example .env    # then fill in DATABASE_URL and the JWT secrets'],
      ['3.', 'npm install'],
      ['4.', 'npm run db:deploy && npm run db:seed'],
      ['5.', 'npm run dev'],
    ]),
  );
  output.blank();
  output.detail('  Read AGENTS.md before pointing an AI coding agent at this project.');

  return 0;
}

/**
 * Initializes a git repository.
 *
 * `execFile` with an argument array, never a shell string: the project path
 * comes from user input, and a shell would interpret anything in it. There is
 * no `git commit` — what to commit, and under whose name, is the user's call.
 */
async function initializeGit(projectRoot: string, output: Output): Promise<void> {
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: projectRoot, timeout: 10_000 });
    output.detail('  initialized an empty git repository');
  } catch {
    output.warn('Could not initialize a git repository (is git installed?). Continuing.');
  }
}

import { Command } from 'commander';
import { isGeneratorError } from '@trustos/generator-core';
import { CLI_VERSION } from './version';
import { createOutput, formatRows, type Output } from './output';
import { runNew } from './commands/new';
import { runListTemplates } from './commands/list-templates';
import { runValidateTemplate } from './commands/validate-template';
import { runDoctor, type DoctorReport } from './commands/doctor';
import { runAddModule, runUpgrade } from './commands/placeholders';

/**
 * The CLI program.
 *
 * Built as a function returning a configured `Command` so tests can execute it
 * in-process — `parseAsync` with an argv array — rather than spawning a shell.
 * Argument parsing is the part most likely to regress, and it deserves fast
 * tests.
 */

export interface BuildProgramOptions {
  output?: Output;
  /** Overridden by tests so nothing calls process.exit. */
  exit?: (code: number) => void;
}

export function buildProgram(options: BuildProgramOptions = {}): Command {
  const output = options.output ?? createOutput();
  const program = new Command();

  let exitCode = 0;
  const setExit = (code: number) => {
    exitCode = code;
    options.exit?.(code);
  };

  program
    .name('trustos')
    .description('Generate production-ready TrustOS applications from approved templates.')
    .version(CLI_VERSION, '-v, --version', 'print the CLI version')
    .showHelpAfterError('(run `trustos --help` for usage)')
    .configureHelp({ sortSubcommands: true });

  // --- new ------------------------------------------------------------------
  program
    .command('new')
    .argument('<template>', 'template id, e.g. merchant')
    .description('create a new TrustOS application')
    .option('--name <name>', 'application name (directory)')
    .option('--package-name <name>', 'npm package name')
    .option('--organization <name>', 'owning organization')
    .option('--display-name <name>', 'product display name')
    .option('--description <text>', 'one-line description')
    .option('--port <port>', 'API port in development')
    .option('--deploy <target>', 'railway | local')
    .option('--no-api', 'do not generate the API')
    .option('--no-admin', 'do not generate the admin application')
    .option('--no-auth', 'do not wire authentication')
    .option('--roles <list>', 'comma-separated initial roles')
    .option('--no-git', 'do not initialize a git repository')
    .option('-y, --yes', 'accept defaults; never prompt')
    .option('--dry-run', 'show what would be written, write nothing')
    .option('--force', 'overwrite existing files')
    .option('--verbose', 'list every file')
    .option('--target-dir <path>', 'directory to create the project in')
    .option('--templates-root <path>', 'override the templates directory')
    .option(
      '--framework-path <path>',
      'link @trustos/* to a local framework checkout (needed until the packages are published)',
    )
    .option('--generated-at <iso>', 'fix the generation timestamp (for reproducible output)')
    .action(async (template: string, opts: Record<string, unknown>) => {
      setExit(
        await runNew(
          template,
          {
            ...(opts as Record<string, never>),
            cliVersion: CLI_VERSION,
          },
          output,
        ),
      );
    });

  // --- list-templates -------------------------------------------------------
  program
    .command('list-templates')
    .description('list the approved templates')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'show apps, entities, owner and exclusions')
    .action((opts: { json?: boolean; verbose?: boolean }) => {
      setExit(runListTemplates(opts, output));
    });

  // --- validate-template ----------------------------------------------------
  program
    .command('validate-template')
    .argument('[template]', 'template id; omit to validate all')
    .description('check a template against the generator contract')
    .option('--json', 'machine-readable output')
    .option('--all', 'validate every registered template')
    .option('--templates-root <path>', 'override the templates directory')
    .action(async (template: string | undefined, opts: Record<string, unknown>) => {
      setExit(await runValidateTemplate(template, opts, output));
    });

  // --- doctor ---------------------------------------------------------------
  program
    .command('doctor')
    .description('check that this machine can generate and run TrustOS applications')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const report = await runDoctor();
      setExit(printDoctorReport(report, opts, output));
    });

  // --- placeholders ---------------------------------------------------------
  program
    .command('add-module')
    .argument('[module]', 'module to add')
    .description('(not implemented in this phase) add a module to an application')
    .action((moduleName: string | undefined) => {
      setExit(runAddModule(moduleName, output));
    });

  program
    .command('upgrade')
    .description('(not implemented in this phase) upgrade an application to a newer framework')
    .action(() => {
      setExit(runUpgrade(output));
    });

  program.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  trustos new merchant                     interactive',
      '  trustos new generic-saas --yes           accept every default',
      '  trustos new learning --dry-run --verbose preview every file',
      '  trustos list-templates --verbose',
      '  trustos validate-template --all',
      '  trustos doctor',
      '',
      'Docs: docs/cli.md',
    ].join('\n'),
  );

  Object.defineProperty(program, 'trustosExitCode', { get: () => exitCode });
  return program;
}

export function printDoctorReport(
  report: DoctorReport,
  options: { json?: boolean },
  output: Output,
): number {
  if (options.json) {
    output.info(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  output.info('TrustOS environment check');
  output.blank();

  for (const check of report.checks) {
    const line = `${check.status.padEnd(4)} ${check.name.padEnd(22)} ${check.detail}`;
    if (check.status === 'FAIL') output.error(line);
    else if (check.status === 'WARN') output.warn(line);
    else output.success(line);

    if (check.remedy && check.status !== 'PASS') output.detail(`       ${check.remedy}`);
  }

  output.blank();
  const failed = report.checks.filter((check) => check.status === 'FAIL').length;
  const warned = report.checks.filter((check) => check.status === 'WARN').length;

  output.detail(
    formatRows([
      ['checks', String(report.checks.length)],
      ['failed', String(failed)],
      ['warnings', `${warned} (optional tooling; not a problem)`],
    ]),
  );

  if (report.ok) output.success('Ready to generate TrustOS applications.');
  else output.error('Fix the failures above before generating.');

  return report.ok ? 0 : 1;
}

export interface RunOptions {
  /** Overridden by tests so output can be captured instead of printed. */
  output?: Output;
  /** Set `process.exitCode` on failure. Off in tests. */
  setProcessExitCode?: boolean;
}

/**
 * Runs the CLI and resolves with the process exit code.
 *
 * Errors are reported as a message plus a hint rather than a stack trace: a
 * stack is noise for a user who mistyped a template id, and the real
 * diagnostics belong in `--verbose`.
 *
 * Injectable output and exit handling so the tests exercise *this* function —
 * the error mapping below is the part that decides whether a failure surfaces
 * as a clear message or as a wall of stack, and it needs covering.
 */
export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const output = options.output ?? createOutput();
  let exitCode = 0;
  const program = buildProgram({ output, exit: (code) => void (exitCode = code) });

  // Commander exits the process on a usage error unless told otherwise. Applied
  // to subcommands too: `trustos new` with no argument is handled by the
  // subcommand, not the program.
  program.exitOverride();
  for (const command of program.commands) command.exitOverride();

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (isGeneratorError(error)) {
      output.error(error.message);
      if (error.hint) output.detail(`  ${error.hint}`);
      exitCode = 1;
    } else if (isCommanderExit(error)) {
      // --help and --version throw by design.
      exitCode = error.exitCode;
    } else if (isPromptCancellation(error)) {
      output.blank();
      output.info('Cancelled.');
      exitCode = 130;
    } else {
      output.error(error instanceof Error ? error.message : String(error));
      exitCode = 1;
    }
  }

  if (exitCode !== 0 && options.setProcessExitCode !== false) process.exitCode = exitCode;
  return exitCode;
}

function isCommanderExit(error: unknown): error is { exitCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('commander.')
  );
}

/** Ctrl-C at a prompt. Inquirer signals this with an ExitPromptError. */
function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}

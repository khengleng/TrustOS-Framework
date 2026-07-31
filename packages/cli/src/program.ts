import { Command } from 'commander';
import { isGeneratorError } from '@trustos/generator-core';
import { CLI_VERSION } from './version';
import { createOutput, formatRows, style, type Output } from './output';
import { runNew } from './commands/new';
import { runListTemplates } from './commands/list-templates';
import { runTemplates } from './commands/templates';
import {
  runArchitectureCheck,
  runMarketplace,
  runMarketplaceCategories,
  runPlatformInfo,
} from './commands/platform';
import { runDocs, runPlugins, runReleaseList, runValidate } from './commands/lifecycle';
import {
  runInstall,
  runOutdated,
  runRemove,
  runTelemetryReview,
  runUpdate,
} from './commands/packages';
import { generateSlice, parseSlice, describeGeneration } from '@trustos/code-generator';
import { generateCliDocs } from '@trustos/documentation-center';
import { PluginRegistry } from '@trustos/plugin-framework';
import { ReleaseManager } from '@trustos/release-manager';
import { runTemplateDoctor, runUpdateTemplate } from './commands/template-doctor';
import { runValidateTemplate } from './commands/validate-template';
import { runWorkflowList, runWorkflowSimulate, runWorkflowValidate } from './commands/workflow';
import { runDoctor, type DoctorReport } from './commands/doctor';
import { runDoctorIntegrations } from './commands/doctor-integrations';
import {
  runAiDoctor,
  runAiEvaluate,
  runAiListAgents,
  runAiListModels,
  runAiValidatePrompts,
} from './commands/ai';
import { runFinancialDoctor } from './commands/financial';
import { runAddModule } from './commands/add-module';
import { runListModules } from './commands/list-modules';
import { runUpgrade } from './commands/upgrade';

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

/**
 * Merges a `--json` that Commander assigned to the parent command.
 *
 * When a parent and a subcommand both declare `--json`, Commander 12 puts the value on the
 * *parent* — so `trustos doctor template --json` leaves the subcommand's copy undefined and the
 * flag is silently ignored. A script piping the output into jq gets a table instead, which reads
 * as the command being broken rather than the flag being dropped.
 */
function withParentJson<T extends { json?: boolean }>(
  opts: T,
  command: { parent?: { opts: () => { json?: boolean } } },
): T {
  return { ...opts, json: opts.json ?? command.parent?.opts().json };
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
    .option(
      '--identity-provider <mode>',
      'local | oidc — local passwords, or an OIDC issuer such as Keycloak',
    )
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

  // --- install / update / remove --------------------------------------------
  //
  // These change the lockfile — what is recorded as installed, at which version, hashing to what.
  // Wiring a module into the composition root stays `add-module`, which writes code and therefore
  // has a different blast radius.
  //
  // Every one plans first. `--dry-run` is the same plan, unapplied.
  program
    .command('install')
    .argument('<module>', 'module id from the catalogue')
    .description('record a module and its dependencies in the lockfile')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--version <range>', 'version range, e.g. ^1.2.0')
    .option('--dry-run', 'show the plan without applying it')
    .option('--json', 'machine-readable output')
    .action(async (module: string, opts: Record<string, never>) => {
      setExit(await runInstall(module, opts, output));
    });

  program
    .command('update')
    .argument('[module]', 'module id; omit to update everything')
    .description('move modules to their newest compatible version')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--version <range>', 'version range, e.g. ^1.2.0')
    .option('--dry-run', 'show the plan without applying it')
    .option('--json', 'machine-readable output')
    .action(async (module: string | undefined, opts: Record<string, never>) => {
      setExit(await runUpdate(module, opts, output));
    });

  program
    .command('remove')
    .argument('<module>', 'module id')
    .description('remove a module, refusing while something depends on it')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--dry-run', 'show the plan without applying it')
    .option('--json', 'machine-readable output')
    .action(async (module: string, opts: Record<string, never>) => {
      setExit(await runRemove(module, opts, output));
    });

  program
    .command('outdated')
    .description('list modules with a newer version available')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--json', 'machine-readable output')
    .action(async (opts: Record<string, never>) => {
      setExit(await runOutdated(opts, output));
    });

  // --- generate -------------------------------------------------------------
  //
  // Emits a whole CRUD slice from one declaration. Prints the files by default: generation writes
  // code into somebody's project, and a command that did that the first time it was run to see
  // what it does would be a bad first impression at best.
  const generate = program.command('generate').description('generate code from a declaration');

  generate
    .command('crud')
    .description(
      'a tenant-scoped CRUD slice: model, types, repository, service, controller, tests, docs',
    )
    .requiredOption('--spec <file>', 'JSON slice declaration')
    .option('--out <dir>', 'where to write (default: cwd)')
    .option('--write', 'write the files (prints them by default)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { spec: string; out?: string; write?: boolean; json?: boolean }) => {
      const { readFile, mkdir, writeFile } = await import('node:fs/promises');
      const { dirname, join } = await import('node:path');

      const slice = parseSlice(JSON.parse(await readFile(opts.spec, 'utf8')));
      const files = generateSlice(slice);

      if (opts.json) {
        output.info(JSON.stringify(files, null, 2));
        setExit(0);
        return;
      }

      output.info(describeGeneration(files));
      output.blank();
      output.info(files.map((file) => `  ${file.path}`).join('\n'));
      output.blank();

      if (!opts.write) {
        output.detail('  Nothing was written. Re-run with --write to generate them.');
        setExit(0);
        return;
      }

      const root = opts.out ?? process.cwd();

      for (const file of files) {
        const target = join(root, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, 'utf8');
      }

      output.success(`Wrote ${files.length} file(s).`);
      output.detail('  Every query is tenant-scoped, every write audited, every route guarded.');
      setExit(0);
    });

  // --- telemetry ------------------------------------------------------------
  const telemetry = program
    .command('telemetry')
    .description('what this installation collects, and where it goes');

  telemetry
    .command('review')
    .description('show exactly what an export would contain')
    .option('--json', 'machine-readable output')
    .action((opts: { json?: boolean }) => {
      setExit(runTelemetryReview(opts, output));
    });

  // --- platform -------------------------------------------------------------
  //
  // A group, like `ai` and `workflow`. Every subcommand is offline and read-only: they report
  // state and refuse operations, which is what makes them usable at the moment they are most
  // needed — deciding whether to start a system, or during an incident when it will not start.
  const platform = program
    .command('platform')
    .description('inspect the platform: version, modules, health, licence, compatibility');

  platform
    .command('info')
    .description('one view of the platform, offline')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'show what to do about each finding')
    .action(async (opts: { path?: string; json?: boolean; verbose?: boolean }) => {
      setExit(await runPlatformInfo(opts, output));
    });

  // --- marketplace ----------------------------------------------------------
  const marketplace = program
    .command('marketplace')
    .argument('[term]', 'search text')
    .description('browse the local module catalogue')
    .option('--json', 'machine-readable output')
    .option('--category <tag>', 'only one category')
    .option('--signed-only', 'only modules with a signature')
    .option('--verbose', 'show dependencies and exclusions')
    .action(
      async (
        term: string | undefined,
        opts: { json?: boolean; category?: string; signedOnly?: boolean; verbose?: boolean },
        command: { args: string[] },
      ) => {
        // Commander runs the parent action for an unknown subcommand too.
        if (command?.args?.[0] === 'categories') return;
        setExit(await runMarketplace(term, opts, output));
      },
    );

  marketplace
    .command('categories')
    .description('list the categories and how many modules are in each')
    .action(() => {
      setExit(runMarketplaceCategories(output));
    });

  // --- architecture-check ---------------------------------------------------
  program
    .command('architecture-check')
    .description('layering, naming, dependency direction and the security rules')
    .option('--path <dir>', 'repository root (default: cwd)')
    .option('--json', 'machine-readable output')
    .option('--strict', 'treat warnings as failures')
    .action(async (opts: { path?: string; json?: boolean; strict?: boolean }) => {
      setExit(await runArchitectureCheck(opts, output));
    });

  // --- plugins --------------------------------------------------------------
  //
  // Reads whatever registry it is handed. There is deliberately no global plugin state for it to
  // discover: a CLI that could find and load plugins on its own would run them in order to list
  // them.
  program
    .command('plugins')
    .description('list installed plugins and what each one can do')
    .option('--json', 'machine-readable output')
    .option('--privileged', 'only those holding a permission that makes them arbitrary code')
    .option('--unsigned', 'only those installed without a signature')
    .action((opts: { json?: boolean; privileged?: boolean; unsigned?: boolean }) => {
      setExit(runPlugins(new PluginRegistry(), opts, output));
    });

  // --- release --------------------------------------------------------------
  const release = program
    .command('release')
    .description('the release register and the support lifecycle');

  release
    .command('list')
    .description('what is released, on which channel, and until when')
    .option('--json', 'machine-readable output')
    .option('--all', 'include end-of-life releases')
    .action((opts: { json?: boolean; all?: boolean }) => {
      setExit(runReleaseList(new ReleaseManager([]), opts, output));
    });

  // --- validate -------------------------------------------------------------
  //
  // Takes the results of the tools that already run rather than running them: a gate that shelled
  // out would behave differently in CI, on a laptop and in a pre-commit hook.
  program
    .command('validate')
    .description('run the quality gates against supplied results')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'show what to do about each failure')
    .option('--results <file>', 'JSON file of tool results to gate on')
    .action(async (opts: { json?: boolean; verbose?: boolean; results?: string }) => {
      let input = {};

      if (opts.results) {
        const { readFile } = await import('node:fs/promises');
        input = JSON.parse(await readFile(opts.results, 'utf8'));
      }

      setExit(runValidate(input, opts, output));
    });

  // --- docs -----------------------------------------------------------------
  program
    .command('docs')
    .description('generate the reference documentation')
    .option('--json', 'machine-readable output')
    .option('--write', 'write the pages (prints them by default)')
    .option('--output-dir <dir>', 'where to write (default: cwd)')
    .action(async (opts: { json?: boolean; write?: boolean; outputDir?: string }) => {
      const pages = [
        generateCliDocs(
          program.commands.map((command) => ({
            name: command.name(),
            description: command.description(),
            subcommands: command.commands.map((sub) => ({
              name: sub.name(),
              description: sub.description(),
            })),
          })),
        ),
      ];

      setExit(await runDocs(pages, { ...opts, outputDirectory: opts.outputDir }, output));
    });

  // --- templates ------------------------------------------------------------
  //
  // The catalog, grouped by category and showing inheritance. `list-templates` prints a flat
  // list, which was right for six templates and is wrong for thirty — it is kept unchanged
  // because scripts call it.
  program
    .command('templates')
    .description('browse the template library by category')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'show apps, entities, children, owner and exclusions')
    .option('--category <name>', 'only one category')
    .option('--all', 'include deprecated templates')
    .action((opts: { json?: boolean; verbose?: boolean; category?: string; all?: boolean }) => {
      setExit(runTemplates(opts, output));
    });

  // --- update-template ------------------------------------------------------
  //
  // Reports, never rewrites. By the time a project is worth upgrading somebody has edited most
  // of what the template wrote, and re-rendering over their work would clobber it — see the
  // header of template-doctor.ts.
  program
    .command('update-template')
    .description('report what has changed in the template since this project was generated')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { path?: string; json?: boolean }) => {
      setExit(await runUpdateTemplate(opts, output));
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
    .option('--framework-version <version>', 'check compatibility against this framework version')
    .action(async (template: string | undefined, opts: Record<string, unknown>) => {
      setExit(await runValidateTemplate(template, opts, output));
    });

  // --- workflow -------------------------------------------------------------
  //
  // A command group rather than three top-level commands, because `trustos workflow
  // validate` reads as a sentence and `trustos validate-workflow` does not — and because
  // the group is where a future `workflow diff` belongs.
  //
  // Every subcommand is read-only and offline: no database, no network, nothing created.
  // These are the commands somebody runs while deciding whether to publish, and a tool that
  // needed a running application would not be run then.
  const workflow = program
    .command('workflow')
    .description('validate, simulate and inspect workflow definitions');

  workflow
    .command('validate')
    .argument('<file>', 'workflow definition (JSON)')
    .description('validate a workflow definition; exits non-zero when it is invalid')
    .option('--json', 'machine-readable output')
    .option(
      '--strict-permissions',
      'check permission references against the framework catalog (off by default: a ' +
        'definition may reference product permissions this CLI does not know)',
    )
    .option('--permissions <list>', 'comma-separated product permission keys to accept')
    .action(async (file: string, opts: Record<string, unknown>) => {
      setExit(await runWorkflowValidate(file, opts, output));
    });

  workflow
    .command('simulate')
    .argument('<file>', 'workflow definition (JSON)')
    .description('walk every path through a definition; reports dead ends and unreviewed paths')
    .option('--json', 'machine-readable output')
    .action(async (file: string, opts: Record<string, unknown>) => {
      setExit(await runWorkflowSimulate(file, opts, output));
    });

  workflow
    .command('list')
    .description('list the workflow definitions shipped with the framework')
    .option('--json', 'machine-readable output')
    .action((opts: Record<string, unknown>) => {
      setExit(runWorkflowList(opts, output));
    });

  // --- doctor ---------------------------------------------------------------
  //
  // `doctor` checks the machine; `doctor integrations` checks one application's integration
  // wiring. A subcommand rather than a flag, because the two answer different questions and
  // share nothing but the word.
  const doctor = program
    .command('doctor')
    .description('check that this machine can generate and run TrustOS applications')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, command: { args: string[] }) => {
      // Commander runs the parent action for an unknown subcommand too, so an obvious typo would
      // otherwise silently run the machine check and report success.
      if (command?.args?.length) return;
      const report = await runDoctor();
      setExit(printDoctorReport(report, opts, output));
    });

  doctor
    .command('all')
    .description('every doctor check: machine, template, integrations, financial and platform')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .action(async (opts: { path?: string }) => {
      /*
       * Runs each check and reports the worst outcome. Sequential rather than parallel: the output
       * is read top to bottom by a person, and interleaved sections from five checks are unreadable
       * exactly when somebody is debugging.
       */
      const checks: Array<[string, () => Promise<number>]> = [
        ['machine', async () => printDoctorReport(await runDoctor(), {}, output)],
        ['template', () => runTemplateDoctor(opts, output)],
        ['integrations', () => runDoctorIntegrations(opts, output)],
        ['financial', () => runFinancialDoctor(opts, output)],
        ['platform', () => runPlatformInfo(opts, output)],
      ];

      let worst = 0;

      for (const [name, run] of checks) {
        output.blank();
        output.info(style.bold(`── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`));
        output.blank();

        try {
          worst = Math.max(worst, await run());
        } catch (error) {
          output.error(
            `${name} check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          worst = 1;
        }
      }

      setExit(worst);
    });

  doctor
    .command('template')
    .description('check that a generated application still matches the template it came from')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--json', 'machine-readable output')
    .action(
      async (
        opts: { path?: string; json?: boolean },
        command: { parent?: { opts: () => { json?: boolean } } },
      ) => {
        setExit(await runTemplateDoctor(withParentJson(opts, command), output));
      },
    );

  doctor
    .command('integrations')
    .description('check an application’s event, webhook, job, schedule and sync wiring')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'explain what this check cannot see')
    .action(
      async (
        opts: { path?: string; json?: boolean; verbose?: boolean },
        command: { parent?: { opts: () => { json?: boolean } } },
      ) => {
        setExit(await runDoctorIntegrations(withParentJson(opts, command), output));
      },
    );

  // --- ai -------------------------------------------------------------------
  //
  // A group, for the same reason `workflow` is one: `trustos ai list-models` reads as a sentence.
  //
  // Every subcommand is offline — no database, no network, no model call, no credentials. That is
  // what makes them usable on a laptop against a checkout, which is when somebody asks these
  // questions. `ai evaluate` therefore validates suites and compares recorded runs rather than
  // calling a model; the run that calls models happens inside the application, where the gateway
  // and the credentials are.
  const ai = program
    .command('ai')
    .description('inspect an application’s AI platform: models, agents, prompts, evaluations');

  ai.command('doctor')
    .description('check an application’s AI wiring, schema, catalog and secrets')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'explain what this check cannot see')
    .action(async (opts: { path?: string; json?: boolean; verbose?: boolean }) => {
      setExit(await runAiDoctor(opts, output));
    });

  ai.command('list-models')
    .description('list the models this application registers')
    .option('--path <dir>', 'application directory')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'show capabilities, pricing age and tenant restrictions')
    .action(async (opts: { path?: string; json?: boolean; verbose?: boolean }) => {
      setExit(await runAiListModels(opts, output));
    });

  ai.command('list-agents')
    .description('list the agents this application registers')
    .option('--path <dir>', 'application directory')
    .option('--json', 'machine-readable output')
    .action(async (opts: { path?: string; json?: boolean }) => {
      setExit(await runAiListAgents(opts, output));
    });

  ai.command('validate-prompts')
    .description('check prompt templates: syntax, variables, components and injection flags')
    .option('--path <dir>', 'application directory')
    .option('--json', 'machine-readable output')
    .action(async (opts: { path?: string; json?: boolean }) => {
      setExit(await runAiValidatePrompts(opts, output));
    });

  ai.command('evaluate')
    .description('validate evaluation suites, or compare two recorded runs')
    .option('--path <dir>', 'application directory')
    .option('--baseline <file>', 'a recorded run to compare against')
    .option('--candidate <file>', 'the run to compare')
    .option('--tolerance <number>', 'score movement to ignore as noise (default 0.05)')
    .option('--json', 'machine-readable output')
    .action(
      async (opts: {
        path?: string;
        baseline?: string;
        candidate?: string;
        tolerance?: string;
        json?: boolean;
      }) => {
        setExit(await runAiEvaluate(opts, output));
      },
    );

  // --- financial ------------------------------------------------------------
  //
  // A group, for the same reason `ai` and `workflow` are. Offline, like every other doctor here:
  // the questions it answers are asked on a laptop against a checkout.
  //
  // The interesting checks are not "is it installed" — they are the ledger triggers and the
  // floating-point scan. A financial application with the tables and none of the guarantees works
  // perfectly and is wrong, which is the state this command exists to find.
  const financial = program
    .command('financial')
    .description('inspect an application’s financial wiring, schema and precision');

  financial
    .command('doctor')
    .description('check ledger wiring, schema, database guarantees, currencies and precision')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'explain what this check cannot see')
    .action(async (opts: { path?: string; json?: boolean; verbose?: boolean }) => {
      setExit(await runFinancialDoctor(opts, output));
    });

  // --- list-modules ---------------------------------------------------------
  program
    .command('list-modules')
    .description('list the modules that can be installed')
    .option('--json', 'machine-readable output')
    .option('--verbose', 'show permissions, routes, configuration and extension points')
    .action((opts: { json?: boolean; verbose?: boolean }) => {
      setExit(runListModules(opts, output));
    });

  // --- add-module -----------------------------------------------------------
  program
    .command('add-module')
    .argument('[modules...]', 'module ids, e.g. notification document')
    .description('install modules into a generated application')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option(
      '--framework-path <dir>',
      'framework checkout to install from (needed until the packages are published)',
    )
    .option('--include-optional', 'install optional dependencies too')
    .option('--dry-run', 'show what would change, write nothing')
    .option('--force', 'allow a deprecated module')
    .option('--verbose', 'list every file')
    .option('--json', 'machine-readable plan')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--generated-at <iso>', 'fix the install timestamp (for reproducible output)')
    .action(async (modules: string[] | undefined, opts: Record<string, unknown>) => {
      setExit(await runAddModule(modules ?? [], opts as Record<string, never>, output));
    });

  program
    .command('upgrade')
    .description('plan an upgrade to a newer framework version')
    .option('--path <dir>', 'application directory (default: nearest trustos.json)')
    .option('--to <version>', 'target version (default: the newest supported release)')
    .option('--registry-dir <dir>', 'where releases.json, history.json and migrations.json live')
    .option('--json', 'machine-readable output')
    .action(async (opts: { path?: string; to?: string; registryDir?: string; json?: boolean }) => {
      setExit(await runUpgrade(opts, output));
    });

  program.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  trustos new merchant                     interactive',
      '  trustos new generic-saas --yes           accept every default',
      '  trustos new learning --dry-run --verbose preview every file',
      '  trustos platform info',
      '  trustos doctor all',
      '  trustos install search --dry-run',
      '  trustos marketplace search',
      '  trustos architecture-check',
      '  trustos templates --category health',
      '  trustos templates --verbose',
      '  trustos validate-template --all',
      '  trustos list-modules --verbose',
      '  trustos add-module notification --dry-run',
      '  trustos add-module document --yes      also installs file-storage',
      '  trustos doctor',
      '',
      'Docs: docs/cli.md, docs/modules.md',
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

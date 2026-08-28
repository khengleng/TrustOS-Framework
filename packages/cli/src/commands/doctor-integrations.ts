import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODULE_CATALOG } from '@trustos/module-registry';
import { formatRows, style, type Output } from '../output';

/**
 * `trustos doctor integrations`.
 *
 * Static analysis of an application's integration layer: what is installed, what is declared,
 * and what is configured but unreachable. Deliberately **offline** — no database, no network,
 * nothing started.
 *
 * That constraint is what makes the command useful. A doctor that needed a running application
 * could not be run on a laptop against a checkout, which is exactly when somebody wants to know
 * why their webhooks are not firing. Anything requiring a live system belongs on the health
 * endpoint, and this command says so rather than pretending to check it.
 */

export interface DoctorIntegrationsOptions {
  path?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface IntegrationFinding {
  area: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  detail: string;
  /** What to do. Omitted when there is nothing to do. */
  remediation?: string;
}

export interface DoctorIntegrationsReport {
  applicationRoot: string | null;
  installed: string[];
  findings: IntegrationFinding[];
  ok: boolean;
}

/** The integration modules, in the order they appear in the catalog. */
const INTEGRATION_MODULE_IDS = [
  'events',
  'webhook',
  'jobs',
  'scheduler',
  'adapter',
  'import',
  'export',
  'sync',
];

export async function runDoctorIntegrations(
  options: DoctorIntegrationsOptions,
  output: Output,
): Promise<number> {
  const applicationRoot = options.path ?? findApplicationRoot(process.cwd());
  const findings: IntegrationFinding[] = [];

  if (!applicationRoot) {
    output.error('No trustos.json found in this directory or any parent.');
    output.blank();
    output.detail('  Run this inside a generated application, or pass --path <dir>.');
    return 1;
  }

  const packageJson = await readJson(join(applicationRoot, 'package.json'));
  const dependencies = {
    ...((packageJson?.dependencies as Record<string, string>) ?? {}),
    ...((packageJson?.devDependencies as Record<string, string>) ?? {}),
  };

  const installed = INTEGRATION_MODULE_IDS.filter((id) => `@trustos/module-${id}` in dependencies);

  if (installed.length === 0) {
    findings.push({
      area: 'installed modules',
      status: 'INFO',
      detail: 'No integration modules are installed.',
      remediation: `Install one with: trustos add-module ${INTEGRATION_MODULE_IDS.join('|')}`,
    });
  } else {
    findings.push({
      area: 'installed modules',
      status: 'PASS',
      detail: `${installed.length} installed: ${installed.join(', ')}.`,
    });
  }

  findings.push(...checkDependencies(installed));
  findings.push(...(await checkEnvironment(applicationRoot, installed)));
  findings.push(...(await checkWiring(applicationRoot, installed)));
  findings.push(...(await checkSchema(applicationRoot, installed)));
  findings.push(...checkWorkerProcesses(installed, packageJson));

  const report: DoctorIntegrationsReport = {
    applicationRoot,
    installed,
    findings,
    ok: findings.every((finding) => finding.status !== 'FAIL'),
  };

  if (options.json) {
    output.info(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  print(report, output, options.verbose === true);
  return report.ok ? 0 : 1;
}

/**
 * A module whose dependency is not installed.
 *
 * The scheduler without the jobs module is the case that matters: a schedule enqueues a job, so
 * a scheduler with no job runtime fires into nothing. Nothing errors — the schedules simply do
 * not happen, which is the hardest kind of failure to notice.
 */
function checkDependencies(installed: string[]): IntegrationFinding[] {
  const findings: IntegrationFinding[] = [];
  const present = new Set(installed);

  for (const id of installed) {
    const entry = MODULE_CATALOG.find((candidate) => candidate.metadata.id === id);
    if (!entry) continue;

    for (const dependency of entry.dependencies) {
      if (present.has(dependency.moduleId)) continue;

      findings.push({
        area: `${id} dependencies`,
        status: 'FAIL',
        detail: `${id} needs ${dependency.moduleId}, which is not installed. ${dependency.reason}`,
        remediation: `trustos add-module ${dependency.moduleId}`,
      });
    }
  }

  if (findings.length === 0 && installed.length > 0) {
    findings.push({
      area: 'module dependencies',
      status: 'PASS',
      detail: 'Every installed module has its dependencies.',
    });
  }

  return findings;
}

/**
 * Environment variables a module declares but the application does not document.
 *
 * Checked against `.env.example` rather than against the process environment, because the
 * process running the CLI is not the process running the application — and a check against
 * `process.env` would pass on a developer's machine and tell them nothing about production.
 */
async function checkEnvironment(
  applicationRoot: string,
  installed: string[],
): Promise<IntegrationFinding[]> {
  const examplePath = join(applicationRoot, '.env.example');

  if (!existsSync(examplePath)) {
    return installed.length === 0
      ? []
      : [
          {
            area: 'configuration',
            status: 'WARN',
            detail: 'No .env.example, so required configuration is undocumented.',
            remediation: 'Add one listing every variable the application needs.',
          },
        ];
  }

  const example = await readFile(examplePath, 'utf8');
  const findings: IntegrationFinding[] = [];

  for (const id of installed) {
    const entry = MODULE_CATALOG.find((candidate) => candidate.metadata.id === id);
    if (!entry) continue;

    const missing = entry.environment.filter(
      (variable) => !new RegExp(`^\\s*#?\\s*${variable.name}\\s*=`, 'm').test(example),
    );

    for (const variable of missing) {
      findings.push({
        area: `${id} configuration`,
        // A warning rather than a failure: the variable may be supplied by the platform rather
        // than by a file, and failing would make the command useless on such a deployment.
        status: 'WARN',
        detail: `${variable.name} is not in .env.example. ${variable.description}`,
        remediation: `Add ${variable.name} to .env.example so the next person knows it exists.`,
      });
    }
  }

  if (findings.length === 0 && installed.length > 0) {
    findings.push({
      area: 'configuration',
      status: 'PASS',
      detail: 'Every declared variable appears in .env.example.',
    });
  }

  return findings;
}

/**
 * A module installed but never imported.
 *
 * The most common integration failure by a distance: `add-module` adds the dependency, nobody
 * adds the import, and the module does nothing at all. There is no error, no log line, and no
 * way to tell from the outside.
 */
async function checkWiring(
  applicationRoot: string,
  installed: string[],
): Promise<IntegrationFinding[]> {
  const compositionRoots = [
    'apps/api/src/app.module.ts',
    'src/app.module.ts',
    'apps/worker/src/worker.module.ts',
  ].map((relative) => join(applicationRoot, relative));

  const sources = await Promise.all(
    compositionRoots.filter((path) => existsSync(path)).map((path) => readFile(path, 'utf8')),
  );

  if (sources.length === 0) {
    return installed.length === 0
      ? []
      : [
          {
            area: 'wiring',
            status: 'WARN',
            detail: 'No composition root found, so module wiring could not be checked.',
          },
        ];
  }

  const combined = sources.join('\n');
  const findings: IntegrationFinding[] = [];

  for (const id of installed) {
    const entry = MODULE_CATALOG.find((candidate) => candidate.metadata.id === id);
    if (!entry) continue;

    if (combined.includes(entry.packaging.nestModule.importPath)) continue;

    findings.push({
      area: `${id} wiring`,
      status: 'FAIL',
      detail: `${id} is installed but never imported, so it does nothing.`,
      remediation:
        `Import ${entry.packaging.nestModule.className} from ` +
        `'${entry.packaging.nestModule.importPath}' in the composition root.`,
    });
  }

  if (findings.length === 0 && installed.length > 0) {
    findings.push({
      area: 'wiring',
      status: 'PASS',
      detail: 'Every installed module is imported.',
    });
  }

  return findings;
}

/**
 * Whether the framework schema carries the integration tables.
 *
 * A generated application has a *copy* of the framework schema. If it was generated before the
 * integration layer existed, the copy has no `job` table — and the first symptom is a runtime
 * error from Prisma about a model that does not exist.
 */
async function checkSchema(
  applicationRoot: string,
  installed: string[],
): Promise<IntegrationFinding[]> {
  if (installed.length === 0) return [];

  const schemaPath = join(applicationRoot, 'prisma/schema/00-framework.prisma');

  if (!existsSync(schemaPath)) {
    return [
      {
        area: 'schema',
        status: 'WARN',
        detail:
          'No prisma/schema/00-framework.prisma, so the integration tables could not be checked.',
      },
    ];
  }

  const schema = await readFile(schemaPath, 'utf8');

  const REQUIRED_MODELS: Record<string, string[]> = {
    events: ['EventDeadLetter', 'EventDeliveryLedger'],
    webhook: ['WebhookEndpoint', 'WebhookSecret', 'WebhookDelivery'],
    jobs: ['Job', 'JobRun'],
    scheduler: ['Schedule', 'ScheduleRun'],
    import: ['ImportRun'],
    export: ['ExportRun'],
    sync: ['SyncConnection', 'SyncRun', 'SyncConflict'],
  };

  const findings: IntegrationFinding[] = [];

  for (const id of installed) {
    const models = REQUIRED_MODELS[id] ?? [];
    const missing = models.filter((model) => !new RegExp(`^model ${model} \\{`, 'm').test(schema));

    if (missing.length === 0) continue;

    findings.push({
      area: `${id} schema`,
      status: 'FAIL',
      detail: `The framework schema copy is missing: ${missing.join(', ')}.`,
      remediation:
        'This application was generated before the integration layer. Re-run ' +
        '`node scripts/sync-schema-fragments.mjs` in the framework and copy ' +
        'prisma/schema/00-framework.prisma across, then run a migration.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      area: 'schema',
      status: 'PASS',
      detail: 'The framework schema copy has every table the installed modules need.',
    });
  }

  return findings;
}

/**
 * Whether anything is going to run the queues.
 *
 * The jobs, scheduler and webhook modules all need a process that is not the API: a worker loop
 * polling for work. Installing the module does not start one. This is the second most common
 * integration failure — everything is configured, nothing is processed, and the queue silently
 * fills up.
 */
function checkWorkerProcesses(
  installed: string[],
  packageJson: Record<string, unknown> | null,
): IntegrationFinding[] {
  const needsWorker = installed.filter((id) => ['jobs', 'scheduler', 'webhook'].includes(id));
  if (needsWorker.length === 0) return [];

  const scripts = (packageJson?.scripts as Record<string, string>) ?? {};
  const hasWorkerScript = Object.keys(scripts).some((name) => /worker|jobs?|scheduler/i.test(name));

  if (hasWorkerScript) {
    return [
      {
        area: 'worker process',
        status: 'PASS',
        detail: `A worker script is defined, which ${needsWorker.join(', ')} need.`,
      },
    ];
  }

  return [
    {
      area: 'worker process',
      status: 'WARN',
      detail:
        `${needsWorker.join(', ')} need a process that polls for work, and no worker script is ` +
        'defined. Without one the queues fill and nothing is processed.',
      remediation:
        'Add a worker entry point that starts JobWorker, Scheduler and WebhookWorker, and a ' +
        'script to run it. See docs/automation.md.',
    },
  ];
}

function print(report: DoctorIntegrationsReport, output: Output, verbose: boolean): void {
  output.info(style.bold('Integration layer'));
  output.detail(`  ${report.applicationRoot}`);
  output.blank();

  // Two columns, because `formatRows` aligns a pair. The status is folded into the first so the
  // marks line up with the area names rather than drifting with the longest detail.
  const rows: Array<[string, string]> = report.findings.map((finding) => [
    `${finding.status.padEnd(4)}  ${finding.area}`,
    finding.detail,
  ]);

  output.info(formatRows(rows));

  const actionable = report.findings.filter((finding) => finding.remediation);

  if (actionable.length > 0) {
    output.blank();
    output.info(style.bold('What to do'));
    for (const finding of actionable) {
      output.detail(`  ${finding.area}`);
      output.detail(`    ${finding.remediation}`);
    }
  }

  output.blank();

  if (report.ok) {
    output.success('The integration layer looks correctly wired.');
  } else {
    output.error('The integration layer has problems that will stop it working.');
  }

  if (verbose) {
    output.blank();
    output.detail(
      '  This check is offline: it reads files, not a running system. Queue depth, delivery',
    );
    output.detail(
      '  failures and provider health need the application running — see GET /health/integrations.',
    );
  }
}

function findApplicationRoot(from: string): string | null {
  let current = from;

  for (let depth = 0; depth < 20; depth += 1) {
    if (existsSync(join(current, 'trustos.json'))) return current;
    const parent = join(current, '..');
    if (parent === current) break;
    current = parent;
  }

  return null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

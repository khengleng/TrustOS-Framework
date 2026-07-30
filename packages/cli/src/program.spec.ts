import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { run } from './program';
import { createCapturingOutput } from './output';
import { CLI_VERSION } from './version';
import { resolveAnswersFromFlags, defaultDisplayName, defaultPackageName } from './prompts';
import { requireTemplate } from '@trustos/template-registry';

/**
 * CLI tests.
 *
 * The program is executed in-process with an argv array rather than by spawning
 * a shell: argument parsing is the part most likely to regress, and it deserves
 * fast tests. Two real bugs this style catches — a flag whose camel-case name
 * does not match what the code reads, and a command that exits zero on failure.
 */

const TEMPLATES_ROOT = join(__dirname, '..', '..', '..', 'templates');

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'trustos-cli-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/**
 * Invokes the real `run()` — including its error mapping — with output
 * captured and `process.exitCode` left alone.
 */
async function invoke(args: string[]): Promise<{ code: number; lines: string[]; output: string }> {
  const captured = createCapturingOutput();
  const code = await run(['node', 'trustos', ...args], {
    output: captured,
    setProcessExitCode: false,
  });

  return { code, lines: captured.lines, output: captured.lines.join('\n') };
}

describe('argument parsing', () => {
  it('reports the version, matching package.json', async () => {
    const packageJson = JSON.parse(
      await readFile(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };

    // A drifting version is invisible until someone reports a bug against the
    // wrong one.
    expect(CLI_VERSION).toBe(packageJson.version);
  });

  it('exits non-zero for an unknown command', async () => {
    const { code } = await invoke(['not-a-command']);
    expect(code).not.toBe(0);
  });

  it('requires a template argument for new', async () => {
    const { code } = await invoke(['new']);
    expect(code).not.toBe(0);
  });
});

describe('list-templates', () => {
  it('lists every registered template', async () => {
    const { code, output } = await invoke(['list-templates']);

    expect(code).toBe(0);
    for (const id of [
      'generic-saas',
      'merchant',
      'learning',
      'payment-gateway',
      'telegram-mini-app',
    ]) {
      expect(output).toContain(id);
    }
  });

  it('emits parseable JSON with --json', async () => {
    const { code, output } = await invoke(['list-templates', '--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(output) as Array<{ id: string; version: string }>;
    expect(parsed).toHaveLength(6);
    expect(parsed.every((entry) => Boolean(entry.id && entry.version))).toBe(true);
  });

  it('shows entities, owner and exclusions with --verbose', async () => {
    const { output } = await invoke(['list-templates', '--verbose']);

    expect(output).toContain('WorkspaceItem');
    expect(output).toContain('TrustOS Platform Team');
    expect(output).toContain('payments');
  });
});

describe('validate-template', () => {
  it('validates every template and exits zero', async () => {
    const { code, output } = await invoke([
      'validate-template',
      '--all',
      '--templates-root',
      TEMPLATES_ROOT,
    ]);

    expect(output).toContain('6 template(s) valid.');
    expect(code).toBe(0);
  });

  it('validates one template by id', async () => {
    const { code, output } = await invoke([
      'validate-template',
      'merchant',
      '--templates-root',
      TEMPLATES_ROOT,
    ]);

    expect(code).toBe(0);
    expect(output).toContain('merchant');
    expect(output).toContain('tenant isolation');
  });

  it('exits non-zero and names the template for an unknown id', async () => {
    const { code, output } = await invoke([
      'validate-template',
      'nope',
      '--templates-root',
      TEMPLATES_ROOT,
    ]);

    expect(code).toBe(1);
    expect(output).toContain('Unknown template "nope"');
  });

  it('emits a machine-readable report with --json', async () => {
    const { code, output } = await invoke([
      'validate-template',
      '--all',
      '--json',
      '--templates-root',
      TEMPLATES_ROOT,
    ]);

    expect(code).toBe(0);
    const reports = JSON.parse(output) as Array<{ templateId: string; ok: boolean }>;
    expect(reports).toHaveLength(6);
    expect(reports.every((report) => report.ok)).toBe(true);
  });
});

describe('new', () => {
  const base = (extra: string[] = []) => [
    'new',
    'generic-saas',
    '--yes',
    '--name',
    'cli-demo',
    '--package-name',
    'cli-demo',
    '--target-dir',
    workspace,
    '--templates-root',
    TEMPLATES_ROOT,
    '--generated-at',
    '2026-07-29T00:00:00.000Z',
    '--no-git',
    ...extra,
  ];

  it('generates into --target-dir, not the working directory', async () => {
    // Regression: commander derives `targetDir` from `--target-dir`. When the
    // code read `targetDirectory` instead, generation silently succeeded in the
    // wrong place.
    const { code } = await invoke(base());

    expect(code).toBe(0);
    expect(existsSync(join(workspace, 'cli-demo', 'package.json'))).toBe(true);
  });

  it('writes nothing with --dry-run, and says so', async () => {
    const { code, output } = await invoke(base(['--dry-run']));

    expect(code).toBe(0);
    expect(output).toContain('Dry run');
    expect(output).toContain('Nothing was written.');
    expect(existsSync(join(workspace, 'cli-demo'))).toBe(false);
  });

  it('lists every file with --dry-run --verbose', async () => {
    const { output } = await invoke(base(['--dry-run', '--verbose']));

    expect(output).toContain('AGENTS.md');
    expect(output).toContain('prisma/schema/10-product.prisma');
    expect(output).not.toContain('and 15 more');
  });

  it('truncates the dry-run listing without --verbose', async () => {
    const { output } = await invoke(base(['--dry-run']));
    expect(output).toMatch(/and \d+ more/);
  });

  it('refuses an unsafe application name', async () => {
    const { code, output } = await invoke([
      'new',
      'generic-saas',
      '--yes',
      '--name',
      '../escape',
      '--target-dir',
      workspace,
      '--templates-root',
      TEMPLATES_ROOT,
      '--no-git',
    ]);

    expect(code).toBe(1);
    expect(output).toContain('Invalid application name');
    expect(existsSync(join(workspace, '..', 'escape'))).toBe(false);
  });

  it('refuses a non-empty target and suggests --force', async () => {
    await mkdir(join(workspace, 'cli-demo'), { recursive: true });
    await writeFile(join(workspace, 'cli-demo', 'keep.txt'), 'keep');

    const { code, output } = await invoke(base());

    expect(code).toBe(1);
    expect(output).toContain('not empty');
    expect(output).toContain('--force');
    expect(await readFile(join(workspace, 'cli-demo', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('overwrites with --force', async () => {
    await invoke(base());
    const { code } = await invoke(base(['--force']));
    expect(code).toBe(0);
  });

  it('rejects an unknown deployment target', async () => {
    const { code, output } = await invoke(base(['--deploy', 'aws']));

    expect(code).toBe(1);
    expect(output).toContain('Unknown deployment target');
  });

  it('prints next steps, including the .env copy', async () => {
    const { output } = await invoke(base());

    expect(output).toContain('Next steps');
    expect(output).toContain('cp .env.example .env');
    expect(output).toContain('AGENTS.md');
  });
});

describe('list-modules', () => {
  it('lists every module without importing one', async () => {
    const { code, output } = await invoke(['list-modules']);

    expect(code).toBe(0);
    for (const id of [
      'notification',
      'document',
      'workflow',
      'reporting',
      'search',
      'feature-flags',
      'file-storage',
    ]) {
      expect(output).toContain(id);
    }
  });

  it('shows permissions, routes and extension points when verbose', async () => {
    const { output } = await invoke(['list-modules', '--verbose']);

    expect(output).toContain('notification.message.send');
    expect(output).toContain('POST /notifications/messages');
    expect(output).toContain('NotificationChannel');
    // What a module deliberately does not do belongs next to what it does.
    expect(output).toContain('out of scope');
  });

  it('reports the install order, which is not the order ids are typed in', async () => {
    const { output } = await invoke(['list-modules']);
    expect(output).toContain('file-storage -> document');
  });

  it('emits the catalog as JSON', async () => {
    const { output } = await invoke(['list-modules', '--json']);
    const parsed = JSON.parse(output) as Array<{ metadata: { id: string } }>;

    expect(parsed).toHaveLength(7);
  });
});

describe('add-module', () => {
  it('lists the available modules when none is named', async () => {
    const { code, output } = await invoke(['add-module']);

    expect(code).toBe(1);
    expect(output).toContain('Name at least one module');
    expect(output).toContain('notification');
  });

  it('refuses to run outside a generated application', async () => {
    // Checked before the module request is even resolved: without it the command
    // would write into whatever directory it was run from.
    const { code, output } = await invoke(['add-module', 'search', '--path', workspace]);

    expect(code).toBe(1);
    expect(output).toContain('trustos.json');
  });

  it('refuses a module that is not in the catalog', async () => {
    await writeFile(
      join(workspace, 'trustos.json'),
      JSON.stringify({
        frameworkVersion: '0.1.0',
        template: 'generic-saas',
        templateVersion: '0.1.0',
        cliVersion: '0.1.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        application: {
          name: 'demo',
          packageName: 'demo',
          displayName: 'Demo',
          organization: 'Tests',
        },
        generated: { api: true, admin: true, auth: true, deploymentTarget: 'railway' },
        modules: [],
      }),
      'utf8',
    );

    const { code, output } = await invoke([
      'add-module',
      'billing',
      '--path',
      workspace,
      '--framework-path',
      process.cwd(),
    ]);

    expect(code).toBe(1);
    expect(output).toContain('Unknown module "billing"');
    // The hint names what does exist, so the next attempt succeeds.
    expect(output).toContain('notification');
  });
});

describe('placeholder commands', () => {
  it('upgrade explains itself and exits non-zero', async () => {
    const { code, output } = await invoke(['upgrade']);

    expect(code).toBe(2);
    expect(output).toContain('not implemented yet');
    // A non-zero exit stops a script mistaking "not implemented" for success.
    expect(output).toContain('Framework migrations are deliberately out of scope');
  });
});

describe('resolveAnswersFromFlags', () => {
  const template = requireTemplate('merchant');

  it('fills every answer from defaults when only --yes is given', () => {
    const answers = resolveAnswersFromFlags(template, {});

    expect(answers.applicationName).toBe('merchant');
    expect(answers.packageName).toBe('merchant');
    expect(answers.port).toBe(3000);
    expect(answers.deploymentTarget).toBe('railway');
    expect(answers.includeApi).toBe(true);
    expect(answers.includeAdmin).toBe(true);
    expect(answers.authEnabled).toBe(true);
    expect(answers.initialRoles.split(',')).toContain('auditor');
  });

  it('honours supplied flags over defaults', () => {
    const answers = resolveAnswersFromFlags(template, {
      name: 'wing-merchant',
      port: '4100',
      deploy: 'local',
      admin: false,
      roles: 'organization_owner,store_manager',
    });

    expect(answers.applicationName).toBe('wing-merchant');
    expect(answers.port).toBe(4100);
    expect(answers.deploymentTarget).toBe('local');
    expect(answers.includeAdmin).toBe(false);
    expect(answers.initialRoles).toBe('organization_owner,store_manager');
  });

  it('validates flag values rather than trusting them', () => {
    expect(() => resolveAnswersFromFlags(template, { name: 'Bad Name' })).toThrow();
    expect(() => resolveAnswersFromFlags(template, { port: '99999' })).toThrow();
    expect(() => resolveAnswersFromFlags(template, { roles: 'Bad-Role' })).toThrow();
    expect(() => resolveAnswersFromFlags(template, { packageName: 'UPPER' })).toThrow();
  });
});

describe('defaults derived from the application name', () => {
  it('turns a directory name into a display name', () => {
    expect(defaultDisplayName('merchant-portal')).toBe('Merchant Portal');
    expect(defaultDisplayName('paykh')).toBe('Paykh');
  });

  it('uses the application name as the package name', () => {
    expect(defaultPackageName('merchant-portal')).toBe('merchant-portal');
  });
});

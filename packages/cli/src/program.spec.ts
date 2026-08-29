import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_MODULE_IDS } from '@trustos/module-registry';
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
    expect(parsed.length).toBeGreaterThanOrEqual(30);
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

    expect(output).toContain('30 template(s) valid.');
    expect(code).toBe(0);
    // Validates all thirty templates through the CLI. The five-second default is a
    // deadline for a unit test, not for this, and exceeding it under a parallel suite
    // run made `npm run validate` report the CLI capability BROKEN on a healthy tree.
  }, 60_000);

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
    expect(reports.length).toBeGreaterThanOrEqual(30);
    expect(reports.every((report) => report.ok)).toBe(true);
  }, 60_000);
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

    // Compared against the registry's own list rather than a literal, so adding a module is one
    // edit rather than two — and so a module that fails to load shows up as a mismatch here.
    expect(parsed).toHaveLength(BUILT_IN_MODULE_IDS.length);
    expect(parsed.map((entry) => entry.metadata.id).sort()).toEqual(
      [...BUILT_IN_MODULE_IDS].sort(),
    );
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

describe('templates', () => {
  it('groups the catalog by category', async () => {
    const { code, output } = await invoke(['templates']);

    expect(code).toBe(0);
    expect(output).toMatch(/Financial services/);
    expect(output).toMatch(/Messaging mini apps/);
    expect(output).toMatch(/wallet/);
  });

  it('shows the inheritance chain', async () => {
    /*
     * The single most useful line for somebody choosing: it says "this one already has everything
     * that one has", which a flat list cannot.
     */
    expect((await invoke(['templates'])).output).toMatch(/extends clinic → hospital/);
  });

  it('hides deprecated templates unless asked', async () => {
    // A developer picking a template for a new product should not have to work out which of two
    // similarly-named entries is the dead one.
    const listed = await invoke(['templates']);
    const all = await invoke(['templates', '--all']);

    expect(listed.output).not.toMatch(/telegram-mini-app\s/);
    expect(all.output).toMatch(/telegram-mini-app/);
    expect(all.output).toMatch(/use telegram-miniapp instead/);
  });

  it('filters by category', async () => {
    const { output } = await invoke(['templates', '--category', 'health']);

    expect(output).toMatch(/clinic/);
    expect(output).toMatch(/hospital/);
    expect(output).not.toMatch(/microloan/);
  });

  it('refuses an unknown category and names the real ones', async () => {
    const { code, output } = await invoke(['templates', '--category', 'hospitals']);

    expect(code).toBe(1);
    expect(output).toMatch(/Unknown category "hospitals". Categories: /);
  });

  it('emits machine-readable output with the chain resolved', async () => {
    const { output } = await invoke(['templates', '--json']);
    const parsed = JSON.parse(output) as Array<{ id: string; chain: string[] }>;

    expect(parsed.find((entry) => entry.id === 'marketplace')?.chain).toEqual([
      'merchant',
      'ecommerce',
      'marketplace',
    ]);
  });
});

describe('update-template', () => {
  async function generatedProject(overrides: Record<string, unknown> = {}): Promise<string> {
    const root = join(workspace, 'app');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'trustos.json'),
      JSON.stringify({
        frameworkVersion: '0.1.0',
        template: 'merchant',
        templateVersion: '0.1.0',
        generatedAt: '2026-03-01T09:00:00.000Z',
        ...overrides,
      }),
    );
    return root;
  }

  it('reports an up-to-date project', async () => {
    const root = await generatedProject();
    const { code, output } = await invoke(['update-template', '--path', root]);

    expect(code).toBe(0);
    expect(output).toMatch(/Up to date/);
  });

  it('reports drift and prints the owner’s migration notes', async () => {
    const root = await generatedProject({ templateVersion: '0.0.1' });
    const { output } = await invoke(['update-template', '--path', root]);

    expect(output).toMatch(/has moved on/);
    expect(output).toMatch(/Structure only/);
  });

  it('says plainly that there is no automatic upgrade', async () => {
    /*
     * The command is named `update-template` and it does not update anything. Saying so is
     * better than a tool that silently overwrites a service somebody spent a month on.
     */
    const root = await generatedProject({ templateVersion: '0.0.1' });

    expect((await invoke(['update-template', '--path', root])).output).toMatch(
      /no automatic upgrade/,
    );
  });

  it('names the successor of a deprecated template', async () => {
    const root = await generatedProject({ template: 'telegram-mini-app' });

    expect((await invoke(['update-template', '--path', root])).output).toMatch(
      /successor is "telegram-miniapp"/,
    );
  });

  it('refuses a project with no trustos.json', async () => {
    const { code, output } = await invoke(['update-template', '--path', workspace]);

    expect(code).toBe(1);
    expect(output).toMatch(/could not be read|No trustos\.json/);
  });
});

describe('doctor template', () => {
  it('passes on a freshly generated project', async () => {
    const root = join(workspace, 'fresh');

    await invoke([
      'new',
      'merchant',
      '--yes',
      '--name',
      'fresh',
      '--package-name',
      'fresh',
      '--target-dir',
      workspace,
      '--templates-root',
      TEMPLATES_ROOT,
    ]);

    const { code, output } = await invoke(['doctor', 'template', '--path', root]);

    expect(code).toBe(0);
    expect(output).toMatch(/still matches the template/);
  });

  it('fails when the product module has been deleted', async () => {
    // The composition root imports it by a fixed name, so the API will not start without it.
    const root = join(workspace, 'broken');

    await invoke([
      'new',
      'merchant',
      '--yes',
      '--name',
      'broken',
      '--package-name',
      'broken',
      '--target-dir',
      workspace,
      '--templates-root',
      TEMPLATES_ROOT,
    ]);

    await rm(join(root, 'apps/api/src/modules/product'), { recursive: true, force: true });

    const { code, output } = await invoke(['doctor', 'template', '--path', root]);

    expect(code).toBe(1);
    expect(output).toMatch(/product\.module\.ts is missing/);
  });

  it('reports every layer of an inherited template', async () => {
    const root = join(workspace, 'ward');

    await invoke([
      'new',
      'hospital',
      '--yes',
      '--name',
      'ward',
      '--package-name',
      'ward',
      '--target-dir',
      workspace,
      '--templates-root',
      TEMPLATES_ROOT,
    ]);

    const { output } = await invoke(['doctor', 'template', '--path', root]);

    expect(output).toMatch(/clinic → hospital/);
  });

  it('warns when the recorded template version is behind the registry', async () => {
    const root = join(workspace, 'stale');
    await mkdir(join(root, 'prisma/schema'), { recursive: true });
    await mkdir(join(root, 'apps/api/src/modules/product'), { recursive: true });
    await writeFile(join(root, 'prisma/schema/00-framework.prisma'), '');
    await writeFile(join(root, 'apps/api/src/modules/product/product.module.ts'), '');
    await writeFile(
      join(root, 'trustos.json'),
      JSON.stringify({ template: 'merchant', templateVersion: '0.0.1', frameworkVersion: '0.1.0' }),
    );

    const { output } = await invoke(['doctor', 'template', '--path', root]);

    expect(output).toMatch(/the registry now has v0\.1\.0/);
  });

  it('emits machine-readable findings', async () => {
    const root = join(workspace, 'json-app');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'trustos.json'), JSON.stringify({ templateVersion: '0.1.0' }));

    const { output } = await invoke(['doctor', 'template', '--path', root, '--json']);
    const parsed = JSON.parse(output) as { findings: Array<{ area: string; status: string }> };

    expect(parsed.findings[0]).toMatchObject({ area: 'provenance', status: 'FAIL' });
  });
});

describe('templates hidden count', () => {
  it('does not report a category filter as deprecation', async () => {
    // Subtracting the visible set from the whole catalog told somebody asking for one category
    // that twenty-eight templates were dead.
    const health = await invoke(['templates', '--category', 'health']);
    const messaging = await invoke(['templates', '--category', 'messaging']);

    expect(health.output).not.toMatch(/deprecated template\(s\) hidden/);
    expect(messaging.output).toMatch(/1 deprecated template\(s\) hidden/);
  });
});

describe('platform', () => {
  it('summarizes the platform offline, with no application present', async () => {
    /*
     * The moment somebody most needs this is when they are deciding whether to start a system, or
     * during an incident when it will not start. It must work with nothing running.
     */
    const { code, output } = await invoke(['platform', 'info', '--path', workspace]);

    expect(code).toBe(0);
    expect(output).toMatch(/framework/);
    expect(output).toMatch(/licence\s+open-source/);
  });

  it('says telemetry is off and that nothing is sent', async () => {
    const { output } = await invoke(['platform', 'info', '--path', workspace]);

    expect(output).toMatch(/Telemetry is off\. Nothing is collected and nothing is sent\./);
  });

  it('emits a machine-readable summary', async () => {
    const { output } = await invoke(['platform', 'info', '--path', workspace, '--json']);
    const parsed = JSON.parse(output) as { health: { state: string }; license: { state: string } };

    expect(parsed.health.state).toBeDefined();
    expect(parsed.license.state).toBe('valid');
  });
});

describe('marketplace', () => {
  it('lists the local catalogue', async () => {
    const { code, output } = await invoke(['marketplace']);

    expect(code).toBe(0);
    expect(output).toMatch(/module\(s\)/);
  });

  it('searches by term', async () => {
    const { output } = await invoke(['marketplace', 'notification']);

    expect(output).toMatch(/notification/);
  });

  it('says so when nothing matches rather than printing an empty list', async () => {
    const { output } = await invoke(['marketplace', 'zzzznotathing']);

    expect(output).toMatch(/Nothing matches "zzzznotathing"/);
  });

  it('lists categories with counts', async () => {
    const { code, output } = await invoke(['marketplace', 'categories']);

    expect(code).toBe(0);
    expect(output).toMatch(/categor/);
  });

  it('reports every module as unsigned, honestly', async () => {
    // The framework ships verification, not signatures. A deployment signs what it publishes.
    const { output } = await invoke(['marketplace']);

    expect(output).toMatch(/unsigned/);
  });
});

describe('architecture-check', () => {
  it('passes on this repository', async () => {
    const { code, output } = await invoke([
      'architecture-check',
      '--path',
      join(__dirname, '..', '..', '..'),
    ]);

    expect(code).toBe(0);
    expect(output).toMatch(/Every rule holds/);
  }, 120_000);

  it('refuses when there is nothing to check', async () => {
    const { code, output } = await invoke(['architecture-check', '--path', workspace]);

    expect(code).toBe(1);
    expect(output).toMatch(/No packages directory/);
  });
});

describe('validate', () => {
  it('skips every gate it has no results for rather than passing them', async () => {
    // A gate that passes because nothing was measured is a gate that always passes.
    const { code, output } = await invoke(['validate']);

    expect(code).toBe(0);
    expect(output).toMatch(/did not run/);
  });

  it('fails on a blocking gate and says which', async () => {
    const results = join(workspace, 'results.json');
    await writeFile(results, JSON.stringify({ tests: { passed: 10, failed: 3 } }));

    const { code, output } = await invoke(['validate', '--results', results]);

    expect(code).toBe(1);
    expect(output).toMatch(/3 test\(s\) failing/);
    expect(output).toMatch(/1 blocking gate\(s\) failed/);
  });

  it('never blocks on performance', async () => {
    const results = join(workspace, 'perf.json');
    await writeFile(
      results,
      JSON.stringify({ performance: { budgetMs: 10, measuredMs: 900, label: 'boot' } }),
    );

    const { code, output } = await invoke(['validate', '--results', results]);

    expect(code).toBe(0);
    expect(output).toMatch(/Advisory — this does not block/);
  });
});

describe('docs', () => {
  it('prints what it would write rather than writing it', async () => {
    // A command that silently overwrote a docs tree the first time somebody ran it to see what it
    // did would be a bad first impression at best.
    const { code, output } = await invoke(['docs']);

    expect(code).toBe(0);
    expect(output).toMatch(/Nothing was written\. Run with --write/);
    expect(output).toMatch(/docs\/generated\/cli\.md/);
  });

  it('writes when asked', async () => {
    const { code } = await invoke(['docs', '--write', '--output-dir', workspace]);

    expect(code).toBe(0);
    expect(existsSync(join(workspace, 'docs/generated/cli.md'))).toBe(true);
    expect(existsSync(join(workspace, 'docs/generated/index.md'))).toBe(true);
  });
});

describe('plugins', () => {
  it('says nothing is installed and points at the guidance', async () => {
    const { code, output } = await invoke(['plugins']);

    expect(code).toBe(0);
    expect(output).toMatch(/No plugins installed/);
    expect(output).toMatch(/docs\/plugin-development\.md/);
  });
});

describe('release', () => {
  it('says so when no release is registered', async () => {
    // A version nobody registered is a version nobody has committed to fixing.
    const { code, output } = await invoke(['release', 'list']);

    expect(code).toBe(0);
    expect(output).toMatch(/No releases registered/);
  });
});

describe('upgrade', () => {
  async function project(overrides: Record<string, unknown> = {}): Promise<string> {
    const root = join(workspace, 'app');
    await mkdir(join(root, '.trustos'), { recursive: true });

    await writeFile(
      join(root, 'trustos.json'),
      JSON.stringify({ frameworkVersion: '0.4.0', modules: [], ...overrides }),
    );

    await writeFile(
      join(root, '.trustos/releases.json'),
      JSON.stringify([
        { version: '0.4.0', channel: 'stable', releasedAt: '2026-03-01' },
        { version: '0.5.0', channel: 'stable', releasedAt: '2026-06-01' },
      ]),
    );

    await writeFile(
      join(root, '.trustos/migrations.json'),
      JSON.stringify([
        {
          id: '20260601000000_platform',
          kind: 'database',
          description: 'Adds the platform tables.',
          targetVersion: '0.5.0',
          destructive: true,
        },
      ]),
    );

    return root;
  }

  it('plans without touching anything', async () => {
    /*
     * It plans and refuses; it never executes. The actions in an upgrade are the ones where a
     * mistake is expensive, and a CLI that performs them is one somebody runs in the wrong
     * terminal.
     */
    const root = await project();
    const { code, output } = await invoke(['upgrade', '--path', root]);

    expect(code).toBe(1);
    expect(output).toMatch(/Nothing has been touched/);
    expect(output).toMatch(/no backup has been recorded/);
  });

  it('proceeds once a backup is recorded, and still does not execute', async () => {
    const root = await project({
      backup: { id: 'b1', takenAt: '2026-07-01', includes: ['database'], location: '/b1' },
    });

    const { code, output } = await invoke(['upgrade', '--path', root]);

    expect(code).toBe(0);
    expect(output).toMatch(/The plan is safe to run/);
    expect(output).toMatch(/This command plans; it does not execute/);
  });

  it('says what recovery would look like before it starts', async () => {
    const root = await project({
      backup: { id: 'b1', takenAt: '2026-07-01', includes: ['database'], location: '/b1' },
    });

    expect((await invoke(['upgrade', '--path', root])).output).toMatch(
      /Recovery means restoring the backup/,
    );
  });

  it('refuses a downgrade rather than planning one', async () => {
    const root = await project();
    const { code, output } = await invoke(['upgrade', '--path', root, '--to', '0.3.0']);

    expect(code).toBe(1);
    expect(output).toMatch(/Downgrade refused|Cannot upgrade/);
  });

  it('refuses a project that does not record its version', async () => {
    const root = join(workspace, 'unknown');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'trustos.json'), JSON.stringify({}));

    const { code, output } = await invoke(['upgrade', '--path', root]);

    expect(code).toBe(1);
    expect(output).toMatch(/a guess would be a plan/);
  });
});

describe('install, update and remove', () => {
  async function application(): Promise<string> {
    const root = join(workspace, 'app');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'trustos.json'), JSON.stringify({ frameworkVersion: '0.1.0' }));
    return root;
  }

  it('plans an install without changing anything under --dry-run', async () => {
    // `--dry-run` is the same plan, unapplied — not a second code path that predicts the first.
    const root = await application();
    const { code, output } = await invoke(['install', 'search', '--path', root, '--dry-run']);

    expect(code).toBe(0);
    expect(output).toMatch(/install search/);
    expect(output).toMatch(/Nothing was changed/);
    expect(existsSync(join(root, 'trustos-lock.json'))).toBe(false);
  });

  it('records the install in a lockfile with an integrity digest', async () => {
    /*
     * The digest is the point of the lockfile. Without it, it is a version list, and a package
     * whose contents changed since it was locked installs silently.
     */
    const root = await application();

    expect((await invoke(['install', 'search', '--path', root])).code).toBe(0);

    const lockfile = JSON.parse(await readFile(join(root, 'trustos-lock.json'), 'utf8')) as {
      packages: Array<{ id: string; integrity: string }>;
    };

    expect(lockfile.packages.map((entry) => entry.id)).toContain('search');
    expect(lockfile.packages[0]?.integrity).toMatch(/^[a-f0-9]{64}$/);
  });

  it('says a module is unsigned rather than staying quiet about it', async () => {
    // The framework ships verification, not signatures. Saying so beats implying otherwise.
    const root = await application();

    expect((await invoke(['install', 'search', '--path', root])).output).toMatch(/unsigned/);
  });

  it('refuses to install something that is not in the catalogue', async () => {
    const root = await application();
    const { code, output } = await invoke(['install', 'not-a-module', '--path', root]);

    expect(code).toBe(1);
    expect(output).toMatch(/not available offline. The installer never fetches/);
    expect(output).toMatch(/Nothing has been changed/);
  });

  it('refuses to remove something that is not installed', async () => {
    const root = await application();
    const { code, output } = await invoke(['remove', 'search', '--path', root]);

    expect(code).toBe(1);
    expect(output).toMatch(/not installed/);
  });

  it('reports nothing outdated on a fresh install', async () => {
    const root = await application();
    await invoke(['install', 'search', '--path', root]);

    const { code, output } = await invoke(['outdated', '--path', root]);

    expect(code).toBe(0);
    expect(output).toMatch(/newest compatible version/);
  });

  it('refuses to run outside a generated application', async () => {
    const { code, output } = await invoke(['install', 'search', '--path', join(workspace, 'nope')]);

    expect(code).toBe(1);
    expect(output).toMatch(/No trustos\.json/);
  });
});

describe('generate crud', () => {
  async function spec(): Promise<string> {
    const path = join(workspace, 'slice.json');

    await writeFile(
      path,
      JSON.stringify({
        entity: 'Invoice',
        plural: 'invoices',
        label: 'Invoices',
        singular: 'Invoice',
        description: 'A bill issued to a customer.',
        namespace: 'billing',
        fields: [
          { name: 'number', label: 'Number', type: 'text', required: true, unique: true },
          { name: 'total', label: 'Total', type: 'money', required: true },
        ],
      }),
    );

    return path;
  }

  it('prints the files it would write rather than writing them', async () => {
    // Generation writes code into somebody's project. Doing that the first time it is run to see
    // what it does would be a bad first impression at best.
    const { code, output } = await invoke(['generate', 'crud', '--spec', await spec()]);

    expect(code).toBe(0);
    expect(output).toMatch(/7 file\(s\)/);
    expect(output).toMatch(/Nothing was written/);
  });

  it('writes when asked, and what it writes is tenant-scoped and audited', async () => {
    const out = join(workspace, 'generated');

    expect(
      (await invoke(['generate', 'crud', '--spec', await spec(), '--write', '--out', out])).code,
    ).toBe(0);

    const schema = await readFile(join(out, 'prisma/schema/20-invoices.prisma'), 'utf8');
    const service = await readFile(join(out, 'src/modules/invoices/invoices.service.ts'), 'utf8');

    expect(schema).toMatch(/organizationId String/);
    // Money is a Decimal, never a Float. Phase 8's rule reaching the generator.
    expect(schema).toMatch(/total Decimal @db\.Decimal\(28, 8\)/);
    expect(service).toMatch(/billing\.invoices\.created/);
    expect(existsSync(join(out, 'src/modules/invoices/tenant-isolation.spec.ts'))).toBe(true);
  });
});

describe('telemetry review', () => {
  it('says what would be sent, and that nothing is', async () => {
    // Nobody should have to read source to find out what a framework would transmit.
    const { code, output } = await invoke(['telemetry', 'review']);

    expect(code).toBe(0);
    expect(output).toMatch(/No events recorded/);
    expect(output).toMatch(/ships no exporter and has no endpoint/);
    expect(output).toMatch(/nowhere for tenant data to land/);
  });
});

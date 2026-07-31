import { PluginRegistry, type InstalledPlugin } from '@trustos/plugin-framework';
import { runQualityGates, type GateInput } from '@trustos/quality-gates';
import { ReleaseManager } from '@trustos/release-manager';
import { generateCliDocs, generateIndex, type DocumentPage } from '@trustos/documentation-center';
import type { Output } from '../output';
import { formatRows, style } from '../output';

/**
 * `trustos plugins`, `trustos release`, `trustos validate` and `trustos docs`.
 *
 * The lifecycle commands. Like everything else in Phase 10 they are offline and read-only: they
 * report state and refuse operations, and the operations themselves — installing a plugin,
 * publishing a release — are deliberately *not* here.
 *
 * The reason: those are the actions where a mistake is expensive and irreversible, and a CLI that
 * performs them is a CLI somebody runs in the wrong terminal. What the framework ships is the
 * decision-making — the checks, the refusals, the plans — and a deployment wires the doing to
 * whatever change-control process it already has.
 */

export interface PluginsOptions {
  json?: boolean;
  /** Show only the ones holding a permission that makes them arbitrary code. */
  privileged?: boolean;
  /** Show only the ones installed without a signature. */
  unsigned?: boolean;
}

/**
 * `trustos plugins` — what is installed and what it can do.
 *
 * The registry is per-process, so a real deployment supplies its own. This command reads whatever
 * registry it is handed and reports; there is no global plugin state for it to discover, by
 * design — a CLI that could find and load plugins on its own would run them to list them.
 */
export function runPlugins(
  registry: PluginRegistry,
  options: PluginsOptions,
  output: Output,
): number {
  const all = registry.list();

  const shown = options.privileged
    ? registry.privileged()
    : options.unsigned
      ? registry.unsigned()
      : all;

  if (options.json) {
    output.info(JSON.stringify(shown, null, 2));
    return 0;
  }

  if (all.length === 0) {
    output.info('No plugins installed.');
    output.blank();
    output.detail('  Plugins are third-party code running inside this application.');
    output.detail('  Read docs/plugin-development.md before installing one.');
    return 0;
  }

  output.info(style.bold(`${shown.length} of ${all.length} plugin(s)`));
  output.blank();

  for (const plugin of shown) {
    const flags = [
      plugin.enabled ? '' : 'disabled',
      plugin.signedBy ? `signed by ${plugin.signedBy}` : 'UNSIGNED',
    ].filter(Boolean);

    output.info(
      `  ${style.cyan(plugin.manifest.id.padEnd(22))} ${plugin.manifest.version}  ${flags.join(' · ')}`,
    );
    output.detail(`    ${plugin.manifest.description}`);
    output.detail(
      `    by ${plugin.manifest.author} · extends ${plugin.manifest.extensionPoints.join(', ')}`,
    );

    const dangerous = dangerousOf(plugin);

    if (dangerous.length > 0) {
      // Said in terms of what it can do, not in permission names — see describePermissions.
      output.detail(`    ${style.bold('can:')} ${dangerous.join(' ')}`);
    }

    output.blank();
  }

  const unsigned = registry.unsigned().length;

  if (unsigned > 0 && !options.unsigned) {
    output.warn(`${unsigned} plugin(s) installed without a signature.`);
  }

  return 0;
}

function dangerousOf(plugin: InstalledPlugin): string[] {
  const descriptions: Record<string, string> = {
    'filesystem:write': 'Create and modify files in this project.',
    network: 'Open network connections to anywhere.',
    'process:spawn': 'Run other programs on this machine.',
    database: 'Query this application’s database.',
  };

  return plugin.manifest.permissions
    .map((permission) => descriptions[permission])
    .filter((value): value is string => value !== undefined);
}

// ---------------------------------------------------------------------------

export interface ReleaseOptions {
  json?: boolean;
  /** Show end-of-life releases too. Hidden by default. */
  all?: boolean;
}

/** `trustos release list` — the register, and where each release is in its life. */
export function runReleaseList(
  manager: ReleaseManager,
  options: ReleaseOptions,
  output: Output,
  now: Date = new Date(),
): number {
  const releases = options.all ? [...manager.all()] : manager.supported(now);

  if (options.json) {
    output.info(
      JSON.stringify(
        releases.map((release) => ({ ...release, state: manager.stateOf(release, now) })),
        null,
        2,
      ),
    );
    return 0;
  }

  if (releases.length === 0) {
    output.warn('No releases registered.');
    output.detail('  A version nobody registered is a version nobody has committed to fixing.');
    return 0;
  }

  output.info(style.bold(`${releases.length} release(s)`));
  output.blank();

  const rows: Array<[string, string]> = releases.map((release) => {
    const state = manager.stateOf(release, now);
    const support = release.securitySupportUntil
      ? `security fixes until ${release.securitySupportUntil.slice(0, 10)}`
      : 'no end date set';

    return [`${release.version} (${release.channel})`, `${state} — ${support}`];
  });

  output.info(formatRows(rows, '  '));
  output.blank();

  const hidden = manager.all().length - releases.length;

  if (hidden > 0 && !options.all) {
    output.detail(`  ${hidden} end-of-life release(s) hidden. Show them with --all.`);
  }

  return 0;
}

// ---------------------------------------------------------------------------

export interface ValidateOptions {
  json?: boolean;
  verbose?: boolean;
}

/**
 * `trustos validate` — the quality gates.
 *
 * Takes the results of the tools that already run rather than running them. A gate that shelled
 * out would behave differently in CI, on a laptop and in a pre-commit hook, which is how a gate
 * becomes something people work around.
 */
export function runValidate(input: GateInput, options: ValidateOptions, output: Output): number {
  const report = runQualityGates(input);

  if (options.json) {
    output.info(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  }

  output.info(style.bold('Quality gates'));
  output.blank();

  for (const result of report.results) {
    const badge =
      result.status === 'pass'
        ? 'PASS'
        : result.status === 'waived'
          ? 'WAIV'
          : result.status === 'skipped'
            ? '····'
            : style.bold('FAIL');

    output.info(`  ${badge}  ${result.gate.padEnd(16)} ${result.detail}`);

    if (options.verbose && result.remediation) output.detail(`        ${result.remediation}`);
  }

  output.blank();

  if (report.waived.length > 0) {
    output.warn(
      `${report.waived.length} gate(s) passing only under a waiver. Every waiver expires; when it ` +
        'does, the gate fails again.',
    );
  }

  if (!report.passed) {
    output.error(`${report.blocking.length} blocking gate(s) failed.`);
    return 1;
  }

  output.success('Every blocking gate passed.');
  return 0;
}

// ---------------------------------------------------------------------------

export interface DocsOptions {
  json?: boolean;
  /** Write the pages rather than listing them. */
  write?: boolean;
  outputDirectory?: string;
}

/**
 * `trustos docs` — generate the reference documentation.
 *
 * Prints what it *would* write by default. Generating documentation is one of the few operations
 * here that writes files, and a command that silently overwrote a docs tree the first time
 * somebody ran it to see what it did would be a bad first impression at best.
 */
export async function runDocs(
  pages: readonly DocumentPage[],
  options: DocsOptions,
  output: Output,
): Promise<number> {
  const all = [...pages, generateIndex(pages)];

  if (options.json) {
    output.info(
      JSON.stringify(
        all.map((page) => ({ path: page.path, title: page.title })),
        null,
        2,
      ),
    );
    return 0;
  }

  if (!options.write) {
    output.info(style.bold(`${all.length} page(s) would be written`));
    output.blank();
    output.info(
      formatRows(
        all.map((page) => [page.path, page.title]),
        '  ',
      ),
    );
    output.blank();
    output.detail('  Nothing was written. Run with --write to generate them.');
    return 0;
  }

  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');

  const root = options.outputDirectory ?? process.cwd();

  for (const page of all) {
    const target = join(root, page.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, page.content, 'utf8');
  }

  output.success(`Wrote ${all.length} page(s).`);
  output.detail('  Every page is generated. Edit the source, not the page.');

  return 0;
}

export { generateCliDocs };

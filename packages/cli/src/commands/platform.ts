import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MODULE_CATALOG } from '@trustos/module-registry';
import { listTemplates } from '@trustos/template-registry';
import { actionItems, describePlatform, type InstalledModuleView } from '@trustos/platform-manager';
import {
  Marketplace,
  summarize as summarizeModule,
  type MarketplaceEntry,
} from '@trustos/module-marketplace';
import { moduleProvenanceSchema } from '@trustos/module-registry';
import { ReleaseManager } from '@trustos/release-manager';
import { validateArchitecture, groupByRule } from '@trustos/architecture-validator';
import type { Output } from '../output';
import { formatRows, style } from '../output';

/**
 * `trustos platform`, `marketplace`, `architecture-check` and `docs`.
 *
 * Every command here is **offline and read-only**. That is not a limitation to apologise for — it
 * is what makes them usable at the moment they are most needed: deciding whether to start a
 * system, or during an incident when it will not start. A platform summary that needed a running
 * platform would be unavailable exactly then.
 *
 * They read the repository and the local catalogs. Nothing fetches, nothing writes, nothing
 * connects to a database.
 */

export interface PlatformOptions {
  path?: string;
  json?: boolean;
  verbose?: boolean;
}

interface ProjectManifest {
  frameworkVersion?: string;
  template?: string;
  templateVersion?: string;
  modules?: Array<{ id: string; version?: string }>;
  telemetry?: { enabled?: boolean };
}

/** Walks up looking for `trustos.json`, so the command works from anywhere inside a project. */
function findApplicationRoot(start: string): string | null {
  let current = start;

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'trustos.json'))) return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * The framework version this checkout is.
 *
 * Read from the repository root rather than from the CLI's own package.json — they are usually
 * the same and the distinction matters when they are not, which is exactly when somebody is
 * debugging a compatibility problem.
 */
async function readFrameworkVersion(): Promise<string> {
  for (let current = __dirname, depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'package.json');

    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(await readFile(candidate, 'utf8')) as {
          name?: string;
          version?: string;
        };

        if (parsed.name === 'trustos-framework') return parsed.version ?? '0.0.0';
      } catch {
        // Unreadable package.json on the way up is not an error; keep walking.
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return '0.0.0';
}

/** The provenance the framework ships for its own modules. */
function provenanceFor(id: string, owner: string): MarketplaceEntry['provenance'] {
  return moduleProvenanceSchema.parse({
    moduleId: id,
    author: owner,
    license: 'UNLICENSED',
    status: 'stable',
    documentation: 'docs/modules.md',
    // Null, and honestly so: the framework ships verification, not signatures. A deployment
    // signs what it publishes.
    signedBy: null,
  });
}

function marketplace(): Marketplace {
  return new Marketplace(
    MODULE_CATALOG.map((entry) => ({
      catalog: entry,
      provenance: provenanceFor(entry.metadata.id, entry.metadata.owner),
    })),
  );
}

// ---------------------------------------------------------------------------

/** `trustos platform info` — one view of the platform. */
export async function runPlatformInfo(options: PlatformOptions, output: Output): Promise<number> {
  const frameworkVersion = await readFrameworkVersion();
  const root = options.path ?? findApplicationRoot(process.cwd());

  let manifest: ProjectManifest = {};

  /*
   * A missing trustos.json is a normal condition — somebody asking about the framework outside a
   * generated project — so it is silent. A *present but unreadable* one is a real problem and
   * says so, because otherwise the summary quietly describes a different platform than the one
   * the reader is standing in.
   */
  if (root && existsSync(join(root, 'trustos.json'))) {
    try {
      manifest = JSON.parse(await readFile(join(root, 'trustos.json'), 'utf8')) as ProjectManifest;
    } catch {
      output.warn(`trustos.json in ${root} could not be parsed; reporting the framework only.`);
    }
  }

  const installed: InstalledModuleView[] = (manifest.modules ?? []).map((entry) => {
    const catalog = MODULE_CATALOG.find((candidate) => candidate.metadata.id === entry.id);

    return {
      id: entry.id,
      version: entry.version ?? catalog?.metadata.version ?? '0.0.0',
      minimumFrameworkVersion: catalog?.metadata.minimumFrameworkVersion ?? '0.0.0',
      signed: false,
      dependencies: catalog?.dependencies.map((dependency) => ({
        moduleId: dependency.moduleId,
        versionRange: dependency.versionRange,
        optional: dependency.optional,
      })),
    };
  });

  const summary = describePlatform({
    frameworkVersion: manifest.frameworkVersion ?? frameworkVersion,
    cliVersion: frameworkVersion,
    modules: installed,
    templates: manifest.template
      ? listTemplates()
          .filter((template) => template.id === manifest.template)
          .map((template) => ({
            id: template.id,
            version: manifest.templateVersion ?? template.version,
            minimumFrameworkVersion: template.minimumFrameworkVersion,
          }))
      : undefined,
    releases: new ReleaseManager([]),
    telemetryEnabled: manifest.telemetry?.enabled ?? false,
  });

  if (options.json) {
    output.info(JSON.stringify(summary, null, 2));
    return summary.health.state === 'unhealthy' ? 1 : 0;
  }

  output.info(style.bold('Platform'));
  output.blank();

  output.info(
    formatRows(
      [
        ['framework', `${summary.framework.version} (${summary.framework.channel})`],
        ['support', summary.framework.supportState],
        ['modules', `${summary.modules.installed} installed, ${summary.modules.unsigned} unsigned`],
        ['licence', `${summary.license.license.tier} — ${summary.license.state}`],
        ['health', `${summary.health.state} (${summary.health.score}/100)`],
        ['telemetry', summary.telemetry.enabled ? 'on' : 'off'],
      ],
      '  ',
    ),
  );

  output.blank();
  output.detail(`  ${summary.telemetry.detail}`);
  output.blank();

  const items = actionItems(summary);

  if (items.length === 0) {
    output.success('Nothing needs attention.');
    return 0;
  }

  output.info(style.bold('Needs attention'));
  output.blank();

  for (const item of items) {
    const badge = item.severity === 'error' ? style.bold('FAIL') : 'WARN';
    output.info(`  ${badge}  ${item.area.padEnd(24)} ${item.detail}`);
    if (options.verbose && item.remediation) output.detail(`        ${item.remediation}`);
  }

  output.blank();

  if (!options.verbose) output.detail('  Run with --verbose for what to do about each.');

  return items.some((item) => item.severity === 'error') ? 1 : 0;
}

// ---------------------------------------------------------------------------

export interface MarketplaceOptions {
  json?: boolean;
  category?: string;
  signedOnly?: boolean;
  verbose?: boolean;
}

/** `trustos marketplace [search-term]` — browse what can be installed. */
export async function runMarketplace(
  term: string | undefined,
  options: MarketplaceOptions,
  output: Output,
): Promise<number> {
  const frameworkVersion = await readFrameworkVersion();
  const catalogue = marketplace();

  const results = catalogue.search({
    text: term,
    frameworkVersion,
    signedOnly: options.signedOnly,
    tags: options.category ? [options.category] : undefined,
  });

  if (options.json) {
    output.info(JSON.stringify(results, null, 2));
    return 0;
  }

  if (results.length === 0) {
    output.warn(term ? `Nothing matches "${term}".` : 'The catalogue is empty.');
    output.detail('  trustos marketplace           list everything');
    output.detail('  trustos marketplace --category messaging');
    return 0;
  }

  output.info(style.bold(`${results.length} module(s)${term ? ` matching "${term}"` : ''}`));
  output.blank();

  for (const entry of results) {
    output.info(
      `  ${style.cyan(entry.catalog.metadata.id.padEnd(18))} ${entry.catalog.metadata.name}`,
    );
    output.detail(`    ${entry.catalog.metadata.description}`);
    output.detail(`    ${summarizeModule(entry)}`);

    if (options.verbose) {
      const dependencies = catalogue.dependenciesOf(entry.catalog.metadata.id);

      output.detail(
        formatRows(
          [
            ['version', entry.catalog.metadata.version],
            ['needs', `framework >= ${entry.catalog.metadata.minimumFrameworkVersion}`],
            ['pulls in', dependencies.join(', ') || '—'],
            ['tags', entry.catalog.metadata.tags.join(', ') || '—'],
            ['excludes', entry.catalog.outOfScope.join(', ') || '—'],
          ],
          '      ',
        ),
      );
    }

    output.blank();
  }

  output.detail('  trustos install <module>      add one to this application');
  output.detail('  trustos marketplace --verbose show what each one pulls in');

  return 0;
}

/** `trustos marketplace categories`. */
export function runMarketplaceCategories(output: Output): number {
  const categories = marketplace().categories();

  output.info(style.bold(`${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`));
  output.blank();
  output.info(
    formatRows(
      categories.map((entry) => [entry.tag, `${entry.count} module(s)`]),
      '  ',
    ),
  );
  output.blank();
  output.detail('  trustos marketplace --category <tag>');

  return 0;
}

// ---------------------------------------------------------------------------

export interface ArchitectureCheckOptions {
  path?: string;
  json?: boolean;
  /** Report warnings as failures. For a repository that has already cleared them. */
  strict?: boolean;
}

/**
 * `trustos architecture-check` — layering, naming, dependencies and the security rules.
 *
 * Reads the repository from disk here, because that is the one place a file list has to come
 * from. The validator itself takes data, which is what lets a pre-commit hook pass a diff.
 */
export async function runArchitectureCheck(
  options: ArchitectureCheckOptions,
  output: Output,
): Promise<number> {
  const root = options.path ?? process.cwd();
  const packagesRoot = join(root, 'packages');

  if (!existsSync(packagesRoot)) {
    output.error(`No packages directory at ${packagesRoot}.`);
    output.detail('Run this from a framework checkout, or pass --path.');
    return 1;
  }

  const { readdir } = await import('node:fs/promises');

  const files: Array<{ path: string; content: string }> = [];
  const declared: Record<string, string[]> = {};

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next')
        continue;

      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      if (!/\.tsx?$/.test(entry.name)) continue;

      files.push({ path: full.slice(root.length + 1), content: await readFile(full, 'utf8') });
    }
  };

  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = join(packagesRoot, entry.name, 'package.json');

    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
          dependencies?: Record<string, string>;
        };

        declared[entry.name] = Object.keys(manifest.dependencies ?? {})
          .filter((name) => name.startsWith('@trustos/'))
          .map((name) => name.slice('@trustos/'.length));
      } catch {
        // A package with an unreadable manifest is checked without the dependency rule rather
        // than skipped: the security rules still apply to it.
      }
    }

    await walk(join(packagesRoot, entry.name));
  }

  const report = validateArchitecture({ files, declaredDependencies: declared });

  if (options.json) {
    output.info(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  output.info(style.bold('Architecture'));
  output.detail(`  ${report.filesChecked} file(s) checked`);
  output.blank();

  if (report.violations.length === 0) {
    output.success('Every rule holds.');
    return 0;
  }

  for (const group of groupByRule(report)) {
    output.info(
      `  ${group.severity === 'error' ? style.bold('FAIL') : 'WARN'}  ` +
        `${group.ruleId.padEnd(30)} ${group.count} violation(s)`,
    );

    for (const violation of group.violations.slice(0, 5)) {
      output.detail(`        ${violation.file}:${violation.line} — ${violation.detail}`);
    }

    if (group.violations.length > 5) {
      output.detail(`        …and ${group.violations.length - 5} more`);
    }

    output.detail(`        → ${group.violations[0]?.remediation}`);
    output.blank();
  }

  const failed = !report.ok || (options.strict === true && report.violations.length > 0);

  if (failed) {
    output.error(
      `${report.violations.filter((violation) => violation.severity === 'error').length} error(s), ` +
        `${report.violations.filter((violation) => violation.severity === 'warning').length} warning(s).`,
    );
    return 1;
  }

  output.warn(`${report.violations.length} warning(s). Nothing blocking.`);
  return 0;
}

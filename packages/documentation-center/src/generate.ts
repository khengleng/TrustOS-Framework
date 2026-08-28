import { renderChangelog, type NotesEntry } from '@trustos/release-manager';
import type { AnalysisReport, GraphModule } from '@trustos/dependency-analyzer';

/**
 * Generated documentation.
 *
 * The rule this package exists to enforce: **anything derivable from the code is generated, and
 * anything not derivable is hand-written.** Mixing the two produces documentation that is
 * partially stale, and a reader who finds one stale section stops trusting the accurate ones.
 *
 * So: module lists, permission tables, CLI references, dependency graphs and changelogs are
 * generated here. Why a thing is designed the way it is stays in `docs/*.md` written by a person,
 * because a generator cannot produce a reason.
 *
 * Everything returns strings. Nothing is written to disk, so the same function serves
 * `trustos docs`, the developer portal, and a test that asserts the output contains what it should.
 */

export interface DocumentPage {
  path: string;
  title: string;
  content: string;
}

export interface ModuleDoc {
  id: string;
  name: string;
  description: string;
  version: string;
  owner: string;
  stability: string;
  minimumFrameworkVersion: string;
  permissions: ReadonlyArray<{ key: string; description: string }>;
  routes: ReadonlyArray<{ method: string; path: string; permission?: string }>;
  dependencies: ReadonlyArray<{ moduleId: string; reason: string; optional?: boolean }>;
  environment: ReadonlyArray<{ name: string; description: string; required?: boolean }>;
  outOfScope: readonly string[];
}

/** One page per module, plus an index. */
export function generateModuleDocs(modules: readonly ModuleDoc[]): DocumentPage[] {
  const pages: DocumentPage[] = [
    {
      path: 'docs/generated/modules/index.md',
      title: 'Modules',
      content: moduleIndex(modules),
    },
  ];

  for (const module of modules) {
    pages.push({
      path: `docs/generated/modules/${module.id}.md`,
      title: module.name,
      content: modulePage(module),
    });
  }

  return pages;
}

function moduleIndex(modules: readonly ModuleDoc[]): string {
  const lines = ['# Modules', ''];

  lines.push('Generated from the module catalog. Do not edit — edit the catalog.');
  lines.push('');
  lines.push('| Module | Version | Stability | Owner | What it does |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const module of [...modules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    lines.push(
      `| [\`${module.id}\`](${module.id}.md) | ${module.version} | ${module.stability} | ` +
        `${module.owner} | ${firstSentence(module.description)} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function modulePage(module: ModuleDoc): string {
  const lines = [`# ${module.name}`, ''];

  lines.push(module.description);
  lines.push('');
  lines.push(
    `**Version** ${module.version} · **Stability** ${module.stability} · **Owner** ${module.owner} · ` +
      `**Needs framework** ≥ ${module.minimumFrameworkVersion}`,
  );
  lines.push('');

  if (module.dependencies.length > 0) {
    lines.push('## Depends on');
    lines.push('');
    lines.push('| Module | Why | Optional |');
    lines.push('| --- | --- | --- |');
    for (const dependency of module.dependencies) {
      lines.push(
        `| \`${dependency.moduleId}\` | ${dependency.reason} | ${dependency.optional ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  }

  if (module.permissions.length > 0) {
    lines.push('## Permissions');
    lines.push('');
    lines.push('Permission keys are permanent. Add freely, never rename — a renamed key silently');
    lines.push('revokes access on every deployment that has not been migrated.');
    lines.push('');
    lines.push('| Key | Grants |');
    lines.push('| --- | --- |');
    for (const permission of module.permissions) {
      lines.push(`| \`${permission.key}\` | ${permission.description} |`);
    }
    lines.push('');
  }

  if (module.routes.length > 0) {
    lines.push('## Endpoints');
    lines.push('');
    lines.push('| Method | Path | Permission |');
    lines.push('| --- | --- | --- |');
    for (const route of module.routes) {
      lines.push(
        `| ${route.method} | \`${route.path}\` | ${route.permission ? `\`${route.permission}\`` : '—'} |`,
      );
    }
    lines.push('');
  }

  if (module.environment.length > 0) {
    lines.push('## Configuration');
    lines.push('');
    lines.push('| Variable | Required | What it is |');
    lines.push('| --- | --- | --- |');
    for (const variable of module.environment) {
      lines.push(
        `| \`${variable.name}\` | ${variable.required ? 'yes' : 'no'} | ${variable.description} |`,
      );
    }
    lines.push('');
  }

  if (module.outOfScope.length > 0) {
    lines.push('## Out of scope');
    lines.push('');
    lines.push(
      'Deliberate exclusions. A stated exclusion is reviewable; a module that later grows',
    );
    lines.push('the thing it said it would not is a visible change rather than a drift.');
    lines.push('');
    for (const item of module.outOfScope) lines.push(`- ${item}`);
    lines.push('');
  }

  return lines.join('\n');
}

export interface CliCommandDoc {
  name: string;
  description: string;
  arguments?: ReadonlyArray<{ name: string; description: string; required?: boolean }>;
  options?: ReadonlyArray<{ flags: string; description: string }>;
  subcommands?: readonly CliCommandDoc[];
}

/** The CLI reference, from the command tree. */
export function generateCliDocs(commands: readonly CliCommandDoc[]): DocumentPage {
  const lines = ['# CLI reference', ''];

  lines.push('Generated from the command definitions. Do not edit.');
  lines.push('');
  lines.push('| Command | What it does |');
  lines.push('| --- | --- |');

  for (const command of commands) {
    lines.push(`| \`trustos ${command.name}\` | ${command.description} |`);
  }

  lines.push('');

  for (const command of commands) {
    lines.push(...renderCommand(command, 'trustos', 2));
  }

  return { path: 'docs/generated/cli.md', title: 'CLI reference', content: lines.join('\n') };
}

function renderCommand(command: CliCommandDoc, prefix: string, depth: number): string[] {
  const lines: string[] = [];
  const full = `${prefix} ${command.name}`;

  lines.push(`${'#'.repeat(depth)} \`${full}\``);
  lines.push('');
  lines.push(command.description);
  lines.push('');

  if (command.arguments && command.arguments.length > 0) {
    lines.push('| Argument | Required | What it is |');
    lines.push('| --- | --- | --- |');
    for (const argument of command.arguments) {
      lines.push(
        `| \`${argument.name}\` | ${argument.required ? 'yes' : 'no'} | ${argument.description} |`,
      );
    }
    lines.push('');
  }

  if (command.options && command.options.length > 0) {
    lines.push('| Option | What it does |');
    lines.push('| --- | --- |');
    for (const option of command.options)
      lines.push(`| \`${option.flags}\` | ${option.description} |`);
    lines.push('');
  }

  for (const subcommand of command.subcommands ?? []) {
    lines.push(...renderCommand(subcommand, full, depth + 1));
  }

  return lines;
}

/**
 * The dependency graph, as Mermaid.
 *
 * Mermaid rather than an image: it renders in GitHub, in the portal and in most editors, and it
 * diffs as text. A generated PNG is a binary that changes on every regeneration and tells a
 * reviewer nothing.
 */
export function generateDependencyGraph(
  modules: readonly GraphModule[],
  analysis?: AnalysisReport,
): DocumentPage {
  const lines = ['# Dependency graph', ''];

  lines.push('Generated from the module catalog.');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph TD');

  const sorted = [...modules].sort((a, b) => (a.id < b.id ? -1 : 1));

  for (const module of sorted) {
    lines.push(`  ${sanitize(module.id)}["${module.id}<br/>${module.version}"]`);
  }

  for (const module of sorted) {
    for (const dependency of module.dependencies) {
      const arrow = dependency.optional ? '-.->' : '-->';
      lines.push(`  ${sanitize(module.id)} ${arrow} ${sanitize(dependency.moduleId)}`);
    }
  }

  lines.push('```');
  lines.push('');
  lines.push('Dotted edges are optional dependencies: the module degrades rather than failing.');
  lines.push('');

  if (analysis && analysis.findings.length > 0) {
    lines.push('## Findings');
    lines.push('');
    for (const finding of analysis.findings) {
      lines.push(`- **${finding.severity}** ${finding.kind}: ${finding.detail}`);
    }
    lines.push('');
  }

  return {
    path: 'docs/generated/dependency-graph.md',
    title: 'Dependency graph',
    content: lines.join('\n'),
  };
}

const sanitize = (id: string): string => id.replace(/[^a-zA-Z0-9]/g, '_');

/** The changelog, from the version history. */
export function generateChangelog(entries: readonly NotesEntry[]): DocumentPage {
  return {
    path: 'docs/generated/changelog.md',
    title: 'Changelog',
    content: renderChangelog(entries),
  };
}

export interface ApiOperationDoc {
  method: string;
  path: string;
  summary: string;
  permission?: string;
  module?: string;
}

/**
 * The API reference.
 *
 * Grouped by module rather than by path, because a reader arrives knowing which capability they
 * are working with, not which URL prefix it happens to use.
 */
export function generateApiDocs(operations: readonly ApiOperationDoc[]): DocumentPage {
  const lines = ['# API reference', ''];

  lines.push('Generated from the route declarations. Do not edit.');
  lines.push('');

  const byModule = new Map<string, ApiOperationDoc[]>();

  for (const operation of operations) {
    const key = operation.module ?? 'application';
    byModule.set(key, [...(byModule.get(key) ?? []), operation]);
  }

  for (const [module, entries] of [...byModule.entries()].sort()) {
    lines.push(`## ${module}`);
    lines.push('');
    lines.push('| Method | Path | Permission | What it does |');
    lines.push('| --- | --- | --- | --- |');

    for (const operation of entries.sort((a, b) => (a.path < b.path ? -1 : 1))) {
      lines.push(
        `| ${operation.method} | \`${operation.path}\` | ` +
          `${operation.permission ? `\`${operation.permission}\`` : '—'} | ${operation.summary} |`,
      );
    }

    lines.push('');
  }

  return { path: 'docs/generated/api.md', title: 'API reference', content: lines.join('\n') };
}

/** An index over everything generated, so the output is navigable. */
export function generateIndex(pages: readonly DocumentPage[]): DocumentPage {
  const lines = ['# Generated documentation', ''];

  lines.push('Every page here is generated. Edit the source, not the page.');
  lines.push('');
  lines.push('Prose explaining *why* a thing is designed the way it is lives in `docs/` and is');
  lines.push('written by a person — a generator cannot produce a reason.');
  lines.push('');

  for (const page of [...pages].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const relative = page.path.replace('docs/generated/', '');
    lines.push(`- [${page.title}](${relative})`);
  }

  lines.push('');
  return {
    path: 'docs/generated/index.md',
    title: 'Generated documentation',
    content: lines.join('\n'),
  };
}

const firstSentence = (text: string): string => {
  const match = /^(.*?\.)(\s|$)/s.exec(text.replace(/\s+/g, ' '));
  return match ? (match[1] as string) : text.replace(/\s+/g, ' ');
};

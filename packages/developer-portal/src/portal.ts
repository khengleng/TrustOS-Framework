import type { DocumentPage } from '@trustos/documentation-center';

/**
 * The developer portal.
 *
 * A **static site generated from the repository**, and that is the whole design. No server, no
 * database, no build step beyond writing files. Three reasons, in order of how much they matter:
 *
 *   1. **It works offline and air-gapped.** The deployments with the strictest requirements are
 *      the ones whose developers most need documentation they can actually reach.
 *   2. **It cannot drift.** Every page comes from the same source as the thing it documents, so a
 *      portal that is up to date is the normal state rather than an achievement.
 *   3. **It has no attack surface.** A portal with a search backend and a session is a service to
 *      operate, patch and audit — for documentation.
 *
 * The API explorer is the interesting compromise. A real explorer sends requests, which needs
 * credentials and a running API. This one generates the *request* — a curl command, a fetch
 * snippet — with the right shape, headers and permission, and lets the developer run it. That is
 * most of the value with none of the "why does the docs site have my production token".
 */

export interface PortalSection {
  id: string;
  title: string;
  description: string;
  pages: DocumentPage[];
}

export interface PortalInput {
  frameworkVersion: string;
  productName?: string;
  /** Hand-written guides, read from `docs/`. */
  guides?: readonly DocumentPage[];
  /** Generated references from `@trustos/documentation-center`. */
  generated?: readonly DocumentPage[];
  modules?: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    version: string;
    stability: string;
  }>;
  templates?: ReadonlyArray<{
    id: string;
    displayName: string;
    description: string;
    category: string;
  }>;
  sdks?: ReadonlyArray<{
    language: string;
    version: string;
    downloadUrl: string;
    checksum: string;
  }>;
  operations?: ReadonlyArray<{
    method: string;
    path: string;
    summary: string;
    permission?: string;
  }>;
  releases?: ReadonlyArray<{
    version: string;
    channel: string;
    releasedAt: string;
    notes?: string;
  }>;
  apiBaseUrl?: string;
}

export interface Portal {
  sections: PortalSection[];
  /** Every file to write, including the index. */
  files: DocumentPage[];
}

export function buildPortal(input: PortalInput): Portal {
  const sections: PortalSection[] = [];

  if (input.guides && input.guides.length > 0) {
    sections.push({
      id: 'guides',
      title: 'Guides',
      description: 'Written by people. Why things are the way they are.',
      pages: [...input.guides],
    });
  }

  if (input.generated && input.generated.length > 0) {
    sections.push({
      id: 'reference',
      title: 'Reference',
      description: 'Generated from the code. Always current, never explanatory.',
      pages: [...input.generated],
    });
  }

  if (input.modules && input.modules.length > 0) {
    sections.push({
      id: 'marketplace',
      title: 'Modules',
      description: 'What can be installed, and what each one does.',
      pages: [modulesPage(input.modules)],
    });
  }

  if (input.templates && input.templates.length > 0) {
    sections.push({
      id: 'templates',
      title: 'Templates',
      description: 'Starting points for a new application.',
      pages: [templatesPage(input.templates)],
    });
  }

  if (input.operations && input.operations.length > 0) {
    sections.push({
      id: 'explorer',
      title: 'API explorer',
      description: 'Ready-to-run requests for every endpoint.',
      pages: [explorerPage(input.operations, input.apiBaseUrl ?? 'http://localhost:3000/api')],
    });
  }

  if (input.sdks && input.sdks.length > 0) {
    sections.push({
      id: 'sdks',
      title: 'SDKs',
      description: 'Client libraries, with checksums.',
      pages: [sdkPage(input.sdks)],
    });
  }

  if (input.releases && input.releases.length > 0) {
    sections.push({
      id: 'releases',
      title: 'Releases',
      description: 'What shipped, when, and what it changed.',
      pages: [releasesPage(input.releases)],
    });
  }

  const files = sections.flatMap((section) => section.pages);

  return {
    sections,
    files: [indexPage(input, sections), ...files],
  };
}

function indexPage(input: PortalInput, sections: readonly PortalSection[]): DocumentPage {
  const lines = [`# ${input.productName ?? 'TrustOS'} developer portal`, ''];

  lines.push(`Framework ${input.frameworkVersion}.`);
  lines.push('');
  lines.push('This site is generated from the repository and works offline. Every reference page');
  lines.push('comes from the same source as the thing it documents, so it cannot drift.');
  lines.push('');

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push('');
    lines.push(section.description);
    lines.push('');

    for (const page of section.pages) {
      lines.push(`- [${page.title}](${page.path})`);
    }

    lines.push('');
  }

  lines.push('## Getting started');
  lines.push('');
  lines.push('```bash');
  lines.push('trustos templates                 # what you can start from');
  lines.push('trustos new <template> --name my-app');
  lines.push('trustos marketplace search <term> # what you can add');
  lines.push('trustos platform info             # what you have');
  lines.push('```');
  lines.push('');

  return { path: 'portal/index.md', title: 'Developer portal', content: lines.join('\n') };
}

function modulesPage(modules: NonNullable<PortalInput['modules']>): DocumentPage {
  const lines = ['# Modules', ''];

  lines.push('Install with `trustos install <id>`. Everything here is local and signed — there is');
  lines.push('no remote registry, which is what makes the supply chain tractable.');
  lines.push('');
  lines.push('| Module | Version | Stability | What it does |');
  lines.push('| --- | --- | --- | --- |');

  for (const module of [...modules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    lines.push(
      `| \`${module.id}\` | ${module.version} | ${module.stability} | ${module.description} |`,
    );
  }

  lines.push('');
  return { path: 'portal/modules.md', title: 'Modules', content: lines.join('\n') };
}

function templatesPage(templates: NonNullable<PortalInput['templates']>): DocumentPage {
  const lines = ['# Templates', ''];

  const byCategory = new Map<string, typeof templates>();

  for (const template of templates) {
    byCategory.set(template.category, [
      ...(byCategory.get(template.category) ?? []),
      template,
    ] as never);
  }

  for (const [category, entries] of [...byCategory.entries()].sort()) {
    lines.push(`## ${category}`);
    lines.push('');

    for (const template of entries) {
      lines.push(`### \`${template.id}\` — ${template.displayName}`);
      lines.push('');
      lines.push(template.description);
      lines.push('');
      lines.push('```bash');
      lines.push(`trustos new ${template.id} --name my-app`);
      lines.push('```');
      lines.push('');
    }
  }

  return { path: 'portal/templates.md', title: 'Templates', content: lines.join('\n') };
}

/**
 * The explorer: a runnable request per endpoint.
 *
 * The token is a placeholder, never a real one, and the page says so. A documentation site that
 * held a working credential would be the softest target in the deployment.
 */
function explorerPage(
  operations: NonNullable<PortalInput['operations']>,
  baseUrl: string,
): DocumentPage {
  const lines = ['# API explorer', ''];

  lines.push('Copy, set your token, run. The requests below carry a placeholder — this site never');
  lines.push(
    'holds a credential, because a documentation site that did would be the softest target',
  );
  lines.push('in the deployment.');
  lines.push('');
  lines.push('```bash');
  lines.push('export TRUSTOS_TOKEN="<your access token>"');
  lines.push('```');
  lines.push('');

  for (const operation of [...operations].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    lines.push(`## \`${operation.method} ${operation.path}\``);
    lines.push('');
    lines.push(operation.summary);
    lines.push('');

    if (operation.permission) {
      lines.push(`Requires \`${operation.permission}\`.`);
      lines.push('');
    }

    lines.push('```bash');
    lines.push(`curl -X ${operation.method} '${baseUrl}${operation.path}' \\`);
    lines.push(`  -H "Authorization: Bearer $TRUSTOS_TOKEN" \\`);

    if (operation.method === 'POST' || operation.method === 'PATCH' || operation.method === 'PUT') {
      lines.push(`  -H 'Content-Type: application/json' \\`);
      lines.push(`  -d '{}'`);
    } else {
      lines.push(`  -H 'Accept: application/json'`);
    }

    lines.push('```');
    lines.push('');
  }

  return { path: 'portal/api-explorer.md', title: 'API explorer', content: lines.join('\n') };
}

function sdkPage(sdks: NonNullable<PortalInput['sdks']>): DocumentPage {
  const lines = ['# SDKs', ''];

  lines.push('Verify the checksum before using a download. A release without one is worse than no');
  lines.push('release — it looks official and proves nothing.');
  lines.push('');
  lines.push('| Language | Version | Download | SHA-256 |');
  lines.push('| --- | --- | --- | --- |');

  for (const sdk of sdks) {
    lines.push(
      `| ${sdk.language} | ${sdk.version} | [download](${sdk.downloadUrl}) | \`${sdk.checksum}\` |`,
    );
  }

  lines.push('');
  lines.push('```bash');
  lines.push('shasum -a 256 <downloaded-file>   # must match the value above');
  lines.push('```');
  lines.push('');

  return { path: 'portal/sdks.md', title: 'SDKs', content: lines.join('\n') };
}

function releasesPage(releases: NonNullable<PortalInput['releases']>): DocumentPage {
  const lines = ['# Releases', ''];

  lines.push('Newest first.');
  lines.push('');

  for (const release of [...releases].reverse()) {
    lines.push(`## ${release.version} — ${release.channel}`);
    lines.push('');
    lines.push(`Released ${release.releasedAt.slice(0, 10)}.`);
    lines.push('');

    if (release.notes) {
      lines.push(release.notes);
      lines.push('');
    }
  }

  return { path: 'portal/releases.md', title: 'Releases', content: lines.join('\n') };
}

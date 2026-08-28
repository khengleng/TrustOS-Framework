import { describe, expect, it } from 'vitest';
import {
  generateApiDocs,
  generateChangelog,
  generateCliDocs,
  generateDependencyGraph,
  generateIndex,
  generateModuleDocs,
  type ModuleDoc,
} from './index';

const MODULE: ModuleDoc = {
  id: 'search',
  name: 'Search',
  description: 'Full-text search over product entities. Indexes on write.',
  version: '1.0.0',
  owner: 'Platform Team',
  stability: 'stable',
  minimumFrameworkVersion: '0.4.0',
  permissions: [{ key: 'search.query', description: 'Run a search.' }],
  routes: [{ method: 'GET', path: '/search', permission: 'search.query' }],
  dependencies: [{ moduleId: 'events', reason: 'Reindexes on entity change.' }],
  environment: [
    { name: 'SEARCH_INDEX_PATH', description: 'Where the index lives.', required: true },
  ],
  outOfScope: ['vector search', 'external search engines'],
};

describe('module documentation', () => {
  const pages = generateModuleDocs([MODULE]);

  it('writes an index and a page per module', () => {
    expect(pages.map((page) => page.path)).toEqual([
      'docs/generated/modules/index.md',
      'docs/generated/modules/search.md',
    ]);
  });

  it('says it is generated, so nobody edits it', () => {
    expect(pages[0]?.content).toMatch(/Do not edit — edit the catalog/);
  });

  it('documents permissions with the rule that makes them permanent', () => {
    expect(pages[1]?.content).toMatch(/Add freely, never rename/);
    expect(pages[1]?.content).toMatch(/`search\.query`/);
  });

  it('carries the out-of-scope list, with why it exists', () => {
    expect(pages[1]?.content).toMatch(/A stated exclusion is reviewable/);
    expect(pages[1]?.content).toMatch(/vector search/);
  });

  it('records why each dependency exists', () => {
    expect(pages[1]?.content).toMatch(/Reindexes on entity change/);
  });
});

describe('the CLI reference', () => {
  it('renders nested commands under their parent', () => {
    const page = generateCliDocs([
      {
        name: 'platform',
        description: 'Inspect the platform.',
        subcommands: [{ name: 'info', description: 'Show a summary.' }],
      },
    ]);

    expect(page.content).toMatch(/## `trustos platform`/);
    expect(page.content).toMatch(/### `trustos platform info`/);
  });

  it('renders options and arguments', () => {
    const page = generateCliDocs([
      {
        name: 'install',
        description: 'Install a module.',
        arguments: [{ name: 'module', description: 'The module id.', required: true }],
        options: [{ flags: '--dry-run', description: 'Show the plan without applying it.' }],
      },
    ]);

    expect(page.content).toMatch(/\| `module` \| yes \|/);
    expect(page.content).toMatch(/\| `--dry-run` \|/);
  });
});

describe('the dependency graph', () => {
  it('renders Mermaid, which diffs as text', () => {
    /*
     * A generated PNG is a binary that changes on every regeneration and tells a reviewer
     * nothing.
     */
    const page = generateDependencyGraph([
      { id: 'a', version: '1.0.0', dependencies: [{ moduleId: 'b', versionRange: '^1.0.0' }] },
      { id: 'b', version: '1.0.0', dependencies: [] },
    ]);

    expect(page.content).toMatch(/```mermaid/);
    expect(page.content).toMatch(/a --> b/);
  });

  it('draws an optional dependency differently and says what that means', () => {
    const page = generateDependencyGraph([
      {
        id: 'a',
        version: '1.0.0',
        dependencies: [{ moduleId: 'b', versionRange: '^1.0.0', optional: true }],
      },
      { id: 'b', version: '1.0.0', dependencies: [] },
    ]);

    expect(page.content).toMatch(/a -\.-> b/);
    expect(page.content).toMatch(/module degrades rather than failing/);
  });

  it('sanitizes ids that are not valid Mermaid node names', () => {
    const page = generateDependencyGraph([{ id: 'gold-shop', version: '1.0.0', dependencies: [] }]);

    expect(page.content).toMatch(/gold_shop\["gold-shop/);
  });
});

describe('the API reference', () => {
  it('groups by module, because that is how a reader arrives', () => {
    const page = generateApiDocs([
      { method: 'GET', path: '/search', summary: 'Search.', module: 'search' },
      { method: 'GET', path: '/health', summary: 'Health.' },
    ]);

    expect(page.content).toMatch(/## application/);
    expect(page.content).toMatch(/## search/);
  });
});

describe('the index', () => {
  it('states the split between generated and hand-written', () => {
    const index = generateIndex([
      { path: 'docs/generated/cli.md', title: 'CLI reference', content: '' },
    ]);

    expect(index.content).toMatch(/a generator cannot produce a reason/);
    expect(index.content).toMatch(/\[CLI reference\]\(cli\.md\)/);
  });
});

describe('the changelog', () => {
  it('is generated from the history rather than maintained beside it', () => {
    const page = generateChangelog([
      {
        version: '0.5.0',
        releasedAt: '2026-06-01',
        summary: 'Platform.',
        breakingChanges: [],
        securityFixes: [],
        features: ['Marketplace.'],
        fixes: [],
        deprecations: [],
      },
    ]);

    expect(page.content).toMatch(/Do not edit — edit the history/);
  });
});

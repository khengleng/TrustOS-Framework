import { describe, expect, it } from 'vitest';
import { buildPortal } from './index';

describe('the portal', () => {
  it('builds only the sections it has content for', () => {
    const portal = buildPortal({ frameworkVersion: '0.5.0' });

    expect(portal.sections).toEqual([]);
    expect(portal.files.map((file) => file.path)).toEqual(['portal/index.md']);
  });

  it('separates hand-written guides from generated reference', () => {
    /*
     * A reader who finds one stale section stops trusting the accurate ones, so the two are
     * labelled rather than mixed.
     */
    const portal = buildPortal({
      frameworkVersion: '0.5.0',
      guides: [{ path: 'docs/architecture.md', title: 'Architecture', content: '' }],
      generated: [{ path: 'docs/generated/cli.md', title: 'CLI reference', content: '' }],
    });

    expect(portal.sections.map((section) => section.id)).toEqual(['guides', 'reference']);
    expect(portal.sections[0]?.description).toMatch(/Written by people/);
    expect(portal.sections[1]?.description).toMatch(/Always current, never explanatory/);
  });

  it('says the site is generated and works offline', () => {
    const portal = buildPortal({ frameworkVersion: '0.5.0' });

    expect(portal.files[0]?.content).toMatch(/generated from the repository and works offline/);
  });
});

describe('the API explorer', () => {
  const portal = buildPortal({
    frameworkVersion: '0.5.0',
    apiBaseUrl: 'https://api.example.test',
    operations: [
      { method: 'GET', path: '/invoices', summary: 'List invoices.', permission: 'billing.read' },
      { method: 'POST', path: '/invoices', summary: 'Create an invoice.' },
    ],
  });

  const page = portal.files.find((file) => file.path === 'portal/api-explorer.md')?.content ?? '';

  it('generates a runnable request rather than sending one', () => {
    // Most of the value with none of the "why does the docs site have my production token".
    expect(page).toMatch(/curl -X GET 'https:\/\/api\.example\.test\/invoices'/);
  });

  it('uses a placeholder token and says why', () => {
    expect(page).toMatch(/\$TRUSTOS_TOKEN/);
    expect(page).toMatch(/softest target\s+in the deployment/);
    expect(page).not.toMatch(/Bearer [A-Za-z0-9]{20,}/);
  });

  it('adds a body only to the methods that take one', () => {
    const get = page.slice(page.indexOf('GET /invoices'), page.indexOf('POST /invoices'));

    expect(get).not.toMatch(/-d '\{\}'/);
    expect(page.slice(page.indexOf('POST /invoices'))).toMatch(/-d '\{\}'/);
  });

  it('names the permission an endpoint needs', () => {
    expect(page).toMatch(/Requires `billing\.read`/);
  });
});

describe('SDK downloads', () => {
  it('shows a checksum and how to verify it', () => {
    // A release without one looks official and proves nothing.
    const portal = buildPortal({
      frameworkVersion: '0.5.0',
      sdks: [
        {
          language: 'TypeScript',
          version: '1.0.0',
          downloadUrl: 'https://example.test/sdk.tgz',
          checksum: 'a'.repeat(64),
        },
      ],
    });

    const page = portal.files.find((file) => file.path === 'portal/sdks.md')?.content ?? '';

    expect(page).toMatch(/shasum -a 256/);
    expect(page).toMatch(/looks official and proves nothing/);
  });
});

describe('templates and modules', () => {
  it('groups templates by category with a runnable command', () => {
    const portal = buildPortal({
      frameworkVersion: '0.5.0',
      templates: [
        {
          id: 'crm',
          displayName: 'CRM',
          description: 'Customers and leads.',
          category: 'business',
        },
      ],
    });

    const page = portal.files.find((file) => file.path === 'portal/templates.md')?.content ?? '';

    expect(page).toMatch(/## business/);
    expect(page).toMatch(/trustos new crm --name my-app/);
  });

  it('says the module index is local and signed', () => {
    const portal = buildPortal({
      frameworkVersion: '0.5.0',
      modules: [
        {
          id: 'search',
          name: 'Search',
          description: 'Search.',
          version: '1.0.0',
          stability: 'stable',
        },
      ],
    });

    const page = portal.files.find((file) => file.path === 'portal/modules.md')?.content ?? '';

    expect(page).toMatch(/there is\s+no remote registry/);
  });
});

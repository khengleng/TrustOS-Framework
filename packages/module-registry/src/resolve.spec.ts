import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG } from './catalog';
import { requireModule } from './declarations';
import { resolveInstallOrder, topologicalIds, topologicalOrder } from './resolve';

const ids = (entries: Array<{ metadata: { id: string } }>): string[] =>
  entries.map((entry) => entry.metadata.id);

describe('topologicalIds', () => {
  it('puts a dependency before the module that needs it', () => {
    const order = topologicalIds([
      { id: 'b', dependencies: [{ moduleId: 'a' }] },
      { id: 'a', dependencies: [] },
    ]);

    expect(order).toEqual(['a', 'b']);
  });

  it('accepts a diamond, where two modules share a dependency', () => {
    // A shared dependency is legal and common; only a cycle is an error. A
    // visit counter would reject this.
    const order = topologicalIds([
      { id: 'top', dependencies: [{ moduleId: 'left' }, { moduleId: 'right' }] },
      { id: 'left', dependencies: [{ moduleId: 'base' }] },
      { id: 'right', dependencies: [{ moduleId: 'base' }] },
      { id: 'base', dependencies: [] },
    ]);

    expect(order[0]).toBe('base');
    expect(order.indexOf('top')).toBe(3);
    expect(order).toHaveLength(4);
  });

  it('names the path when it finds a cycle', () => {
    expect(() =>
      topologicalIds([
        { id: 'a', dependencies: [{ moduleId: 'b' }] },
        { id: 'b', dependencies: [{ moduleId: 'a' }] },
      ]),
    ).toThrowError(/a -> b -> a|b -> a -> b/);
  });

  it('is deterministic when the graph does not constrain the order', () => {
    const nodes = [
      { id: 'zebra', dependencies: [] },
      { id: 'alpha', dependencies: [] },
    ];

    expect(topologicalIds(nodes)).toEqual(['alpha', 'zebra']);
    expect(topologicalIds([...nodes].reverse())).toEqual(['alpha', 'zebra']);
  });
});

describe('topologicalOrder', () => {
  it('orders the real catalog with file-storage ahead of document', () => {
    const order = ids(topologicalOrder(MODULE_CATALOG));
    expect(order.indexOf('file-storage')).toBeLessThan(order.indexOf('document'));
    expect(order).toHaveLength(MODULE_CATALOG.length);
  });
});

describe('resolveInstallOrder', () => {
  it('pulls in a required dependency and installs it first', () => {
    const resolved = resolveInstallOrder(MODULE_CATALOG, ['document']);

    expect(ids(resolved.order)).toEqual(['file-storage', 'document']);
    expect(resolved.addedForDependencies).toEqual(['file-storage']);
  });

  it('does not reinstall a dependency that is already present', () => {
    const resolved = resolveInstallOrder(MODULE_CATALOG, ['document'], {
      installed: ['file-storage'],
    });

    expect(ids(resolved.order)).toEqual(['document']);
    expect(resolved.addedForDependencies).toEqual([]);
  });

  it('reports a re-requested module instead of installing it twice', () => {
    // This is what makes `add-module` idempotent: running it again is a no-op
    // that says so, rather than a second write over the same files.
    const resolved = resolveInstallOrder(MODULE_CATALOG, ['search'], { installed: ['search'] });

    expect(resolved.order).toEqual([]);
    expect(resolved.alreadyInstalled).toEqual(['search']);
  });

  it('resolves several requests into one ordered set without duplicates', () => {
    const resolved = resolveInstallOrder(MODULE_CATALOG, ['document', 'file-storage', 'search']);

    expect(ids(resolved.order)).toEqual(['file-storage', 'document', 'search']);
  });

  it('rejects an unknown module and lists the known ones', () => {
    expect(() => resolveInstallOrder(MODULE_CATALOG, ['payments'])).toThrowError(
      /Unknown module "payments"[\s\S]*/,
    );

    try {
      resolveInstallOrder(MODULE_CATALOG, ['payments']);
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('notification');
    }
  });

  it('refuses a module that needs a newer framework than the application has', () => {
    const entry = structuredClone(requireModule('search'));
    entry.metadata.minimumFrameworkVersion = '9.0.0';

    expect(() =>
      resolveInstallOrder([entry], ['search'], { frameworkVersion: '0.1.0' }),
    ).toThrowError(/needs framework 9.0.0 or newer/);
  });

  it('accepts a framework newer than the minimum', () => {
    expect(() =>
      resolveInstallOrder(MODULE_CATALOG, ['search'], { frameworkVersion: '1.4.0' }),
    ).not.toThrow();
  });

  it('refuses a dependency whose catalog version does not satisfy the declared range', () => {
    const storage = structuredClone(requireModule('file-storage'));
    const document = structuredClone(requireModule('document'));
    // The catalog moved to 0.2.0 while `document` was still reviewed against
    // 0.1.x. Under npm pre-1.0 caret rules that is a breaking change.
    storage.metadata.version = '0.2.0';

    expect(() => resolveInstallOrder([storage, document], ['document'])).toThrowError(
      /needs "file-storage" \^0\.1\.0, but the catalog has 0\.2\.0/,
    );
  });
});

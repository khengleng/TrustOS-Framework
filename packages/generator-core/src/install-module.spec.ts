import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadApplicationManifest, resolveApplicationRoot } from './application-manifest';
import { installModules, planModuleInstall } from './install-module';
import { MANAGED_MARKER, mergeEnvExample, mergePackageJson } from './module-install-files';

/**
 * Module installation.
 *
 * The application here is a minimal stand-in — a manifest, a package.json, an
 * `.env.example` and the two files the installer expects to find — rather than a
 * fully generated project. That keeps the tests about the installer's own rules:
 * what it owns, what it merges, what it refuses, and what it leaves alone. CI
 * installs into a real generated application on top of this.
 */

const FRAMEWORK = resolve(__dirname, '..', '..', '..');

let app: string;

const MANIFEST = {
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
  modules: [] as unknown[],
};

async function write(relativePath: string, contents: string): Promise<void> {
  const path = join(app, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

async function read(relativePath: string): Promise<string> {
  return readFile(join(app, relativePath), 'utf8');
}

async function buildApplication(overrides: Partial<typeof MANIFEST> = {}): Promise<void> {
  await write('trustos.json', `${JSON.stringify({ ...MANIFEST, ...overrides }, null, 2)}\n`);
  await write(
    'package.json',
    `${JSON.stringify({ name: 'demo', private: true, dependencies: { zod: '^3.24.1' } }, null, 2)}\n`,
  );
  await write('.env.example', 'NODE_ENV=development\nPORT=3000\n');
  await write(
    'apps/api/src/app.module.ts',
    "import { TRUSTOS_MODULE_IMPORTS } from './modules/trustos-modules';\n",
  );
  await write(
    'apps/api/src/modules/trustos-modules.ts',
    `// ${MANAGED_MARKER} — generated.\nexport const TRUSTOS_MODULE_IMPORTS = [];\n`,
  );
  await write('docs/modules.md', `<!-- ${MANAGED_MARKER} — generated. -->\n\n# Modules\n`);
}

const request = (moduleIds: string[]) => ({
  moduleIds,
  applicationRoot: app,
  frameworkPath: FRAMEWORK,
  generatedAt: '2026-02-01T00:00:00.000Z',
});

beforeEach(async () => {
  app = await mkdtemp(join(tmpdir(), 'trustos-install-'));
  await buildApplication();
});

afterEach(async () => {
  await rm(app, { recursive: true, force: true });
});

describe('planModuleInstall', () => {
  it('pulls in a dependency and orders it first', async () => {
    const planned = await planModuleInstall(request(['document']));

    expect(planned.order.map((entry) => entry.metadata.id)).toEqual(['file-storage', 'document']);
    expect(planned.addedForDependencies).toEqual(['file-storage']);
  });

  it('plans the schema fragment for every module that has one', async () => {
    const planned = await planModuleInstall(request(['document']));

    expect(planned.migrations).toEqual([
      'prisma/schema/20-file-storage.prisma',
      'prisma/schema/22-document.prisma',
    ]);
  });

  it('plans no fragment for a module that owns no tables', async () => {
    const planned = await planModuleInstall(request(['search']));
    expect(planned.migrations).toEqual([]);
  });

  it('refuses a module that needs a newer framework', async () => {
    await buildApplication({ frameworkVersion: '0.0.1' });

    await expect(planModuleInstall(request(['search']))).rejects.toThrow(
      /needs framework 0\.1\.0 or newer/,
    );
  });

  it('refuses an application generated without an API', async () => {
    await buildApplication({
      generated: { api: false, admin: true, auth: true, deploymentTarget: 'railway' },
    });

    // Modules expose HTTP routes; there would be nowhere to mount them.
    await expect(planModuleInstall(request(['search']))).rejects.toThrow(/without an API/);
  });

  it('refuses a manifest that is not a TrustOS application', async () => {
    await write('trustos.json', JSON.stringify({ name: 'something else' }));

    await expect(planModuleInstall(request(['search']))).rejects.toThrow(
      /not a valid TrustOS application manifest/,
    );
  });

  it('notices that app.module.ts already spreads the module imports', async () => {
    const planned = await planModuleInstall(request(['search']));
    // So the installer does not tell everybody to add a line that is already there.
    expect(planned.appModuleWired).toBe(true);
  });
});

describe('installModules', () => {
  it('writes the module payload, the managed wiring and the merged files', async () => {
    const result = await installModules(request(['file-storage']));

    expect(result.installed).toEqual(['file-storage']);
    expect(existsSync(join(app, 'prisma/schema/20-file-storage.prisma'))).toBe(true);

    const wiring = await read('apps/api/src/modules/trustos-modules.ts');
    expect(wiring).toContain('FileStorageModule');
    expect(wiring).toContain('@trustos/module-file-storage/nest');
    expect(wiring).toContain('file-storage.file.write');

    const manifest = await loadApplicationManifest(app);
    expect(manifest.manifest.modules.map((module) => module.id)).toEqual(['file-storage']);
  });

  it('adds the module packages and the SDK to dependencies, keeping the rest', async () => {
    await installModules(request(['file-storage']));
    const parsed = JSON.parse(await read('package.json')) as {
      name: string;
      dependencies: Record<string, string>;
    };

    expect(parsed.name).toBe('demo');
    expect(parsed.dependencies.zod).toBe('^3.24.1');
    expect(parsed.dependencies['@trustos/module-file-storage']).toMatch(/^file:/);
    // Not a transitive assumption: npm links a `file:` dependency but does not
    // install that package's own unpublished requirements.
    expect(parsed.dependencies['@trustos/module-sdk']).toMatch(/^file:/);
    expect(parsed.dependencies['@trustos/module-registry']).toMatch(/^file:/);
  });

  it('appends environment variable names, never values', async () => {
    await installModules(request(['file-storage']));
    const env = await read('.env.example');

    expect(env).toContain('# >>> trustos module: file-storage');
    expect(env).toContain('FILE_STORAGE_ROOT=');
    // A module cannot contribute a value, so it cannot contribute a secret-shaped
    // default that somebody later fills in and commits.
    expect(env).not.toMatch(/FILE_STORAGE_ROOT=\S/);
    expect(env).toContain('NODE_ENV=development');
  });

  it('is idempotent: installing again reports and skips', async () => {
    await installModules(request(['file-storage']));
    const second = await installModules(request(['file-storage']));

    expect(second.installed).toEqual([]);
    expect(second.alreadyInstalled).toEqual(['file-storage']);

    const manifest = await loadApplicationManifest(app);
    expect(manifest.manifest.modules).toHaveLength(1);
  });

  it('does not duplicate an environment block on reinstall', async () => {
    await installModules(request(['file-storage']));
    await installModules(request(['file-storage']));

    const env = await read('.env.example');
    expect(env.match(/# >>> trustos module: file-storage/g)).toHaveLength(1);
  });

  it('regenerates the wiring from the whole installed set, not by appending', async () => {
    await installModules(request(['file-storage']));
    await installModules(request(['search']));

    const wiring = await read('apps/api/src/modules/trustos-modules.ts');
    expect(wiring).toContain('FileStorageModule');
    expect(wiring).toContain('SearchModule');
    // One import each, so nothing accumulates across runs.
    expect(wiring.match(/FileStorageModule\b/g)?.length).toBe(2);
  });

  it('creates module-config.ts once and never rewrites it', async () => {
    await installModules(request(['file-storage']));

    const edited = `${await read('apps/api/src/modules/module-config.ts')}\n// mine\n`;
    await write('apps/api/src/modules/module-config.ts', edited);

    await installModules(request(['search']));

    // The file a developer owns survives, even though a new module was installed.
    expect(await read('apps/api/src/modules/module-config.ts')).toContain('// mine');
  });

  it('never touches app.module.ts', async () => {
    const before = await read('apps/api/src/app.module.ts');
    await installModules(request(['file-storage', 'search']));

    // The composition root holds the guard order, which is the security model.
    expect(await read('apps/api/src/app.module.ts')).toBe(before);
  });

  it('preserves unknown keys in trustos.json', async () => {
    const withExtra = { ...MANIFEST, futureField: { added: 'by a newer CLI' } };
    await write('trustos.json', `${JSON.stringify(withExtra, null, 2)}\n`);

    await installModules(request(['search']));

    const parsed = JSON.parse(await read('trustos.json')) as Record<string, unknown>;
    expect(parsed.futureField).toEqual({ added: 'by a newer CLI' });
  });

  it('records provenance for each installed module', async () => {
    await installModules(request(['document']));
    const manifest = await loadApplicationManifest(app);

    const document = manifest.manifest.modules.find((module) => module.id === 'document');
    const storage = manifest.manifest.modules.find((module) => module.id === 'file-storage');

    expect(document).toMatchObject({ version: '0.1.0', installedAt: '2026-02-01T00:00:00.000Z' });
    expect(document?.installedAsDependency).toBe(false);
    expect(storage?.installedAsDependency).toBe(true);
  });
});

describe('refusing to overwrite code somebody wrote', () => {
  it('stops when a managed file has lost its marker', async () => {
    // The marker is what says "the installer owns this". Without it the file is
    // treated as hand-written, whatever its path.
    await write(
      'apps/api/src/modules/trustos-modules.ts',
      'export const TRUSTOS_MODULE_IMPORTS = [];\n// hand written\n',
    );

    await expect(installModules(request(['search']))).rejects.toThrow(
      /Refusing to overwrite 1 file\(s\)/,
    );
  });

  it('stops when a module schema fragment was hand-edited', async () => {
    await write('prisma/schema/20-file-storage.prisma', 'model MyOwnThing { id String @id }\n');

    await expect(installModules(request(['file-storage']))).rejects.toThrow(
      /Refusing to overwrite/,
    );
  });

  it('leaves the application untouched when it refuses', async () => {
    await write(
      'apps/api/src/modules/trustos-modules.ts',
      'export const TRUSTOS_MODULE_IMPORTS = [];\n',
    );
    const packageJsonBefore = await read('package.json');

    await installModules(request(['search'])).catch(() => undefined);

    // Refusal happens while planning, before anything is written.
    expect(await read('package.json')).toBe(packageJsonBefore);
    expect(existsSync(join(app, 'apps/api/src/modules/module-config.ts'))).toBe(false);
  });

  it('refuses an application missing a file it has to merge', async () => {
    await rm(join(app, 'package.json'));

    await expect(installModules(request(['search']))).rejects.toThrow(/package.json is missing/);
  });
});

describe('dry run', () => {
  it('reports the plan and writes nothing', async () => {
    const result = await installModules(request(['document']), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.created.length + result.overwritten.length).toBeGreaterThan(0);

    // The identical code path, stopped before the write.
    expect(existsSync(join(app, 'prisma/schema/22-document.prisma'))).toBe(false);
    expect(existsSync(join(app, 'apps/api/src/modules/module-config.ts'))).toBe(false);
    expect((await loadApplicationManifest(app)).manifest.modules).toEqual([]);
  });
});

describe('determinism', () => {
  it('produces identical output for identical inputs', async () => {
    const first = await planModuleInstall(request(['document', 'search']));

    await rm(app, { recursive: true, force: true });
    app = await mkdtemp(join(tmpdir(), 'trustos-install-'));
    await buildApplication();

    const second = await planModuleInstall(request(['document', 'search']));

    const fingerprint = (files: typeof first.plan.files) =>
      files.map((file) => `${file.path}\n${file.contents}`).join('\n');

    expect(fingerprint(second.plan.files)).toBe(fingerprint(first.plan.files));
  });

  it('sorts the plan, so two runs list files in the same order', async () => {
    const planned = await planModuleInstall(request(['document']));
    const paths = planned.plan.files.map((file) => file.path);

    expect([...paths].sort()).toEqual(paths);
  });
});

describe('resolveApplicationRoot', () => {
  it('walks upward to find the manifest', async () => {
    const nested = join(app, 'apps', 'api', 'src');
    expect(resolveApplicationRoot(nested)).toBe(resolve(app));
  });

  it('says what it was looking for when there is none', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'trustos-empty-'));
    expect(() => resolveApplicationRoot(empty)).toThrowError(/No trustos.json found/);
    await rm(empty, { recursive: true, force: true });
  });
});

describe('mergePackageJson', () => {
  it('sorts dependencies so the file does not churn', () => {
    const merged = mergePackageJson('{"dependencies":{"zod":"^3"}}', {
      '@trustos/module-search': 'file:x',
    });
    const parsed = JSON.parse(merged) as { dependencies: Record<string, string> };

    expect(Object.keys(parsed.dependencies)).toEqual(['@trustos/module-search', 'zod']);
  });

  it('reports invalid JSON rather than replacing the file', () => {
    expect(() => mergePackageJson('{not json', {})).toThrowError(/not valid JSON/);
  });
});

describe('mergeEnvExample', () => {
  it('replaces an existing block rather than appending', async () => {
    const planned = await planModuleInstall(request(['file-storage']));
    const entry = planned.order[0];
    if (!entry) throw new Error('expected one entry');

    const once = mergeEnvExample('NODE_ENV=development\n', [entry]);
    const twice = mergeEnvExample(once, [entry]);

    expect(twice).toBe(once);
  });

  it('leaves everything outside the anchors alone', async () => {
    const planned = await planModuleInstall(request(['file-storage']));
    const entry = planned.order[0];
    if (!entry) throw new Error('expected one entry');

    const merged = mergeEnvExample('# mine\nMY_VAR=\n', [entry]);
    expect(merged).toContain('# mine');
    expect(merged).toContain('MY_VAR=');
  });
});

#!/usr/bin/env node
/**
 * Scaffolds the Phase 10 platform packages.
 *
 * Skeletons only — `package.json`, `tsconfig.json` and a placeholder `index.ts`. The content is
 * hand-written afterwards. This exists so twenty packages get identical build wiring rather than
 * twenty chances to mistype a `tsBuildInfoFile`, and so the project references are derived from
 * the dependency list instead of maintained beside it.
 *
 * It never overwrites a `src/` file that already exists.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The packages, with their framework dependencies.
 *
 * Order matters only for readability; the build resolves the graph itself. What matters is that
 * the dependency list here is the *whole* truth — `tsconfig.json` references are generated from
 * it, so a package importing something it did not declare fails to build.
 */
const PACKAGES = [
  // --- version, compatibility and the dependency graph ---------------------
  {
    name: 'version-manager',
    description:
      'Semantic versioning, ranges, the framework compatibility matrix and upgrade recommendations.',
    deps: ['errors'],
  },
  {
    name: 'compatibility-engine',
    description:
      'Whether a framework version, module, database, CLI, template and API can run together.',
    deps: ['errors', 'version-manager', 'module-registry', 'template-registry'],
  },
  {
    name: 'dependency-analyzer',
    description:
      'Cycles, unused modules, missing dependencies, version conflicts and breaking changes across the module graph.',
    deps: ['errors', 'version-manager', 'module-registry'],
  },

  // --- supply chain --------------------------------------------------------
  {
    name: 'package-manager',
    description:
      'Install, update, rollback, dependency resolution, conflict detection and integrity validation. Offline by design.',
    deps: ['errors', 'version-manager', 'module-registry', 'dependency-analyzer'],
  },
  {
    name: 'module-marketplace',
    description:
      'Browse, search, rate and verify modules from the local signed catalog. No remote fetch.',
    deps: ['errors', 'version-manager', 'module-registry', 'compatibility-engine'],
  },
  {
    name: 'plugin-framework',
    description:
      'Plugin manifests, declared permissions, signature verification and the extension points a plugin may claim.',
    deps: ['errors', 'version-manager'],
  },
  {
    name: 'license-manager',
    description: 'Licence tiers, feature entitlements, validation and expiry.',
    deps: ['errors', 'version-manager'],
  },

  // --- lifecycle -----------------------------------------------------------
  {
    name: 'release-manager',
    description:
      'Release channels, the support lifecycle from development to end-of-life, and release notes.',
    deps: ['errors', 'version-manager'],
  },
  {
    name: 'upgrade-manager',
    description:
      'The upgrade plan: preflight checks, backup, migration steps, validation, rollback and a report.',
    deps: [
      'errors',
      'version-manager',
      'compatibility-engine',
      'dependency-analyzer',
      'release-manager',
      'migration-tools',
    ],
  },
  {
    name: 'migration-tools',
    description:
      'Database, configuration, template, module and framework migrations, with dry run and rollback.',
    deps: ['errors', 'version-manager'],
  },

  // --- quality -------------------------------------------------------------
  {
    name: 'architecture-validator',
    description:
      'Layering, naming, dependency direction, folder structure, domain boundaries and security rules.',
    deps: ['errors'],
  },
  {
    name: 'quality-gates',
    description:
      'The gates a change must clear: architecture, security, performance, docs, tests, coverage, lint, format, OpenAPI, configuration, accessibility.',
    deps: ['errors', 'architecture-validator'],
  },
  {
    name: 'framework-health',
    description: 'Whether the framework itself is healthy, and what is degrading it.',
    deps: ['errors', 'version-manager', 'dependency-analyzer', 'quality-gates'],
  },

  // --- insight -------------------------------------------------------------
  {
    name: 'telemetry',
    description:
      'Local-first usage, performance and error signals. Off unless switched on, and never carrying tenant data.',
    deps: ['errors'],
  },
  {
    name: 'analytics',
    description: 'Summaries over collected telemetry: adoption, popularity, error trends.',
    deps: ['errors', 'telemetry'],
  },
  {
    name: 'platform-manager',
    description:
      'One view of the platform: version, modules, health, licence, dependencies, compatibility and upgrade status.',
    deps: [
      'errors',
      'version-manager',
      'module-registry',
      'template-registry',
      'compatibility-engine',
      'dependency-analyzer',
      'license-manager',
      'release-manager',
      'framework-health',
      'telemetry',
    ],
  },

  // --- generation ----------------------------------------------------------
  {
    name: 'code-generator',
    description:
      'Generates a CRUD slice — model, DTOs, repository, service, controller, tests and documentation — from one declaration.',
    deps: ['errors', 'validation', 'architecture-validator'],
  },
  {
    name: 'documentation-center',
    description:
      'Generates architecture, API, module, CLI and template documentation, the changelog and the dependency graph.',
    deps: [
      'errors',
      'version-manager',
      'module-registry',
      'template-registry',
      'dependency-analyzer',
      'release-manager',
    ],
  },
  {
    name: 'developer-portal',
    description:
      'A self-contained developer site: documentation, API explorer, SDK downloads, marketplace, templates and release notes.',
    deps: [
      'errors',
      'version-manager',
      'module-registry',
      'template-registry',
      'module-marketplace',
      'documentation-center',
      'release-manager',
    ],
  },
];

/** Packages that must exist already. A typo here would silently produce a broken reference. */
const KNOWN = new Set([
  ...PACKAGES.map((entry) => entry.name),
  'errors',
  'validation',
  'module-registry',
  'module-sdk',
  'template-registry',
  'observability',
  'config',
  'logging',
]);

async function main() {
  let created = 0;

  for (const entry of PACKAGES) {
    for (const dependency of entry.deps) {
      if (!KNOWN.has(dependency)) {
        throw new Error(`${entry.name} depends on unknown package "${dependency}".`);
      }
    }

    const directory = join(root, 'packages', entry.name);
    await mkdir(join(directory, 'src'), { recursive: true });

    const dependencies = Object.fromEntries(
      [...entry.deps].sort().map((name) => [`@trustsystem/${name}`, '0.1.0']),
    );

    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name: `@trustsystem/${entry.name}`,
          version: '0.1.0',
          private: true,
          description: entry.description,
          license: 'UNLICENSED',
          main: 'dist/index.js',
          types: 'dist/index.d.ts',
          files: ['dist'],
          scripts: { build: 'tsc -b', clean: 'tsc -b --clean' },
          dependencies: { ...dependencies, zod: '^3.24.1' },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await writeFile(
      join(directory, 'tsconfig.json'),
      `${JSON.stringify(
        {
          extends: '../../tsconfig.base.json',
          compilerOptions: {
            rootDir: 'src',
            outDir: 'dist',
            tsBuildInfoFile: 'dist/.tsbuildinfo',
          },
          include: ['src/**/*.ts'],
          exclude: ['src/**/*.spec.ts', 'dist', 'node_modules'],
          references: [...entry.deps].sort().map((name) => ({ path: `../${name}` })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const indexPath = join(directory, 'src/index.ts');

    if (!existsSync(indexPath)) {
      await writeFile(indexPath, `export {};\n`, 'utf8');
      created += 1;
    }

    process.stdout.write(`${entry.name.padEnd(24)} ${entry.deps.length} dependency(ies)\n`);
  }

  // Project references on the build root, kept sorted so a diff is readable.
  const buildConfigPath = join(root, 'tsconfig.build.json');
  const buildConfig = JSON.parse(await readFile(buildConfigPath, 'utf8'));

  const paths = new Set(buildConfig.references.map((reference) => reference.path));
  for (const entry of PACKAGES) paths.add(`packages/${entry.name}`);

  buildConfig.references = [...paths].sort().map((path) => ({ path }));
  await writeFile(buildConfigPath, `${JSON.stringify(buildConfig, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `\n${PACKAGES.length} packages scaffolded, ${created} new index files, ` +
      `${buildConfig.references.length} project references.\n`,
  );
}

await main();

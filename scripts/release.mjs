#!/usr/bin/env node
/**
 * Publishes the framework packages so another repository can install them.
 *
 * Dry run by default. Publishing is irreversible in practice — a version, once
 * published, cannot be re-published with different contents — so the default has to
 * be the harmless one.
 *
 *   node scripts/release.mjs                                  # show what would happen
 *   node scripts/release.mjs --registry https://…  --apply    # publish
 *
 * The registry must be named explicitly. Without it npm falls back to
 * registry.npmjs.org, and these packages are UNLICENSED: a mistyped command should
 * fail, not publish proprietary code to the public registry. `publishConfig.access`
 * is `restricted` on every package as a second line of defence, but a flag you have
 * to type is a better one than a field you have to remember.
 *
 * Packages publish in dependency order. npm does not check that a package's
 * dependencies exist when publishing, so a failure halfway through an arbitrary
 * order leaves a registry where some packages are installable and some resolve to
 * dependencies that are not there yet. In dependency order, a partial publish is
 * always a usable prefix.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const registryIndex = args.indexOf('--registry');
const registry = registryIndex === -1 ? null : args[registryIndex + 1];
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : 'latest';

function fail(message, hint) {
  console.error(`\n${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

/** Every publishable package: `packages/*` and `packages/modules/*`, never `apps/*`. */
function collect() {
  const directories = [];

  for (const name of readdirSync(join(root, 'packages'))) {
    if (name === 'modules') {
      for (const module of readdirSync(join(root, 'packages/modules'))) {
        directories.push(join('packages/modules', module));
      }
      continue;
    }
    directories.push(join('packages', name));
  }

  const packages = [];

  for (const directory of directories) {
    const manifestPath = join(root, directory, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private) continue;

    packages.push({
      name: manifest.name,
      version: manifest.version,
      directory,
      main: manifest.main,
      types: manifest.types,
      dependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      }).filter((dependency) => dependency.startsWith('@trustsystem/')),
      trustosRanges: Object.fromEntries(
        Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies }).filter(
          ([dependency]) => dependency.startsWith('@trustsystem/'),
        ),
      ),
    });
  }

  return packages;
}

/**
 * Dependency order, with a cycle reported rather than hung on.
 *
 * A cycle between two published packages is not something to route around: it means
 * neither can be installed without the other already existing.
 */
function ordered(packages) {
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const result = [];
  const state = new Map();

  const visit = (entry, trail) => {
    const seen = state.get(entry.name);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      fail(
        `Dependency cycle: ${[...trail, entry.name].join(' -> ')}`,
        'Neither package can be installed before the other exists. Break the cycle.',
      );
    }

    state.set(entry.name, 'visiting');
    for (const dependency of entry.dependencies) {
      const next = byName.get(dependency);
      // A dependency that is not published here is either external or an app, and
      // `collect` has already refused to include apps.
      if (next) visit(next, [...trail, entry.name]);
    }
    state.set(entry.name, 'done');
    result.push(entry);
  };

  for (const entry of packages) visit(entry, []);
  return result;
}

/**
 * Refuses to publish something that would not work once installed.
 *
 * These are the properties that make the publishable set closed. Each of them is
 * invisible in this repository — npm workspaces resolve every `@trustsystem/*` name
 * locally whether or not it could ever be installed from a registry — and each of
 * them breaks only in the consuming repository, which is the worst place to find out.
 * Run as a gate (`npm run release`), they break here instead.
 */
function verify(packages) {
  const problems = [];
  const publishable = new Set(packages.map((entry) => entry.name));

  for (const entry of packages) {
    for (const field of ['main', 'types']) {
      const relative = entry[field];
      if (!relative) {
        problems.push(`${entry.name}: no "${field}"`);
        continue;
      }
      if (!existsSync(join(root, entry.directory, relative))) {
        problems.push(
          `${entry.name}: "${field}" is ${relative}, which does not exist — run the build`,
        );
      }
    }

    for (const [dependency, range] of Object.entries(entry.trustosRanges)) {
      // A `workspace:` or `file:` specifier resolves here and nowhere else. Published,
      // it is either rejected outright or installs a path that does not exist.
      if (String(range).startsWith('workspace:') || String(range).startsWith('file:')) {
        problems.push(
          `${entry.name}: depends on ${dependency} as "${range}", which cannot resolve from a registry`,
        );
      }

      // Depending on something unpublishable — an app, or a package still private —
      // makes this package uninstallable however well it builds here.
      if (!publishable.has(dependency)) {
        problems.push(
          `${entry.name}: depends on ${dependency}, which is not published (private, or an application)`,
        );
      }
    }
  }

  return problems;
}

const packages = collect();
if (packages.length === 0) fail('No publishable packages found.');

const plan = ordered(packages);
const problems = verify(plan);

console.log(
  `${plan.length} publishable packages, ${packages.length - plan.length} skipped as private.`,
);
console.log(`Registry: ${registry ?? '(none given)'}`);
console.log(`Tag:      ${tag}`);
console.log(apply ? '\nPUBLISHING.\n' : '\nDRY RUN — nothing will be published.\n');

if (problems.length > 0) {
  console.error('Refusing to publish:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\n${problems.length} problem(s). Run \`npm run build:packages\` first.`);
  process.exit(1);
}

if (apply && !registry) {
  fail(
    'Refusing to publish without --registry.',
    'npm would default to registry.npmjs.org, and these packages are UNLICENSED.\n' +
      'Pass the registry explicitly, e.g.\n' +
      '  node scripts/release.mjs --registry https://npm.pkg.github.com --apply',
  );
}

let published = 0;

for (const entry of plan) {
  const label = `${entry.name}@${entry.version}`;

  if (!apply) {
    console.log(`  would publish  ${label}`);
    continue;
  }

  try {
    execFileSync('npm', ['publish', '--registry', registry, '--tag', tag], {
      cwd: join(root, entry.directory),
      stdio: 'pipe',
    });
    published += 1;
    console.log(`  published      ${label}`);
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;

    // Re-publishing an unchanged version is the normal result of re-running a
    // release that partly succeeded, not a failure.
    if (output.includes('cannot publish over') || output.includes('E409')) {
      console.log(`  already there  ${label}`);
      continue;
    }

    console.error(`\nFailed publishing ${label}:\n${output}`);
    console.error(
      `\n${published} package(s) published before this failure. They are in dependency\n` +
        'order, so what is published is installable. Fix the cause and re-run — packages\n' +
        'already published are reported as "already there" rather than failing.',
    );
    process.exit(1);
  }
}

console.log(
  apply
    ? `\nPublished ${published} package(s).`
    : `\nThis was a dry run. Add --registry <url> --apply to publish.`,
);

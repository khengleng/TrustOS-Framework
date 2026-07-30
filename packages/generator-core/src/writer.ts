import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import { GeneratorError } from './errors';
import { isInside } from './paths';
import type { GenerationPlan } from './plan';

/**
 * Applies a plan as a transaction.
 *
 * If any write fails, everything this run created is removed. The alternative —
 * leaving a half-written project behind — is worse than failing, because the
 * user cannot tell which files are real and the obvious recovery (re-run) hits
 * "directory not empty".
 *
 * Rollback only ever deletes paths this run created, tracked as they are
 * created, and each one is re-checked for containment before removal. A
 * generator that deletes is more dangerous than one that writes, so the
 * deletion path is the more paranoid of the two.
 */

export interface ApplyOptions {
  /** Compute and report, write nothing. */
  dryRun?: boolean;
  /** Overwrite files that already exist. */
  force?: boolean;
  /** Called per file; the CLI wires this to `--verbose`. */
  onFile?: (event: { path: string; action: 'created' | 'overwritten' | 'skipped' }) => void;
  onRollback?: (event: { removed: number }) => void;
}

export interface ApplyResult {
  created: string[];
  overwritten: string[];
  skipped: string[];
  dryRun: boolean;
}

export async function applyPlan(
  plan: GenerationPlan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const { dryRun = false, force = false, onFile } = options;

  const result: ApplyResult = { created: [], overwritten: [], skipped: [], dryRun };

  // Everything this run brings into existence, newest last, so rollback can
  // unwind in reverse and remove directories only after their contents.
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];

  // Files this run overwrote, with their previous contents, so a rollback can put
  // them back. Phase 2 only removed what it created, which was enough for
  // generating a new project into an empty directory; installing a module writes
  // into an existing one, where losing the previous contents of a file would be
  // the worst possible outcome of a failed run.
  const overwritten = new Map<string, string>();

  if (!force) {
    const conflicts = plan.files.filter((file) => file.exists && !file.managed);
    if (conflicts.length > 0) {
      throw new GeneratorError(
        'target_not_empty',
        `${conflicts.length} file(s) already exist, starting with "${conflicts[0]?.path}".`,
        'Re-run with --force to overwrite, or choose an empty directory.',
      );
    }
  }

  if (dryRun) {
    for (const file of plan.files) {
      const action = file.exists ? 'overwritten' : 'created';
      result[file.exists ? 'overwritten' : 'created'].push(file.path);
      onFile?.({ path: file.path, action });
    }
    return result;
  }

  try {
    for (const file of plan.files) {
      const directory = dirname(file.absolutePath);
      for (const created of await ensureDirectory(directory, plan.projectRoot)) {
        createdDirectories.push(created);
      }

      const existed = existsSync(file.absolutePath);
      if (existed && !overwritten.has(file.absolutePath)) {
        overwritten.set(file.absolutePath, await readFile(file.absolutePath, 'utf8'));
      }

      await writeFile(file.absolutePath, file.contents, { encoding: 'utf8' });

      if (!existed) createdFiles.push(file.absolutePath);
      result[existed ? 'overwritten' : 'created'].push(file.path);
      onFile?.({ path: file.path, action: existed ? 'overwritten' : 'created' });
    }
  } catch (error) {
    const removed = await rollback(createdFiles, createdDirectories, overwritten, plan.projectRoot);
    options.onRollback?.({ removed });

    if (error instanceof GeneratorError) throw error;
    throw new GeneratorError(
      'write_failed',
      `Generation failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}

/**
 * Creates `directory` and any missing parents inside `root`, returning the
 * ones that did not previously exist so they can be rolled back.
 */
async function ensureDirectory(directory: string, root: string): Promise<string[]> {
  if (!isInside(root, directory)) {
    throw new GeneratorError(
      'unsafe_path',
      `Refusing to create a directory outside the project: ${directory}`,
    );
  }

  const missing: string[] = [];
  let current = directory;

  // Walk up to the first existing ancestor, recording what has to be created.
  while (!existsSync(current) && isInside(root, current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (missing.length > 0) await mkdir(directory, { recursive: true });
  return missing;
}

/**
 * Removes what this run created.
 *
 * Failures here are collected rather than thrown: a rollback that stops at the
 * first error leaves more mess than one that keeps going.
 */
async function rollback(
  files: string[],
  directories: string[],
  overwritten: Map<string, string>,
  root: string,
): Promise<number> {
  let removed = 0;

  // Restore before removing: a file that was overwritten was not created by this
  // run, so it must be put back rather than deleted.
  for (const [path, previous] of overwritten) {
    if (!isInside(root, path)) continue;
    try {
      await writeFile(path, previous, { encoding: 'utf8' });
    } catch {
      // Keep unwinding; a partial rollback beats an aborted one.
    }
  }

  for (const file of [...files].reverse()) {
    if (!isInside(root, file)) continue;
    try {
      await rm(file, { force: true });
      removed += 1;
    } catch {
      // Keep unwinding; a partial rollback beats an aborted one.
    }
  }

  // Deepest first, so a directory is only removed once emptied.
  const deepestFirst = [...directories].sort((a, b) => depthOf(root, b) - depthOf(root, a));

  for (const directory of deepestFirst) {
    if (!isInside(root, directory)) continue;
    try {
      // `rmdir`, not `rm`: it fails when the directory is non-empty, which is
      // exactly the behaviour wanted. Anything the generator did not create is
      // left alone. (`rm` without `recursive` throws on any directory, so it
      // would silently roll back nothing.)
      await rmdir(directory);
      removed += 1;
    } catch {
      // Not empty, or already gone.
    }
  }

  return removed;
}

function depthOf(root: string, path: string): number {
  return relative(root, path).split(sep).filter(Boolean).length;
}

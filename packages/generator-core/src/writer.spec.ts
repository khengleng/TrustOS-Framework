import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlan } from './writer';
import type { GenerationPlan, PlannedFile } from './plan';
import type { GeneratorError } from './errors';

/**
 * Transactional write tests.
 *
 * The property under test: a failed run leaves nothing behind. Half a generated
 * project is worse than none, because the user cannot tell which files are real
 * and the obvious recovery — re-run — hits "directory not empty".
 */

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'trustos-writer-'));
});

afterEach(async () => {
  // Restore permissions first, or the cleanup itself fails.
  await chmod(workspace, 0o755).catch(() => undefined);
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

function file(path: string, contents = 'content\n', exists = false): PlannedFile {
  return {
    path,
    absolutePath: join(workspace, 'project', path),
    contents,
    rendered: false,
    exists,
    source: 'test',
  };
}

function plan(files: PlannedFile[]): GenerationPlan {
  return { projectRoot: join(workspace, 'project'), files, overrides: [] };
}

describe('applyPlan', () => {
  it('creates files and their parent directories', async () => {
    const result = await applyPlan(plan([file('a.txt'), file('deep/nested/b.txt')]));

    expect(result.created).toEqual(['a.txt', 'deep/nested/b.txt']);
    expect(await readFile(join(workspace, 'project', 'deep/nested/b.txt'), 'utf8')).toBe(
      'content\n',
    );
  });

  it('writes nothing in dry-run mode', async () => {
    const result = await applyPlan(plan([file('a.txt')]), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.created).toEqual(['a.txt']);
    expect(existsSync(join(workspace, 'project'))).toBe(false);
  });

  it('refuses to overwrite without force, and names the first conflict', async () => {
    await mkdir(join(workspace, 'project'), { recursive: true });
    await writeFile(join(workspace, 'project', 'a.txt'), 'original');

    try {
      await applyPlan(plan([file('a.txt', 'new', true)]));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GeneratorError).code).toBe('target_not_empty');
      expect((error as Error).message).toContain('a.txt');
      expect((error as GeneratorError).hint).toContain('--force');
    }

    expect(await readFile(join(workspace, 'project', 'a.txt'), 'utf8')).toBe('original');
  });

  it('overwrites with force, reporting which files were replaced', async () => {
    await mkdir(join(workspace, 'project'), { recursive: true });
    await writeFile(join(workspace, 'project', 'a.txt'), 'original');

    const result = await applyPlan(plan([file('a.txt', 'replaced\n', true)]), { force: true });

    expect(result.overwritten).toEqual(['a.txt']);
    expect(await readFile(join(workspace, 'project', 'a.txt'), 'utf8')).toBe('replaced\n');
  });

  it('rolls back every file and directory it created when a write fails', async () => {
    // A path whose parent is a *file* cannot be created, so this write fails
    // partway through the plan.
    const failing = file('blocker/child.txt');
    const files = [file('first.txt'), file('nested/second.txt'), failing];

    await mkdir(join(workspace, 'project'), { recursive: true });
    await writeFile(join(workspace, 'project', 'blocker'), 'I am a file, not a directory');

    let rolledBack = 0;
    await expect(
      applyPlan(plan(files), { onRollback: (event) => void (rolledBack = event.removed) }),
    ).rejects.toThrow();

    // Everything this run created is gone.
    expect(existsSync(join(workspace, 'project', 'first.txt'))).toBe(false);
    expect(existsSync(join(workspace, 'project', 'nested'))).toBe(false);
    expect(rolledBack).toBeGreaterThan(0);

    // The pre-existing file is untouched: rollback only removes what this run
    // created.
    expect(await readFile(join(workspace, 'project', 'blocker'), 'utf8')).toBe(
      'I am a file, not a directory',
    );
  });

  it('leaves a pre-existing file alone when a later write fails', async () => {
    await mkdir(join(workspace, 'project'), { recursive: true });
    await writeFile(join(workspace, 'project', 'keep.txt'), 'keep me');
    await writeFile(join(workspace, 'project', 'blocker'), 'file');

    await expect(
      applyPlan(plan([file('new.txt'), file('blocker/child.txt')]), { force: true }),
    ).rejects.toThrow();

    expect(await readFile(join(workspace, 'project', 'keep.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(workspace, 'project', 'new.txt'))).toBe(false);
  });

  it('does not delete a directory that already contained something', async () => {
    await mkdir(join(workspace, 'project', 'shared'), { recursive: true });
    await writeFile(join(workspace, 'project', 'shared', 'theirs.txt'), 'not ours');
    await writeFile(join(workspace, 'project', 'blocker'), 'file');

    await expect(
      applyPlan(plan([file('shared/ours.txt'), file('blocker/child.txt')])),
    ).rejects.toThrow();

    // Our file is gone; theirs, and the directory, survive.
    expect(existsSync(join(workspace, 'project', 'shared', 'ours.txt'))).toBe(false);
    expect(await readFile(join(workspace, 'project', 'shared', 'theirs.txt'), 'utf8')).toBe(
      'not ours',
    );
  });

  it('reports write_failed rather than leaking a filesystem error shape', async () => {
    await mkdir(join(workspace, 'project'), { recursive: true });
    await writeFile(join(workspace, 'project', 'blocker'), 'file');

    try {
      await applyPlan(plan([file('blocker/child.txt')]));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as GeneratorError).code).toBe('write_failed');
      expect((error as Error).message).toContain('rolled back');
    }
  });

  it('refuses a plan whose file resolves outside the project root', async () => {
    const escaping: PlannedFile = {
      path: 'escape.txt',
      // A plan is normally built by buildPlan, which contains every path. This
      // asserts the writer does not trust its input either.
      absolutePath: join(workspace, 'outside.txt'),
      contents: 'x',
      rendered: false,
      exists: false,
      source: 'test',
    };

    await expect(applyPlan(plan([escaping]))).rejects.toThrow(/outside the project/);
    expect(existsSync(join(workspace, 'outside.txt'))).toBe(false);
  });
});

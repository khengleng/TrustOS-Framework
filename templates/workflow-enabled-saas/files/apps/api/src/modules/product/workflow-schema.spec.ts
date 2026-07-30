import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The copied workflow schema must match the framework's.
 *
 * Prisma has no cross-package schema import, so a generated application carries its own copy
 * of the framework models. A copy drifts, and this one drifts *silently*: a client generated
 * from a stale schema simply does not know a column, and the first symptom is a runtime error
 * in a workflow transition rather than a failure at build time.
 *
 * That is not hypothetical — the framework's own `00-framework.prisma` copy fell behind
 * between phases and nothing noticed.
 *
 * The test is skipped when the framework checkout is not resolvable, because a generated
 * application installed from npm has no framework sources to compare against. It runs in CI
 * and in a `--framework-path` development setup, which is where an upgrade happens.
 */

const FRAGMENT = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'prisma',
  'schema',
  '05-workflow.prisma',
);

/** Locates the framework's schema, if this project was generated from a checkout. */
function frameworkSchema(): string | null {
  for (const candidate of [
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      '@trustos',
      'database',
      'prisma',
      'schema.prisma',
    ),
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      '@trustos',
      'database',
      'prisma',
      'schema.prisma',
    ),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Normalises whitespace, so a reformatting run is not reported as drift. */
function models(schema: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = match;
    if (!name || !body) continue;

    const normalised = body
      .split('\n')
      .map((line) => line.trim())
      // Comments are documentation, not schema. A wording change is not drift.
      .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('///'))
      .join('\n');

    found.set(name, normalised);
  }

  return found;
}

describe('the copied workflow schema', () => {
  it('exists', () => {
    expect(existsSync(FRAGMENT)).toBe(true);
  });

  it('declares every workflow model the engine writes to', () => {
    const copied = models(readFileSync(FRAGMENT, 'utf8'));

    // The engine's stores name these tables. A missing one is a runtime error on the first
    // transition, not a build failure — which is why this list is spelled out rather than
    // counted.
    for (const model of [
      'WorkflowDefinition',
      'WorkflowVersion',
      'WorkflowInstance',
      'WorkflowTask',
      'WorkflowDecision',
      'WorkflowEvent',
      'WorkflowComment',
      'WorkflowCommentAmendment',
      'WorkflowAttachment',
      'WorkflowSla',
      'WorkflowEscalation',
      'CaseRecord',
      'WorkflowIdempotencyRecord',
      'WorkflowAssignmentCursor',
    ]) {
      expect([...copied.keys()], model).toContain(model);
    }
  });

  it('matches the framework definition of every model it copies', () => {
    const source = frameworkSchema();

    if (!source) {
      // Installed from npm, so there is nothing to compare against. Reported rather than
      // silently passing.
      expect(source, 'framework schema not resolvable — comparison skipped').toBe(null);
      return;
    }

    const copied = models(readFileSync(FRAGMENT, 'utf8'));
    const framework = models(readFileSync(source, 'utf8'));

    const drifted: string[] = [];
    for (const [name, body] of copied) {
      const original = framework.get(name);
      if (original === undefined) {
        drifted.push(`${name}: no longer exists in the framework schema`);
      } else if (original !== body) {
        drifted.push(`${name}: differs from the framework definition`);
      }
    }

    expect(
      drifted,
      `Copied workflow models have drifted from @trustos/database:\n  ${drifted.join('\n  ')}\n\n` +
        'Re-copy the phase-5 section of the framework schema into ' +
        'prisma/schema/05-workflow.prisma.',
    ).toEqual([]);
  });
});

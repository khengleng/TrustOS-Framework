import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANGE_REQUEST_APPROVAL, SIMPLE_APPROVAL } from '@trustsystem/workflow-definition';
import { createCapturingOutput } from '../output';
import { runWorkflowList, runWorkflowSimulate, runWorkflowValidate } from './workflow';

/**
 * CLI workflow tests.
 *
 * The exit code is the contract. These commands are meant to be used in a CI step and a
 * pre-commit hook, where nobody reads the output — so every assertion here checks the code
 * as well as the message.
 */

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'trustos-workflow-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function write(name: string, document: unknown): Promise<string> {
  const path = join(workspace, name);
  await writeFile(path, JSON.stringify(document, null, 2), 'utf8');
  return path;
}

describe('trustos workflow validate', () => {
  it('accepts the framework’s own examples', async () => {
    for (const document of [CHANGE_REQUEST_APPROVAL, SIMPLE_APPROVAL]) {
      const output = createCapturingOutput();
      const path = await write(`${document.id}.json`, document);

      expect(await runWorkflowValidate(path, {}, output), document.id).toBe(0);
      expect(output.lines.join('\n')).toContain('valid');
    }
  });

  it('exits non-zero on a structurally invalid definition', async () => {
    const broken = structuredClone(SIMPLE_APPROVAL);
    broken.initialState = 'nonexistent';
    const path = await write('broken.json', broken);
    const output = createCapturingOutput();

    // Non-zero, so this is usable in CI without parsing output.
    expect(await runWorkflowValidate(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('missing_initial_state');
  });

  it('exits zero with warnings, because a warning does not block', async () => {
    const withSelfApproval = structuredClone(SIMPLE_APPROVAL);
    withSelfApproval.steps.find(
      (step) => step.state === 'pending_approval',
    )!.approval!.allowSelfApproval = true;
    const path = await write('warn.json', withSelfApproval);
    const output = createCapturingOutput();

    // A validator that refused everything questionable would be one whose output people
    // learn to bypass, and the bypass would take the errors with it.
    expect(await runWorkflowValidate(path, {}, output)).toBe(0);
    expect(output.lines.join('\n')).toContain('self_approval_permitted');
    expect(output.lines.join('\n')).toContain('warning(s)');
  });

  it('does not check permissions by default, and says so', async () => {
    const path = await write('simple.json', SIMPLE_APPROVAL);
    const output = createCapturingOutput();

    // A definition on disk may be written for an application whose product permissions this
    // CLI knows nothing about. Checking by default would report false errors on every real
    // definition.
    await runWorkflowValidate(path, {}, output);
    expect(output.lines.join('\n')).toContain('permissions_unchecked');
  });

  it('checks permissions against the framework catalog on request', async () => {
    const path = await write('simple.json', SIMPLE_APPROVAL);
    const output = createCapturingOutput();

    expect(await runWorkflowValidate(path, { strictPermissions: true }, output)).toBe(0);
    expect(output.lines.join('\n')).not.toContain('permissions_unchecked');
  });

  it('rejects a misspelled permission under --strict-permissions', async () => {
    const typo = structuredClone(SIMPLE_APPROVAL);
    typo.steps.find(
      (step) => step.state === 'pending_approval',
    )!.approval!.approvers[0]!.permission = 'workflow.approval.decid';
    const path = await write('typo.json', typo);
    const output = createCapturingOutput();

    // A misspelled approver permission is a step nobody can ever act on.
    expect(await runWorkflowValidate(path, { strictPermissions: true }, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('unknown_permission');
  });

  it('accepts a product’s own permissions when they are declared', async () => {
    const product = structuredClone(SIMPLE_APPROVAL);
    product.steps.find(
      (step) => step.state === 'pending_approval',
    )!.approval!.approvers[0]!.permission = 'payments.release';
    const path = await write('product.json', product);
    const output = createCapturingOutput();

    expect(
      await runWorkflowValidate(
        path,
        { strictPermissions: true, permissions: 'payments.release, payments.read' },
        output,
      ),
    ).toBe(0);
  });

  it('refuses a YAML file with an actionable message', async () => {
    const path = join(workspace, 'definition.yaml');
    await writeFile(path, 'id: x\n', 'utf8');
    const output = createCapturingOutput();

    // Adding a YAML parser to the CLI means a parser reachable from a file path, and the
    // common ones have both had deserialization vulnerabilities.
    expect(await runWorkflowValidate(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('convert it first');
  });

  it('reports a JSON syntax error with its position', async () => {
    const path = join(workspace, 'bad.json');
    await writeFile(path, '{ "id": "x",, }', 'utf8');
    const output = createCapturingOutput();

    expect(await runWorkflowValidate(path, {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('not valid JSON');
  });

  it('reports a missing file rather than throwing', async () => {
    const output = createCapturingOutput();
    expect(await runWorkflowValidate(join(workspace, 'nope.json'), {}, output)).toBe(1);
    expect(output.lines.join('\n')).toContain('Cannot read');
  });

  it('emits machine-readable output on request', async () => {
    const path = await write('simple.json', SIMPLE_APPROVAL);
    const output = createCapturingOutput();

    await runWorkflowValidate(path, { json: true }, output);
    const parsed = JSON.parse(output.lines.join('\n')) as {
      valid: boolean;
      definition: { id: string };
      findings: unknown[];
    };

    expect(parsed.valid).toBe(true);
    expect(parsed.definition.id).toBe('simple-approval');
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});

describe('trustos workflow simulate', () => {
  it('exits zero on a correct definition', async () => {
    const path = await write('change.json', CHANGE_REQUEST_APPROVAL);
    const output = createCapturingOutput();

    expect(await runWorkflowSimulate(path, {}, output)).toBe(0);
    expect(output.lines.join('\n')).toContain('Paths:');
  });

  it('does not flag a cancellation path as an unreviewed approval', async () => {
    const path = await write('change.json', CHANGE_REQUEST_APPROVAL);
    const output = createCapturingOutput();

    /*
     * The change-request example has four cancellation paths, all reaching a final state
     * with no approval — correctly, because a cancellation is a withdrawal rather than a
     * decision.
     *
     * An earlier version counted them and reported three findings on the framework's own
     * example. A check that fires on correct definitions is one people learn to ignore,
     * and the ignoring takes the real findings with it.
     */
    expect(await runWorkflowSimulate(path, {}, output)).toBe(0);
    expect(output.lines.join('\n')).not.toContain('SUCCESS outcome with NO approval');
  });

  it('exits non-zero on a path that reaches approval with no review', async () => {
    const shortcut = structuredClone(CHANGE_REQUEST_APPROVAL);
    shortcut.transitions.push({
      action: 'fast_track',
      from: 'draft',
      to: 'approved',
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    });
    const path = await write('shortcut.json', shortcut);
    const output = createCapturingOutput();

    // The one finding a reviewer cannot get from reading a forty-state document, and almost
    // always a shortcut added for testing and left in.
    expect(await runWorkflowSimulate(path, {}, output)).toBe(1);
    const text = output.lines.join('\n');
    expect(text).toContain('SUCCESS outcome with NO approval');
    expect(text).toContain('draft -> approved');
  });

  it('exits non-zero on a dead end', async () => {
    const dead = structuredClone(SIMPLE_APPROVAL);
    dead.states.push('limbo');
    dead.transitions.push({
      action: 'park',
      from: 'draft',
      to: 'limbo',
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    });
    const path = await write('dead.json', dead);
    const output = createCapturingOutput();

    expect(await runWorkflowSimulate(path, {}, output)).toBe(1);
  });

  it('reports separation-of-duty concerns a schema cannot see', async () => {
    const path = await write('change.json', CHANGE_REQUEST_APPROVAL);
    const output = createCapturingOutput();

    await runWorkflowSimulate(path, {}, output);
    // The same permission approving at two steps is two signatures from one population.
    expect(output.lines.join('\n')).toContain('Separation-of-duty concerns');
  });

  it('reports SLA exposure and flags any with no escalation', async () => {
    const unescalated = structuredClone(SIMPLE_APPROVAL);
    unescalated.steps.find((step) => step.state === 'pending_approval')!.escalations = [];
    const path = await write('unescalated.json', unescalated);
    const output = createCapturingOutput();

    await runWorkflowSimulate(path, {}, output);
    // A deadline nobody is told about: the clock runs, a status turns red, and nothing
    // happens.
    expect(output.lines.join('\n')).toContain('NO escalation configured');
  });

  it('emits machine-readable output on request', async () => {
    const path = await write('change.json', CHANGE_REQUEST_APPROVAL);
    const output = createCapturingOutput();

    await runWorkflowSimulate(path, { json: true }, output);
    const parsed = JSON.parse(output.lines.join('\n')) as { paths: unknown[]; valid: boolean };

    expect(parsed.valid).toBe(true);
    expect(parsed.paths.length).toBeGreaterThan(3);
  });
});

describe('trustos workflow list', () => {
  it('lists the framework’s examples', () => {
    const output = createCapturingOutput();
    expect(runWorkflowList({}, output)).toBe(0);

    const text = output.lines.join('\n');
    expect(text).toContain('change-request-approval');
    expect(text).toContain('simple-approval');
  });

  it('says these are the framework’s, not an application’s', () => {
    const output = createCapturingOutput();
    runWorkflowList({}, output);

    // A CLI that read a production database would need production credentials, and a CLI
    // that holds production credentials is a laptop that holds them.
    expect(output.lines.join('\n')).toContain('administration portal');
  });

  it('emits machine-readable output on request', () => {
    const output = createCapturingOutput();
    runWorkflowList({ json: true }, output);

    const parsed = JSON.parse(output.lines.join('\n')) as Array<{ id: string; valid: boolean }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.every((entry) => entry.valid)).toBe(true);
  });
});

import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  EXAMPLE_DEFINITIONS,
  formatFindings,
  formatSimulation,
  simulateDefinition,
  validateDefinition,
  type ValidateOptions,
  type ValidationFinding,
} from '@trustsystem/workflow-definition';
import { ALL_WORKFLOW_PERMISSION_KEYS } from '@trustsystem/workflow-core';
import { ALL_PERMISSION_KEYS } from '@trustsystem/rbac';
import { style, type Output } from '../output';

/**
 * `trustos workflow validate|simulate|list`.
 *
 * All three are **read-only and offline**. They parse a file, walk a graph and print. No
 * database, no network, no instance created, no notification sent — which is the point:
 * these are the commands somebody runs at the moment they are deciding whether to publish,
 * and a tool that needed a running application would not be run then.
 *
 * `validate` is the gate; `simulate` is the explanation. A reviewer needs both, because a
 * definition can be structurally valid and still have a path to "approved" that skips
 * every review — which `validate` cannot see and `simulate` reports first.
 */

export interface WorkflowCommandOptions {
  json?: boolean;
  /** Check permission references against the framework catalog. Off by default. */
  strictPermissions?: boolean;
  /** Extra permission keys a product defines, comma-separated. */
  permissions?: string;
  quiet?: boolean;
}

/**
 * Reads a definition from a file.
 *
 * JSON only. YAML is a natural request and is deliberately not supported here: adding a
 * YAML parser to the CLI means a parser reachable from a file path, and the two most
 * common ones have both had deserialization vulnerabilities. A product that wants YAML can
 * convert it before validating, which keeps the parser in its own dependency tree rather
 * than in the framework's.
 */
async function readDefinition(path: string): Promise<{ document: unknown } | { error: string }> {
  const absolute = resolve(path);

  if (extname(absolute) === '.yaml' || extname(absolute) === '.yml') {
    return {
      error:
        `${path} looks like YAML. The CLI reads JSON only — convert it first (for example with ` +
        '`npx js-yaml file.yaml > file.json`). See docs/workflow-definition-guide.md.',
    };
  }

  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (error) {
    return {
      error: `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    return { document: JSON.parse(raw) as unknown };
  } catch (error) {
    // A JSON syntax error names a position, which is much more useful than "invalid".
    return {
      error: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateOptions(options: WorkflowCommandOptions): ValidateOptions {
  if (!options.strictPermissions && !options.permissions) return {};

  /*
   * The permission catalog.
   *
   * Off by default, and that is a considered choice. A definition file on disk may be
   * written for an application whose product permissions this CLI knows nothing about, so
   * checking by default would report false errors on every real definition — and a tool
   * that cries wolf is one people stop reading.
   *
   * `--strict-permissions` opts in to the framework catalog, and `--permissions` adds a
   * product's own. The validator warns when the check is skipped, so it is never silent.
   */
  const known = [
    ...ALL_PERMISSION_KEYS,
    ...ALL_WORKFLOW_PERMISSION_KEYS,
    ...(options.permissions
      ? options.permissions
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []),
  ];

  return { knownPermissions: [...new Set(known)] };
}

function countBySeverity(findings: ValidationFinding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
  };
}

// --- validate --------------------------------------------------------------

export async function runWorkflowValidate(
  path: string,
  options: WorkflowCommandOptions,
  output: Output,
): Promise<number> {
  const read = await readDefinition(path);

  if ('error' in read) {
    if (options.json) {
      output.info(JSON.stringify({ valid: false, error: read.error }, null, 2));
    } else {
      output.error(read.error);
    }
    return 1;
  }

  const result = validateDefinition(read.document, validateOptions(options));

  if (options.json) {
    output.info(
      JSON.stringify(
        {
          valid: result.valid,
          definition: result.document
            ? { id: result.document.id, version: result.document.version }
            : null,
          findings: result.findings,
        },
        null,
        2,
      ),
    );
    return result.valid ? 0 : 1;
  }

  const { errors, warnings } = countBySeverity(result.findings);
  const label = result.document
    ? `${result.document.name} (${result.document.id} ${result.document.version})`
    : path;

  output.info(style.bold(label));

  if (result.findings.length > 0) {
    output.blank();
    for (const line of formatFindings(result.findings)) {
      // Errors in red, warnings plainly. A warning printed as loudly as an error is a
      // warning people learn to ignore, and the ignoring takes the errors with it.
      if (line.startsWith('error')) output.error(`  ${line}`);
      else output.detail(`  ${line}`);
    }
  }

  output.blank();

  if (result.valid) {
    // `success` rather than `info`, so a green tick appears next to it — the same marker
    // every other passing check in the CLI uses.
    output.success(
      'valid' +
        (warnings > 0
          ? ` — ${warnings} warning(s). Review them before publishing; they do not block.`
          : ''),
    );
    return 0;
  }

  output.error(`invalid — ${errors} error(s)${warnings > 0 ? `, ${warnings} warning(s)` : ''}`);
  // Non-zero, so this is usable in a CI step or a pre-commit hook without parsing output.
  return 1;
}

// --- simulate --------------------------------------------------------------

export async function runWorkflowSimulate(
  path: string,
  options: WorkflowCommandOptions,
  output: Output,
): Promise<number> {
  const read = await readDefinition(path);

  if ('error' in read) {
    if (options.json) {
      output.info(JSON.stringify({ valid: false, error: read.error }, null, 2));
    } else {
      output.error(read.error);
    }
    return 1;
  }

  const result = simulateDefinition(read.document);

  if (options.json) {
    output.info(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }

  for (const line of formatSimulation(result)) {
    output.info(line);
  }

  /*
   * A path to a final state with no approval is reported as a failure, even when the
   * definition is structurally valid.
   *
   * That is the one finding a reviewer cannot get from reading a forty-state document, and
   * it is almost always a mistake — a shortcut transition added for testing and left in.
   * Exiting non-zero puts it in front of somebody rather than in a wall of output they
   * scrolled past.
   */
  const unapprovedFinal = result.unapprovedPaths.filter((entry) => entry.reachesFinalState);

  if (unapprovedFinal.length > 0) {
    output.blank();
    output.error(
      `${unapprovedFinal.length} path(s) reach a final state with no approval at all. ` +
        'Verify this is intended.',
    );
    return 1;
  }

  if (result.deadEnds.length > 0 || result.unreachableStates.length > 0) {
    return 1;
  }

  return result.valid ? 0 : 1;
}

// --- list ------------------------------------------------------------------

export function runWorkflowList(options: WorkflowCommandOptions, output: Output): number {
  const definitions = EXAMPLE_DEFINITIONS.map((document) => {
    const result = validateDefinition(document);
    const simulation = simulateDefinition(document);

    return {
      id: document.id,
      version: document.version,
      name: document.name,
      description: document.description,
      businessObjectType: document.businessObjectType,
      states: document.states.length,
      transitions: document.transitions.length,
      approvalSteps: document.steps.filter((step) => step.approval).length,
      valid: result.valid,
      warnings: result.findings.filter((finding) => finding.severity === 'warning').length,
      paths: simulation.paths.length,
      permissions: simulation.requiredPermissions,
    };
  });

  if (options.json) {
    output.info(JSON.stringify(definitions, null, 2));
    return 0;
  }

  output.info(
    style.bold(`Workflow definitions shipped with the framework (${definitions.length})`),
  );
  output.blank();

  for (const entry of definitions) {
    output.info(`${style.cyan(entry.id)}  ${entry.name}  v${entry.version}`);
    output.detail(`  ${entry.description}`);
    output.detail(
      `  governs ${entry.businessObjectType} · ${entry.states} states · ` +
        `${entry.transitions} transitions · ${entry.approvalSteps} approval step(s) · ` +
        `${entry.paths} path(s)`,
    );
    output.detail(`  permissions: ${entry.permissions.join(', ')}`);
    output.blank();
  }

  /*
   * These are the framework's examples, not an application's.
   *
   * An installed application's own definitions live in its database and are listed by its
   * administration portal. The CLI has no database connection and should not grow one — a
   * command that read a production database would need credentials, and a CLI that holds
   * production credentials is a laptop that holds production credentials.
   */
  output.detail(
    'These are the framework’s example definitions. An application’s own definitions live in ' +
      'its database — list them from its administration portal, not from the CLI.',
  );

  return 0;
}

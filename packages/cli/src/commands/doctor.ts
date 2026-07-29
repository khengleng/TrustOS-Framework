import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { compareSemver } from '@trustos/template-registry';
import { readFrameworkVersion, resolveTemplatesRoot } from '@trustos/generator-core';

const execFileAsync = promisify(execFile);

/**
 * Environment diagnostics.
 *
 * Two rules shape this command:
 *
 *   * A missing **optional** tool is a WARN, never a FAIL. `trustos doctor`
 *     exiting non-zero because someone has no Railway CLI would train people
 *     to ignore it, and then it stops catching the real problems.
 *   * Every check says what to do about it. A diagnostic that reports a
 *     problem without a remedy has only moved the work.
 */

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  remedy?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True when nothing FAILed. WARNs do not make the report unhealthy. */
  ok: boolean;
}

/** Minimum Node the framework and generated applications require. */
export const REQUIRED_NODE_VERSION = '20.11.0';
export const REQUIRED_NPM_VERSION = '10.0.0';

export interface DoctorDependencies {
  nodeVersion?: string;
  /** Runs a command and returns stdout, or null when the tool is absent. */
  probe?: (command: string, args: string[]) => Promise<string | null>;
  cwd?: string;
  templatesRoot?: string | null;
}

/** Runs `command`, returning trimmed stdout or null if it is not installed. */
async function defaultProbe(command: string, args: string[]): Promise<string | null> {
  try {
    // execFile, never a shell: arguments are passed as an array so nothing the
    // user typed can be interpreted as shell syntax.
    const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function runDoctor(dependencies: DoctorDependencies = {}): Promise<DoctorReport> {
  const probe = dependencies.probe ?? defaultProbe;
  const cwd = dependencies.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  // --- Node -----------------------------------------------------------------
  const nodeVersion = (dependencies.nodeVersion ?? process.versions.node).replace(/^v/, '');
  checks.push(
    compareSemver(nodeVersion, REQUIRED_NODE_VERSION) >= 0
      ? { name: 'Node.js', status: 'PASS', detail: `v${nodeVersion}` }
      : {
          name: 'Node.js',
          status: 'FAIL',
          detail: `v${nodeVersion} is older than the required v${REQUIRED_NODE_VERSION}`,
          remedy: `Install Node ${REQUIRED_NODE_VERSION}+ (nvm install ${REQUIRED_NODE_VERSION}).`,
        },
  );

  // --- npm ------------------------------------------------------------------
  const npmVersion = await probe('npm', ['--version']);
  if (!npmVersion) {
    checks.push({
      name: 'npm',
      status: 'FAIL',
      detail: 'not found',
      remedy: 'npm ships with Node.js; reinstall Node.',
    });
  } else {
    checks.push(
      compareSemver(npmVersion, REQUIRED_NPM_VERSION) >= 0
        ? { name: 'npm', status: 'PASS', detail: `v${npmVersion}` }
        : {
            name: 'npm',
            status: 'FAIL',
            detail: `v${npmVersion} is older than the required v${REQUIRED_NPM_VERSION}`,
            remedy: 'npm install -g npm@latest',
          },
    );
  }

  // --- Git (required for --git, optional otherwise) -------------------------
  const gitVersion = await probe('git', ['--version']);
  checks.push(
    gitVersion
      ? { name: 'Git', status: 'PASS', detail: gitVersion }
      : {
          name: 'Git',
          status: 'WARN',
          detail: 'not found',
          remedy: 'Install Git, or generate with --no-git.',
        },
  );

  // --- PostgreSQL client (optional) ----------------------------------------
  const psqlVersion = await probe('psql', ['--version']);
  checks.push(
    psqlVersion
      ? { name: 'PostgreSQL client', status: 'PASS', detail: psqlVersion }
      : {
          name: 'PostgreSQL client',
          status: 'WARN',
          detail: 'psql not found (optional)',
          remedy: 'Only needed to inspect a database locally; generation does not use it.',
        },
  );

  // --- Railway CLI (optional) ----------------------------------------------
  const railwayVersion = await probe('railway', ['--version']);
  checks.push(
    railwayVersion
      ? { name: 'Railway CLI', status: 'PASS', detail: railwayVersion }
      : {
          name: 'Railway CLI',
          status: 'WARN',
          detail: 'not found (optional)',
          remedy: 'npm i -g @railway/cli — only needed to deploy.',
        },
  );

  // --- Framework compatibility ---------------------------------------------
  let templatesRoot: string | null = dependencies.templatesRoot ?? null;
  if (templatesRoot === null && dependencies.templatesRoot === undefined) {
    try {
      templatesRoot = resolveTemplatesRoot();
    } catch {
      templatesRoot = null;
    }
  }

  if (!templatesRoot) {
    checks.push({
      name: 'Framework packages',
      status: 'FAIL',
      detail: 'templates directory not found',
      remedy: 'Run trustos from a framework checkout, or pass --templates-root.',
    });
  } else {
    const frameworkVersion = await readFrameworkVersion(templatesRoot);
    checks.push({
      name: 'Framework packages',
      status: 'PASS',
      detail: `TrustOS framework v${frameworkVersion} at ${templatesRoot}`,
    });
  }

  // --- Working directory ----------------------------------------------------
  checks.push(checkWritable(cwd));

  return { checks, ok: checks.every((check) => check.status !== 'FAIL') };
}

function checkWritable(directory: string): DoctorCheck {
  try {
    accessSync(directory, constants.W_OK);
    return { name: 'Working directory', status: 'PASS', detail: `${directory} is writable` };
  } catch {
    return {
      name: 'Working directory',
      status: 'FAIL',
      detail: `${directory} is not writable`,
      remedy: 'Change into a directory you own, or fix its permissions.',
    };
  }
}

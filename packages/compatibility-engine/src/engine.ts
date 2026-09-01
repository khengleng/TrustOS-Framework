import {
  CompatibilityMatrix,
  compareVersions,
  isBreakingChange,
  type CompatibilitySubject,
  type CompatibilityVerdict,
} from '@trustsystem/version-manager';

/**
 * The compatibility engine.
 *
 * Six surfaces have to agree before a deployment works: the framework, its modules, the database,
 * the CLI, the templates a project was generated from, and the API contract its clients depend
 * on. Each is checked somewhere in the framework already — this is the one place that checks them
 * *together* and reports one verdict.
 *
 * Why that matters: every real upgrade failure this exists to prevent is a pair, not a single
 * thing. The framework moved and the module did not. The schema migrated and the CLI that reads
 * it did not. A template generated against 0.1 and the API it calls is at 0.4. Checking each
 * surface alone finds none of those, because each one is individually fine.
 *
 * The engine never repairs anything and never guesses. It reports, with a reason per finding, and
 * something above it decides.
 */

export type Severity = 'ok' | 'info' | 'warning' | 'error';

export interface CompatibilityFinding {
  surface: CompatibilitySubject;
  /** What was checked: a module id, `postgresql`, `cli`. */
  id: string;
  severity: Severity;
  verdict: CompatibilityVerdict;
  detail: string;
  remediation?: string;
}

export interface CompatibilityReport {
  frameworkVersion: string;
  findings: CompatibilityFinding[];
  /** False when anything is an error. Warnings do not block. */
  ok: boolean;
  /** True when anything came back `unknown`, so a caller can decide how strict to be. */
  hasUnknowns: boolean;
}

export interface ModuleUnderTest {
  id: string;
  version: string;
  /** The framework range the module declares. */
  minimumFrameworkVersion: string;
}

export interface TemplateUnderTest {
  id: string;
  version: string;
  minimumFrameworkVersion: string;
}

export interface CompatibilityInput {
  frameworkVersion: string;
  modules?: readonly ModuleUnderTest[];
  templates?: readonly TemplateUnderTest[];
  /** The CLI actually installed. A CLI older than the framework reads schemas it does not know. */
  cliVersion?: string;
  /** Engine and server version, e.g. `{ engine: 'postgresql', version: '16.2' }`. */
  database?: { engine: string; version: string };
  /** The API contract version a generated client was built against. */
  apiVersion?: { client: string; server: string };
  matrix?: CompatibilityMatrix;
}

/**
 * Database versions the framework is known to work on.
 *
 * A floor rather than a list of exact versions: PostgreSQL's guarantees within a major are strong
 * enough that pinning a minor would produce a warning on every routine patch upgrade, and a
 * warning that fires constantly is a warning nobody reads.
 */
const DATABASE_FLOORS: Record<string, string> = {
  postgresql: '14.0.0',
};

export function checkCompatibility(input: CompatibilityInput): CompatibilityReport {
  const matrix = input.matrix ?? new CompatibilityMatrix();
  const findings: CompatibilityFinding[] = [];

  for (const module of input.modules ?? []) {
    findings.push(checkModule(module, input.frameworkVersion, matrix));
  }

  for (const template of input.templates ?? []) {
    findings.push(checkTemplate(template, input.frameworkVersion, matrix));
  }

  if (input.cliVersion) findings.push(checkCli(input.cliVersion, input.frameworkVersion));
  if (input.database) findings.push(checkDatabase(input.database));
  if (input.apiVersion) findings.push(checkApi(input.apiVersion));

  return {
    frameworkVersion: input.frameworkVersion,
    findings,
    ok: !findings.some((finding) => finding.severity === 'error'),
    hasUnknowns: findings.some((finding) => finding.verdict === 'unknown'),
  };
}

function checkModule(
  module: ModuleUnderTest,
  frameworkVersion: string,
  matrix: CompatibilityMatrix,
): CompatibilityFinding {
  const recorded = matrix.check('module', module.id, module.version, frameworkVersion);

  if (recorded.verdict === 'incompatible') {
    return {
      surface: 'module',
      id: module.id,
      severity: 'error',
      verdict: 'incompatible',
      detail: `${module.id} ${module.version} is recorded as incompatible with framework ${frameworkVersion}. ${recorded.note}`,
      remediation: `Upgrade ${module.id}, or pin the framework below the version that broke it.`,
    };
  }

  if (compareVersions(frameworkVersion, module.minimumFrameworkVersion) < 0) {
    return {
      surface: 'module',
      id: module.id,
      severity: 'error',
      verdict: 'incompatible',
      detail: `${module.id} ${module.version} needs framework ${module.minimumFrameworkVersion} or newer; this is ${frameworkVersion}.`,
      remediation: 'Upgrade the framework, or install an older version of the module.',
    };
  }

  if (recorded.verdict === 'compatible') {
    return {
      surface: 'module',
      id: module.id,
      severity: 'ok',
      verdict: 'compatible',
      detail: `${module.id} ${module.version} is verified against framework ${frameworkVersion}.`,
    };
  }

  /*
   * Declared-but-unverified. A warning, not an error: refusing every module that has not been
   * explicitly matrix-tested would make the framework unusable on the day it releases, and the
   * declaration is real evidence — just weaker than a recorded test.
   */
  return {
    surface: 'module',
    id: module.id,
    severity: 'warning',
    verdict: 'unknown',
    detail: `${module.id} ${module.version} declares framework >=${module.minimumFrameworkVersion} and satisfies it, but this pairing has not been verified.`,
    remediation:
      'Run the module’s tests against this framework and record the result in the matrix.',
  };
}

function checkTemplate(
  template: TemplateUnderTest,
  frameworkVersion: string,
  matrix: CompatibilityMatrix,
): CompatibilityFinding {
  const recorded = matrix.check('template', template.id, template.version, frameworkVersion);

  if (recorded.verdict === 'incompatible') {
    return {
      surface: 'template',
      id: template.id,
      severity: 'error',
      verdict: 'incompatible',
      detail: `Template ${template.id} ${template.version} is recorded as incompatible with framework ${frameworkVersion}. ${recorded.note}`,
      remediation: 'Regenerate against a newer template, or pin the framework.',
    };
  }

  if (compareVersions(frameworkVersion, template.minimumFrameworkVersion) < 0) {
    return {
      surface: 'template',
      id: template.id,
      severity: 'error',
      verdict: 'incompatible',
      detail: `Template ${template.id} needs framework ${template.minimumFrameworkVersion} or newer; this is ${frameworkVersion}.`,
      remediation: 'Upgrade the framework before generating.',
    };
  }

  /*
   * A generated project keeps working when its template moves on — nothing generated has a
   * runtime dependency on the template. So this is informational, never a warning: telling
   * somebody their year-old project is "out of date" every time they run a check is how the
   * check gets muted.
   */
  return {
    surface: 'template',
    id: template.id,
    severity: 'ok',
    verdict: recorded.verdict,
    detail: `Template ${template.id} ${template.version} is compatible with framework ${frameworkVersion}.`,
  };
}

/**
 * The CLI against the framework.
 *
 * A CLI *newer* than the framework is fine — it is the tool, and tools lead. A CLI older by a
 * minor is a warning; older by a major is an error, because that is where a command reads a
 * manifest field that did not exist when it was built and silently ignores it.
 */
function checkCli(cliVersion: string, frameworkVersion: string): CompatibilityFinding {
  const comparison = compareVersions(cliVersion, frameworkVersion);

  if (comparison >= 0) {
    return {
      surface: 'cli',
      id: 'cli',
      severity: 'ok',
      verdict: 'compatible',
      detail: `CLI ${cliVersion} is at or ahead of framework ${frameworkVersion}.`,
    };
  }

  /*
   * Whether the gap crosses a breaking boundary, not whether the CLI satisfies a caret range —
   * a range also demands "at least", which every behind-but-compatible CLI fails by definition.
   * `isBreakingChange` knows that below 1.0.0 the minor is the breaking position.
   */
  const acrossBoundary = isBreakingChange(cliVersion, frameworkVersion);

  return {
    surface: 'cli',
    id: 'cli',
    severity: acrossBoundary ? 'error' : 'warning',
    verdict: acrossBoundary ? 'incompatible' : 'unknown',
    detail: `CLI ${cliVersion} is behind framework ${frameworkVersion}.`,
    remediation:
      'Update the CLI. An older CLI reads newer manifests by ignoring the fields it does not know, ' +
      'which looks like success.',
  };
}

function checkDatabase(database: { engine: string; version: string }): CompatibilityFinding {
  const floor = DATABASE_FLOORS[database.engine];

  if (!floor) {
    return {
      surface: 'database',
      id: database.engine,
      severity: 'error',
      verdict: 'incompatible',
      detail: `"${database.engine}" is not a supported database engine. Supported: ${Object.keys(DATABASE_FLOORS).join(', ')}.`,
      remediation:
        'The framework depends on PostgreSQL-specific features — deferred constraint triggers, ' +
        'exclusion constraints — that have no portable equivalent.',
    };
  }

  if (compareVersions(database.version, floor) < 0) {
    return {
      surface: 'database',
      id: database.engine,
      severity: 'error',
      verdict: 'incompatible',
      detail: `${database.engine} ${database.version} is below the supported floor of ${floor}.`,
      remediation: `Upgrade to ${database.engine} ${floor} or newer.`,
    };
  }

  return {
    surface: 'database',
    id: database.engine,
    severity: 'ok',
    verdict: 'compatible',
    detail: `${database.engine} ${database.version} is at or above the ${floor} floor.`,
  };
}

/**
 * A generated API client against the server it calls.
 *
 * A client behind the server is normal and safe: the server keeps its contract within a major.
 * A client *ahead* of the server is the dangerous direction — it calls endpoints that do not
 * exist yet — and a client a major behind is calling a contract that has been withdrawn.
 */
function checkApi(api: { client: string; server: string }): CompatibilityFinding {
  const comparison = compareVersions(api.client, api.server);

  if (comparison > 0) {
    return {
      surface: 'api',
      id: 'api',
      severity: 'error',
      verdict: 'incompatible',
      detail: `The API client is at ${api.client} but the server is at ${api.server}. A client ahead of its server calls endpoints that do not exist yet.`,
      remediation: 'Deploy the server first, then the client. This ordering is not optional.',
    };
  }

  // Same question as the CLI: does the gap cross a breaking boundary, not does it satisfy a range.
  if (comparison < 0 && isBreakingChange(api.client, api.server)) {
    return {
      surface: 'api',
      id: 'api',
      severity: 'error',
      verdict: 'incompatible',
      detail: `The API client is at ${api.client}, a major behind the server at ${api.server}.`,
      remediation: 'Regenerate the client with `trustos docs api` and redeploy.',
    };
  }

  return {
    surface: 'api',
    id: 'api',
    severity: 'ok',
    verdict: 'compatible',
    detail: `API client ${api.client} is within the server’s ${api.server} contract.`,
  };
}

/** The findings that block, in the order a reader should deal with them. */
export function blockingFindings(report: CompatibilityReport): CompatibilityFinding[] {
  return report.findings.filter((finding) => finding.severity === 'error');
}

/** A one-line summary, for a CLI header or a health check. */
export function summarize(report: CompatibilityReport): string {
  const errors = report.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = report.findings.filter((finding) => finding.severity === 'warning').length;
  const unknowns = report.findings.filter((finding) => finding.verdict === 'unknown').length;

  if (errors > 0) return `${errors} incompatibility(ies), ${warnings} warning(s).`;
  if (warnings > 0)
    return `Compatible, with ${warnings} warning(s) and ${unknowns} unverified pairing(s).`;

  return `All ${report.findings.length} surface(s) compatible with framework ${report.frameworkVersion}.`;
}

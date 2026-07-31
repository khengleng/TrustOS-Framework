import type { AnalysisReport } from '@trustos/dependency-analyzer';
import type { QualityReport } from '@trustos/quality-gates';
import { compareVersions } from '@trustos/version-manager';

/**
 * The health of the framework itself.
 *
 * Distinct from `@trustos/observability`, which answers "is this process up". This answers "is
 * this platform in a state somebody can keep operating", and the two go wrong at completely
 * different speeds: a process is unhealthy for minutes, a platform is unhealthy for quarters.
 *
 * The signals are chosen because each one *precedes* a failure rather than reporting it:
 *
 *   * an unsupported version is an upgrade that will become urgent,
 *   * unsigned modules are a supply chain that will be questioned during an incident,
 *   * failing quality gates are defects that have already been merged,
 *   * dependency problems are an upgrade that will not resolve,
 *   * expiring licences are an outage in a month with a purchase order attached.
 *
 * Nothing here is a live metric. A platform-health check that needed a running system could not be
 * run before deciding whether to start one.
 */

export type HealthState = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthSignal {
  area: string;
  state: HealthState;
  detail: string;
  remediation?: string;
  /** Roughly how soon this becomes a problem. Null when it already is one. */
  urgencyDays?: number | null;
}

export interface HealthReport {
  state: HealthState;
  signals: HealthSignal[];
  /** 0–100. A summary, and the components are always shown beside it. */
  score: number;
  summary: string;
}

export interface HealthInput {
  frameworkVersion: string;
  /** Newest released version, for drift. */
  latestVersion?: string;
  /** True when the running version no longer receives security fixes. */
  outOfSupport?: boolean;
  quality?: QualityReport;
  dependencies?: AnalysisReport;
  modules?: { installed: number; unsigned: number; deprecated: number; withdrawn?: number };
  license?: { state: string; daysRemaining: number | null };
  /** Days since the last successful upgrade. A platform nobody upgrades is one nobody can. */
  daysSinceLastUpgrade?: number;
}

const WEIGHTS: Record<HealthState, number> = { healthy: 0, degraded: 1, unhealthy: 3 };

export function assessHealth(input: HealthInput): HealthReport {
  const signals: HealthSignal[] = [];

  signals.push(versionSignal(input));
  if (input.modules) signals.push(supplyChainSignal(input.modules));
  if (input.quality) signals.push(qualitySignal(input.quality));
  if (input.dependencies) signals.push(dependencySignal(input.dependencies));
  if (input.license) signals.push(licenseSignal(input.license));
  if (input.daysSinceLastUpgrade !== undefined) {
    signals.push(upgradeCadenceSignal(input.daysSinceLastUpgrade));
  }

  const penalty = signals.reduce((total, signal) => total + WEIGHTS[signal.state], 0);
  const worst = signals.reduce<HealthState>(
    (state, signal) => (WEIGHTS[signal.state] > WEIGHTS[state] ? signal.state : state),
    'healthy',
  );

  const score = Math.max(0, 100 - Math.round((penalty / (signals.length * 3)) * 100));

  return {
    state: worst,
    signals,
    score,
    summary: summarize(worst, signals, score),
  };
}

function versionSignal(input: HealthInput): HealthSignal {
  if (input.outOfSupport) {
    return {
      area: 'version',
      state: 'unhealthy',
      detail: `${input.frameworkVersion} no longer receives security fixes.`,
      remediation: 'Upgrade. This is the signal that becomes an incident rather than a ticket.',
      urgencyDays: null,
    };
  }

  if (!input.latestVersion || compareVersions(input.latestVersion, input.frameworkVersion) <= 0) {
    return {
      area: 'version',
      state: 'healthy',
      detail: `On ${input.frameworkVersion}, the newest release.`,
    };
  }

  return {
    area: 'version',
    state: 'degraded',
    detail: `On ${input.frameworkVersion}; ${input.latestVersion} is available.`,
    remediation: 'Run `trustos upgrade --dry-run` to see what moving would involve.',
  };
}

function supplyChainSignal(modules: NonNullable<HealthInput['modules']>): HealthSignal {
  if ((modules.withdrawn ?? 0) > 0) {
    return {
      area: 'supply chain',
      state: 'unhealthy',
      detail: `${modules.withdrawn} withdrawn module(s) are installed.`,
      remediation: 'A module is usually withdrawn because of a vulnerability. Replace them.',
      urgencyDays: null,
    };
  }

  if (modules.unsigned > 0) {
    return {
      area: 'supply chain',
      state: 'degraded',
      detail: `${modules.unsigned} of ${modules.installed} module(s) are unsigned.`,
      remediation:
        'Sign them, or record why they are not. This is the list a security review asks for first.',
    };
  }

  return {
    area: 'supply chain',
    state: 'healthy',
    detail: `${modules.installed} module(s), all signed${modules.deprecated > 0 ? `, ${modules.deprecated} deprecated` : ''}.`,
  };
}

function qualitySignal(quality: QualityReport): HealthSignal {
  if (!quality.passed) {
    return {
      area: 'quality',
      state: 'unhealthy',
      detail: `${quality.blocking.length} blocking gate(s) failing: ${quality.blocking
        .map((result) => result.gate)
        .join(', ')}.`,
      remediation: 'These are defects already merged. Fix them before adding more.',
      urgencyDays: null,
    };
  }

  if (quality.waived.length > 0) {
    return {
      area: 'quality',
      state: 'degraded',
      detail: `${quality.waived.length} gate(s) passing only under a waiver.`,
      remediation: 'Every waiver has an expiry. When it passes, the gate fails again.',
    };
  }

  return { area: 'quality', state: 'healthy', detail: 'Every quality gate passing unwaived.' };
}

function dependencySignal(dependencies: AnalysisReport): HealthSignal {
  const errors = dependencies.findings.filter((finding) => finding.severity === 'error');

  if (errors.length > 0) {
    return {
      area: 'dependencies',
      state: 'unhealthy',
      detail: `${errors.length} dependency problem(s): ${[
        ...new Set(errors.map((finding) => finding.kind)),
      ].join(', ')}.`,
      remediation: 'An upgrade will not resolve until these are fixed.',
      urgencyDays: null,
    };
  }

  const warnings = dependencies.findings.filter((finding) => finding.severity === 'warning');

  return warnings.length > 0
    ? {
        area: 'dependencies',
        state: 'degraded',
        detail: `${warnings.length} dependency warning(s).`,
        remediation: 'Unused modules still run migrations and still have to be upgraded.',
      }
    : { area: 'dependencies', state: 'healthy', detail: 'The module graph resolves cleanly.' };
}

function licenseSignal(license: NonNullable<HealthInput['license']>): HealthSignal {
  if (license.state === 'expired') {
    return {
      area: 'licence',
      state: 'degraded',
      // Degraded, not unhealthy: an expired licence stops new privileged operations and leaves
      // the running system running. The framework does not shut anything down over an invoice.
      detail:
        'The licence has expired. Running services are unaffected; gated features are not available.',
      remediation: 'Renew to restore the gated features.',
      urgencyDays: null,
    };
  }

  if (license.state === 'expiring') {
    return {
      area: 'licence',
      state: 'degraded',
      detail: `The licence expires in ${license.daysRemaining} day(s).`,
      remediation: 'Start the renewal — procurement is usually slower than the warning window.',
      urgencyDays: license.daysRemaining,
    };
  }

  return { area: 'licence', state: 'healthy', detail: 'Licence valid.' };
}

/**
 * How long since the last upgrade.
 *
 * A platform nobody upgrades is a platform nobody *can* upgrade: the gap grows, the migration
 * count grows with it, and eventually the upgrade is a project rather than an afternoon. Six
 * months is where that starts to be true.
 */
function upgradeCadenceSignal(days: number): HealthSignal {
  if (days > 365) {
    return {
      area: 'upgrade cadence',
      state: 'unhealthy',
      detail: `Last upgraded ${days} days ago.`,
      remediation:
        'The longer the gap, the more migrations an upgrade crosses at once. Upgrade in steps ' +
        'rather than in one jump.',
      urgencyDays: null,
    };
  }

  if (days > 180) {
    return {
      area: 'upgrade cadence',
      state: 'degraded',
      detail: `Last upgraded ${days} days ago.`,
      remediation: 'Schedule one. An upgrade deferred is an upgrade that gets harder.',
    };
  }

  return { area: 'upgrade cadence', state: 'healthy', detail: `Last upgraded ${days} days ago.` };
}

function summarize(state: HealthState, signals: readonly HealthSignal[], score: number): string {
  const unhealthy = signals.filter((signal) => signal.state === 'unhealthy');
  const degraded = signals.filter((signal) => signal.state === 'degraded');

  if (state === 'unhealthy') {
    return `Unhealthy (${score}/100): ${unhealthy.map((signal) => signal.area).join(', ')} need attention now.`;
  }

  if (state === 'degraded') {
    return `Degraded (${score}/100): ${degraded.map((signal) => signal.area).join(', ')} will become a problem.`;
  }

  return `Healthy (${score}/100) across ${signals.length} signal(s).`;
}

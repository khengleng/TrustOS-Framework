import {
  checkCompatibility,
  summarize as summarizeCompatibility,
  type CompatibilityReport,
} from '@trustos/compatibility-engine';
import {
  analyzeDependencies,
  type AnalysisReport,
  type GraphModule,
} from '@trustos/dependency-analyzer';
import { assessHealth, type HealthReport } from '@trustos/framework-health';
import {
  evaluateLicense,
  OPEN_SOURCE_LICENSE,
  type License,
  type LicenseStatus,
} from '@trustos/license-manager';
import { ReleaseManager, type Release } from '@trustos/release-manager';
import { recommendUpgrade, type UpgradeRecommendation } from '@trustos/version-manager';

/**
 * One view of the platform.
 *
 * Every fact in here is available somewhere else. The reason this package exists is that nobody
 * assembles them: the version is in a package.json, the modules in a lockfile, the licence in a
 * config file, health in a check nobody runs, and the upgrade recommendation nowhere at all. The
 * result is that a question like "is this deployment in good shape" takes an afternoon and three
 * people.
 *
 * `describePlatform` answers it in one call, offline, with no running system. That last part
 * matters more than it sounds: the moment somebody most needs this summary is when they are
 * deciding whether to start the system, or during an incident when it will not start.
 *
 * It aggregates and never decides. Nothing here installs, upgrades or repairs.
 */

export interface InstalledModuleView {
  id: string;
  version: string;
  minimumFrameworkVersion: string;
  signed: boolean;
  status?: 'experimental' | 'stable' | 'deprecated' | 'withdrawn';
  dependencies?: Array<{ moduleId: string; versionRange: string; optional?: boolean }>;
}

export interface PlatformInput {
  frameworkVersion: string;
  cliVersion?: string;
  modules: readonly InstalledModuleView[];
  templates?: ReadonlyArray<{ id: string; version: string; minimumFrameworkVersion: string }>;
  license?: License;
  releases?: ReleaseManager;
  database?: { engine: string; version: string };
  entryPoints?: readonly string[];
  daysSinceLastUpgrade?: number;
  telemetryEnabled?: boolean;
  now?: Date;
}

export interface PlatformSummary {
  framework: {
    version: string;
    channel: Release['channel'] | 'unregistered';
    supportState: string;
    latestAvailable: string | null;
  };
  modules: {
    installed: number;
    signed: number;
    unsigned: number;
    deprecated: number;
    withdrawn: number;
    list: InstalledModuleView[];
  };
  license: LicenseStatus;
  health: HealthReport;
  compatibility: CompatibilityReport;
  dependencies: AnalysisReport;
  upgrade: UpgradeRecommendation;
  telemetry: { enabled: boolean; detail: string };
  /** One paragraph somebody can paste into a status update. */
  summary: string;
}

export function describePlatform(input: PlatformInput): PlatformSummary {
  const now = input.now ?? new Date();
  const releases = input.releases ?? new ReleaseManager([]);
  const release = releases.find(input.frameworkVersion);

  const license = evaluateLicense(input.license ?? OPEN_SOURCE_LICENSE, {
    frameworkVersion: input.frameworkVersion,
    now,
  });

  const graph: GraphModule[] = input.modules.map((module) => ({
    id: module.id,
    version: module.version,
    dependencies: module.dependencies ?? [],
  }));

  const dependencies = analyzeDependencies({
    modules: graph,
    entryPoints: input.entryPoints,
  });

  const compatibility = checkCompatibility({
    frameworkVersion: input.frameworkVersion,
    modules: input.modules.map((module) => ({
      id: module.id,
      version: module.version,
      minimumFrameworkVersion: module.minimumFrameworkVersion,
    })),
    templates: input.templates ? [...input.templates] : undefined,
    cliVersion: input.cliVersion,
    database: input.database,
  });

  const counts = {
    installed: input.modules.length,
    signed: input.modules.filter((module) => module.signed).length,
    unsigned: input.modules.filter((module) => !module.signed).length,
    deprecated: input.modules.filter((module) => module.status === 'deprecated').length,
    withdrawn: input.modules.filter((module) => module.status === 'withdrawn').length,
  };

  const outOfSupport =
    releases.all().length > 0 && releases.isOutOfSupport(input.frameworkVersion, now);

  const upgrade = recommendUpgrade({
    current: input.frameworkVersion,
    available: releases
      .all()
      .filter((entry) => !entry.withdrawn)
      .map((entry) => entry.version),
    securityFixes: releases.securityReleases(),
    outOfSupport,
  });

  const health = assessHealth({
    frameworkVersion: input.frameworkVersion,
    latestVersion: upgrade.to ?? undefined,
    outOfSupport,
    dependencies,
    modules: counts,
    license: { state: license.state, daysRemaining: license.daysRemaining },
    daysSinceLastUpgrade: input.daysSinceLastUpgrade,
  });

  const telemetry = {
    enabled: input.telemetryEnabled ?? false,
    detail: input.telemetryEnabled
      ? 'Telemetry is on. It stays local unless an exporter is wired; the framework ships none.'
      : 'Telemetry is off. Nothing is collected and nothing is sent.',
  };

  return {
    framework: {
      version: input.frameworkVersion,
      channel: release?.channel ?? 'unregistered',
      supportState: release ? releases.stateOf(release, now) : 'unknown',
      latestAvailable: upgrade.to,
    },
    modules: { ...counts, list: [...input.modules] },
    license,
    health,
    compatibility,
    dependencies,
    upgrade,
    telemetry,
    summary: buildSummary({ input, health, license, compatibility, upgrade, counts }),
  };
}

function buildSummary(context: {
  input: PlatformInput;
  health: HealthReport;
  license: LicenseStatus;
  compatibility: CompatibilityReport;
  upgrade: UpgradeRecommendation;
  counts: { installed: number; unsigned: number };
}): string {
  const { input, health, license, compatibility, upgrade, counts } = context;

  const parts = [
    `TrustOS ${input.frameworkVersion} with ${counts.installed} module(s).`,
    health.summary,
    summarizeCompatibility(compatibility),
    license.detail,
  ];

  if (upgrade.to) {
    parts.push(
      `Upgrade available: ${upgrade.to} (${upgrade.urgency}${upgrade.breaking ? ', breaking' : ''}).`,
    );
  }

  if (counts.unsigned > 0) {
    parts.push(`${counts.unsigned} module(s) unsigned.`);
  }

  return parts.join(' ');
}

/**
 * What needs attention, worst first.
 *
 * Pulls from health, compatibility and dependencies into one ordered list, because the three
 * report separately and the reader has one afternoon.
 */
export function actionItems(summary: PlatformSummary): Array<{
  severity: 'error' | 'warning';
  area: string;
  detail: string;
  remediation?: string;
}> {
  const items: Array<{
    severity: 'error' | 'warning';
    area: string;
    detail: string;
    remediation?: string;
  }> = [];

  for (const signal of summary.health.signals) {
    if (signal.state === 'healthy') continue;

    items.push({
      severity: signal.state === 'unhealthy' ? 'error' : 'warning',
      area: signal.area,
      detail: signal.detail,
      remediation: signal.remediation,
    });
  }

  for (const finding of summary.compatibility.findings) {
    if (finding.severity === 'ok') continue;

    items.push({
      severity: finding.severity === 'error' ? 'error' : 'warning',
      area: `compatibility:${finding.surface}`,
      detail: finding.detail,
      remediation: finding.remediation,
    });
  }

  for (const finding of summary.dependencies.findings) {
    if (finding.severity === 'info') continue;

    items.push({
      severity: finding.severity === 'error' ? 'error' : 'warning',
      area: `dependencies:${finding.kind}`,
      detail: finding.detail,
      remediation: finding.remediation,
    });
  }

  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

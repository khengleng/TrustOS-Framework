import { describe, expect, it } from 'vitest';
import { assessHealth } from './index';

/**
 * Every signal is chosen because it *precedes* a failure. The tests are about which state each
 * one produces, because that is what decides whether anybody acts.
 */

const healthy = {
  frameworkVersion: '0.5.0',
  latestVersion: '0.5.0',
  modules: { installed: 4, unsigned: 0, deprecated: 0 },
  daysSinceLastUpgrade: 30,
};

describe('overall state', () => {
  it('reports healthy when every signal is', () => {
    const report = assessHealth(healthy);

    expect(report.state).toBe('healthy');
    expect(report.score).toBe(100);
  });

  it('takes the worst signal as the overall state', () => {
    const report = assessHealth({ ...healthy, outOfSupport: true });

    expect(report.state).toBe('unhealthy');
    expect(report.summary).toMatch(/need attention now/);
  });
});

describe('signals', () => {
  it('treats an unsupported version as unhealthy with no time left', () => {
    const report = assessHealth({ ...healthy, outOfSupport: true });
    const signal = report.signals.find((entry) => entry.area === 'version');

    expect(signal?.state).toBe('unhealthy');
    expect(signal?.urgencyDays).toBeNull();
  });

  it('treats an available upgrade as degraded rather than urgent', () => {
    const report = assessHealth({ ...healthy, latestVersion: '0.6.0' });

    expect(report.signals.find((entry) => entry.area === 'version')?.state).toBe('degraded');
  });

  it('treats a withdrawn module as unhealthy', () => {
    // A module is usually withdrawn because of a vulnerability.
    const report = assessHealth({
      ...healthy,
      modules: { installed: 4, unsigned: 0, deprecated: 0, withdrawn: 1 },
    });

    expect(report.signals.find((entry) => entry.area === 'supply chain')?.state).toBe('unhealthy');
  });

  it('treats unsigned modules as degraded', () => {
    const report = assessHealth({
      ...healthy,
      modules: { installed: 4, unsigned: 2, deprecated: 0 },
    });

    const signal = report.signals.find((entry) => entry.area === 'supply chain');

    expect(signal?.state).toBe('degraded');
    expect(signal?.remediation).toMatch(/security review asks for first/);
  });

  it('treats an expired licence as degraded, not unhealthy', () => {
    // The framework does not shut anything down over an invoice.
    const report = assessHealth({
      ...healthy,
      license: { state: 'expired', daysRemaining: -5 },
    });

    const signal = report.signals.find((entry) => entry.area === 'licence');

    expect(signal?.state).toBe('degraded');
    expect(signal?.detail).toMatch(/Running services are unaffected/);
  });

  it('carries the days remaining on an expiring licence', () => {
    const report = assessHealth({ ...healthy, license: { state: 'expiring', daysRemaining: 12 } });

    expect(report.signals.find((entry) => entry.area === 'licence')?.urgencyDays).toBe(12);
  });

  it('escalates upgrade cadence with the gap', () => {
    /*
     * A platform nobody upgrades is a platform nobody *can* upgrade: the gap grows, the migration
     * count grows with it, and eventually the upgrade is a project rather than an afternoon.
     */
    const states = [30, 200, 400].map(
      (days) =>
        assessHealth({ ...healthy, daysSinceLastUpgrade: days }).signals.find(
          (entry) => entry.area === 'upgrade cadence',
        )?.state,
    );

    expect(states).toEqual(['healthy', 'degraded', 'unhealthy']);
  });

  it('treats a failing quality gate as unhealthy and a waived one as degraded', () => {
    const failing = assessHealth({
      ...healthy,
      quality: {
        passed: false,
        blocking: [{ gate: 'security', status: 'fail', detail: 'x' }],
        waived: [],
        results: [],
      },
    });

    const waived = assessHealth({
      ...healthy,
      quality: {
        passed: true,
        blocking: [],
        waived: [{ gate: 'coverage', status: 'waived', detail: 'x' }],
        results: [],
      },
    });

    expect(failing.signals.find((entry) => entry.area === 'quality')?.state).toBe('unhealthy');
    expect(waived.signals.find((entry) => entry.area === 'quality')?.state).toBe('degraded');
  });

  it('treats a dependency error as blocking an upgrade', () => {
    const report = assessHealth({
      ...healthy,
      dependencies: {
        ok: false,
        installOrder: [],
        findings: [{ kind: 'cycle', severity: 'error', moduleId: 'a', detail: 'a → b → a' }],
      },
    });

    const signal = report.signals.find((entry) => entry.area === 'dependencies');

    expect(signal?.state).toBe('unhealthy');
    expect(signal?.remediation).toMatch(/upgrade will not resolve/);
  });
});

import { describe, expect, it } from 'vitest';
import { ReleaseManager } from '@trustos/release-manager';
import { actionItems, describePlatform } from './index';

const NOW = new Date('2026-07-01T00:00:00.000Z');

const releases = new ReleaseManager([
  {
    version: '0.4.0',
    channel: 'stable',
    releasedAt: '2026-03-01',
    securitySupportUntil: '2026-06-01',
  },
  { version: '0.5.0', channel: 'stable', releasedAt: '2026-06-01' },
]);

const input = (overrides: Record<string, unknown> = {}) => ({
  frameworkVersion: '0.5.0',
  cliVersion: '0.5.0',
  modules: [
    { id: 'search', version: '1.0.0', minimumFrameworkVersion: '0.4.0', signed: true },
    { id: 'notification', version: '1.0.0', minimumFrameworkVersion: '0.4.0', signed: true },
  ],
  releases,
  database: { engine: 'postgresql', version: '16.2.0' },
  daysSinceLastUpgrade: 20,
  now: NOW,
  ...overrides,
});

describe('the summary', () => {
  it('answers the whole question in one call, offline', () => {
    /*
     * The moment somebody most needs this is when they are deciding whether to start the system,
     * or during an incident when it will not start. Nothing here touches a running service.
     */
    const summary = describePlatform(input());

    expect(summary.framework).toMatchObject({ version: '0.5.0', channel: 'stable' });
    expect(summary.modules.installed).toBe(2);
    expect(summary.health.state).toBe('healthy');
    expect(summary.summary).toMatch(/TrustOS 0\.5\.0 with 2 module\(s\)/);
  });

  it('defaults to the open-source licence rather than refusing to answer', () => {
    expect(describePlatform(input()).license.license.tier).toBe('open-source');
  });

  it('says telemetry is off when it is', () => {
    expect(describePlatform(input()).telemetry).toEqual({
      enabled: false,
      detail: 'Telemetry is off. Nothing is collected and nothing is sent.',
    });
  });

  it('says the framework ships no exporter when telemetry is on', () => {
    expect(describePlatform(input({ telemetryEnabled: true })).telemetry.detail).toMatch(
      /stays local unless an exporter is wired/,
    );
  });
});

describe('counts', () => {
  it('separates signed from unsigned and deprecated from withdrawn', () => {
    const summary = describePlatform(
      input({
        modules: [
          { id: 'a', version: '1.0.0', minimumFrameworkVersion: '0.4.0', signed: true },
          { id: 'b', version: '1.0.0', minimumFrameworkVersion: '0.4.0', signed: false },
          {
            id: 'c',
            version: '1.0.0',
            minimumFrameworkVersion: '0.4.0',
            signed: true,
            status: 'deprecated' as const,
          },
          {
            id: 'd',
            version: '1.0.0',
            minimumFrameworkVersion: '0.4.0',
            signed: true,
            status: 'withdrawn' as const,
          },
        ],
      }),
    );

    expect(summary.modules).toMatchObject({
      installed: 4,
      signed: 3,
      unsigned: 1,
      deprecated: 1,
      withdrawn: 1,
    });

    expect(summary.summary).toMatch(/1 module\(s\) unsigned/);
  });
});

describe('upgrade status', () => {
  it('reports an upgrade as required when the running version is out of support', () => {
    const summary = describePlatform(input({ frameworkVersion: '0.4.0' }));

    expect(summary.framework.supportState).toBe('eol');
    expect(summary.upgrade).toMatchObject({ to: '0.5.0', urgency: 'required' });
    expect(summary.health.state).toBe('unhealthy');
  });

  it('reports an unregistered version rather than guessing at its channel', () => {
    const summary = describePlatform(input({ frameworkVersion: '0.9.9' }));

    expect(summary.framework.channel).toBe('unregistered');
  });
});

describe('action items', () => {
  it('collects from health, compatibility and dependencies with errors first', () => {
    // The three report separately and the reader has one afternoon.
    const summary = describePlatform(
      input({
        frameworkVersion: '0.4.0',
        modules: [
          { id: 'future', version: '1.0.0', minimumFrameworkVersion: '0.9.0', signed: false },
        ],
      }),
    );

    const items = actionItems(summary);

    expect(items[0]?.severity).toBe('error');
    expect(items.map((item) => item.area)).toContain('compatibility:module');
    expect(items.map((item) => item.area)).toContain('version');
  });

  it('has nothing blocking on a healthy platform', () => {
    /*
     * Not empty: the modules are declared-compatible but unverified, which is a warning by
     * design. "No unverified pairings" would mean every module had been matrix-tested against
     * every framework version, which is not a state a real deployment is ever in.
     */
    const items = actionItems(describePlatform(input()));

    expect(items.filter((item) => item.severity === 'error')).toEqual([]);
    expect(items.every((item) => item.area === 'compatibility:module')).toBe(true);
  });
});

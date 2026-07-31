import { describe, expect, it } from 'vitest';
import { ReleaseManager, releaseSchema, renderChangelog, renderReleaseNotes } from './index';

const NOW = new Date('2026-07-01T00:00:00.000Z');

const RELEASES = [
  {
    version: '0.3.0',
    channel: 'stable' as const,
    releasedAt: '2026-01-01',
    securitySupportUntil: '2026-06-01',
  },
  {
    version: '0.4.0',
    channel: 'lts' as const,
    releasedAt: '2026-03-01',
    activeUntil: '2026-09-01',
    securitySupportUntil: '2027-03-01',
  },
  {
    version: '0.5.0',
    channel: 'stable' as const,
    releasedAt: '2026-06-01',
    notes: 'Includes a security fix.',
  },
  { version: '0.6.0-rc.1', channel: 'rc' as const, releasedAt: '2026-06-20' },
];

describe('the register', () => {
  it('refuses a stable release carrying a prerelease identifier', () => {
    expect(() =>
      releaseSchema.parse({ version: '1.0.0-rc.1', channel: 'stable', releasedAt: '2026-01-01' }),
    ).toThrow();
  });

  it('refuses a beta with no prerelease identifier', () => {
    // It installs by default under a caret range, because nothing in the version says it is a beta.
    expect(() =>
      releaseSchema.parse({ version: '1.0.0', channel: 'beta', releasedAt: '2026-01-01' }),
    ).toThrow();
  });

  it('refuses an LTS with no support date', () => {
    // "Long term" with no date is a promise nobody can plan against.
    expect(() =>
      releaseSchema.parse({ version: '1.0.0', channel: 'lts', releasedAt: '2026-01-01' }),
    ).toThrow();
  });

  it('refuses security support ending before active support', () => {
    expect(() =>
      releaseSchema.parse({
        version: '1.0.0',
        channel: 'stable',
        releasedAt: '2026-01-01',
        activeUntil: '2027-01-01',
        securitySupportUntil: '2026-06-01',
      }),
    ).toThrow();
  });
});

describe('support state', () => {
  const manager = new ReleaseManager(RELEASES);

  it('reports a release past its security date as end-of-life', () => {
    expect(manager.stateOf(manager.find('0.3.0')!, NOW)).toBe('eol');
    expect(manager.isOutOfSupport('0.3.0', NOW)).toBe(true);
  });

  it('reports an LTS in maintenance', () => {
    expect(manager.stateOf(manager.find('0.4.0')!, NOW)).toBe('maintenance');
  });

  it('treats an unregistered version as unsupported', () => {
    // It is not in the register, so nobody has committed to fixing it.
    expect(manager.isOutOfSupport('0.9.9', NOW)).toBe(true);
  });

  it('lists only the supported releases', () => {
    expect(manager.supported(NOW).map((release) => release.version)).toEqual([
      '0.4.0',
      '0.5.0',
      '0.6.0-rc.1',
    ]);
  });

  it('finds the newest release on a channel', () => {
    expect(manager.latest('stable')?.version).toBe('0.5.0');
    expect(manager.latest('rc')?.version).toBe('0.6.0-rc.1');
  });

  it('finds the releases carrying a security fix', () => {
    expect(manager.securityReleases()).toEqual(['0.5.0']);
  });
});

describe('promotion', () => {
  it('moves a release forward', () => {
    expect(new ReleaseManager(RELEASES).promote('0.5.0', 'lts').channel).toBe('lts');
  });

  it('refuses to move backwards', () => {
    // A stable release that goes back to beta is one nobody can trust.
    expect(() => new ReleaseManager(RELEASES).promote('0.5.0', 'beta')).toThrow(
      /Channels move forward only/,
    );
  });

  it('refuses to promote a prerelease to stable', () => {
    expect(() => new ReleaseManager(RELEASES).promote('0.6.0-rc.1', 'stable')).toThrow(
      /Cut 0\.6\.0 first/,
    );
  });
});

describe('support changes', () => {
  it('extends support', () => {
    expect(
      new ReleaseManager(RELEASES).extendSupport('0.4.0', '2028-01-01').securitySupportUntil,
    ).toBe('2028-01-01');
  });

  it('refuses to shorten support', () => {
    // Teams plan upgrades against these dates.
    expect(() => new ReleaseManager(RELEASES).extendSupport('0.4.0', '2026-08-01')).toThrow(
      /Cannot shorten support/,
    );
  });

  it('records a withdrawal and treats it as end-of-life', () => {
    const manager = new ReleaseManager(RELEASES);
    manager.withdraw('0.5.0', 'Data loss on upgrade from 0.3.');

    expect(manager.stateOf(manager.find('0.5.0')!, NOW)).toBe('eol');
    expect(manager.latest('stable')?.version).toBe('0.3.0');
  });

  it('refuses a withdrawal with no reason', () => {
    expect(() => new ReleaseManager(RELEASES).withdraw('0.5.0', '   ')).toThrow();
  });
});

describe('release notes', () => {
  const entry = {
    version: '0.5.0',
    releasedAt: '2026-06-01',
    summary: 'The platform release.',
    breakingChanges: ['`Foo.bar` renamed.'],
    securityFixes: ['Token leak fixed.'],
    features: ['Marketplace.'],
    fixes: [],
    deprecations: [{ what: 'old()', replacement: 'new()', removedIn: '0.7.0' }],
  };

  it('puts breaking changes before features', () => {
    /*
     * A reader deciding whether to upgrade needs to know what will break before what they gain.
     * Features first optimises for the announcement and against the reader.
     */
    const notes = renderReleaseNotes(entry);

    expect(notes.indexOf('## Breaking changes')).toBeLessThan(notes.indexOf('## Added'));
    expect(notes.indexOf('## Breaking changes')).toBeLessThan(notes.indexOf('## Security'));
  });

  it('tells a reader the upgrade is breaking when asked for guidance', () => {
    expect(renderReleaseNotes(entry, { includeUpgradeGuidance: true })).toMatch(
      /This release is breaking\. The dry run lists every migration/,
    );
  });

  it('renders a changelog newest first', () => {
    const changelog = renderChangelog([
      { ...entry, version: '0.4.0', releasedAt: '2026-03-01' },
      entry,
    ]);

    expect(changelog.indexOf('## 0.5.0')).toBeLessThan(changelog.indexOf('## 0.4.0'));
  });
});

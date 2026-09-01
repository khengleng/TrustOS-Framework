import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import {
  assertForwardUpgrade,
  CompatibilityMatrix,
  compareVersions,
  formatVersion,
  isBreakingChange,
  latestVersion,
  maxSatisfying,
  parseRange,
  parseVersion,
  recommendUpgrade,
  satisfies,
  sortVersions,
  VersionHistory,
  versionChange,
} from './index';

/**
 * The tests worth writing are the ones where the obvious implementation is wrong.
 *
 * Sorting versions as strings. Treating 0.x as "anything goes". Letting a caret range match a
 * prerelease of the next major. Assuming an untested pairing works. Each of those produces a
 * version manager that behaves correctly in every demo.
 */

function detailsOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (error) {
    if (error instanceof ApiError) return (error.details ?? []).map((d) => d.message).join(' | ');
    return error instanceof Error ? error.message : String(error);
  }
}

describe('parsing', () => {
  it('splits a full version', () => {
    expect(parseVersion('1.2.3-rc.1+build.5')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['rc', 1],
      build: 'build.5',
    });
  });

  it('round-trips', () => {
    for (const version of ['0.1.0', '1.2.3', '1.0.0-rc.1', '2.0.0-alpha.beta+exp']) {
      expect(formatVersion(parseVersion(version))).toBe(version);
    }
  });

  it('refuses something that is not a version', () => {
    expect(detailsOf(() => parseVersion('1.2'))).toMatch(/not a semantic version/);
    expect(detailsOf(() => parseVersion('latest'))).toMatch(/not a semantic version/);
  });
});

describe('precedence', () => {
  it('sorts a prerelease below its release', () => {
    // The rule everybody gets wrong by sorting strings, and the one that decides whether an
    // upgrade check thinks a release candidate is newer than the release.
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  it('compares numeric prerelease identifiers numerically', () => {
    // As strings, 'rc.10' < 'rc.2'.
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
  });

  it('ranks a numeric identifier below an alphanumeric one', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('treats a shorter identifier set as lower', () => {
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBe(-1);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('sorts a list correctly', () => {
    expect(sortVersions(['1.0.0', '0.9.9', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.1'])).toEqual([
      '0.9.9',
      '1.0.0-rc.2',
      '1.0.0-rc.10',
      '1.0.0',
      '1.0.1',
    ]);

    expect(latestVersion(['0.1.0', '0.10.0', '0.2.0'])).toBe('0.10.0');
  });
});

describe('breaking changes', () => {
  it('treats the minor as breaking below 1.0.0', () => {
    /*
     * Treating 0.x as "anything goes" is how a framework at 0.9 breaks every application on a
     * patch release and calls itself compliant.
     */
    expect(isBreakingChange('0.1.0', '0.2.0')).toBe(true);
    expect(isBreakingChange('0.1.0', '0.1.9')).toBe(false);
    expect(isBreakingChange('1.1.0', '1.2.0')).toBe(false);
    expect(isBreakingChange('1.0.0', '2.0.0')).toBe(true);
  });

  it('names the position that changed', () => {
    expect(versionChange('1.0.0', '2.0.0')).toBe('major');
    expect(versionChange('1.0.0', '1.1.0')).toBe('minor');
    expect(versionChange('1.0.0', '1.0.1')).toBe('patch');
    expect(versionChange('1.0.0-rc.1', '1.0.0-rc.2')).toBe('prerelease');
    expect(versionChange('1.0.0', '1.0.0')).toBeNull();
  });
});

describe('ranges', () => {
  it('parses the four supported forms', () => {
    expect(parseRange('^1.2.3').operator).toBe('caret');
    expect(parseRange('~1.2.3').operator).toBe('tilde');
    expect(parseRange('>=1.2.3').operator).toBe('gte');
    expect(parseRange('1.2.3').operator).toBe('exact');
  });

  it('refuses a form it does not support rather than guessing', () => {
    // A dependency that genuinely needs a union is a dependency that needs a conversation.
    expect(detailsOf(() => parseRange('1.x || 2.x'))).toMatch(/unions and wildcards/);
    expect(detailsOf(() => parseRange('*'))).toMatch(/not a supported version range/);
  });

  it('bounds a caret at the next major', () => {
    expect(satisfies('1.9.9', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
  });

  it('bounds a caret at the next minor below 1.0.0', () => {
    expect(satisfies('0.2.9', '^0.2.1')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.1')).toBe(false);
  });

  it('bounds a tilde at the next minor', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
  });

  it('never matches a prerelease of a different version', () => {
    /*
     * `^1.0.0` matching `2.0.0-rc.1` would install a release candidate of the next major into an
     * application that asked for compatible updates.
     */
    expect(satisfies('2.0.0-rc.1', '^1.0.0')).toBe(false);
    expect(satisfies('1.5.0-rc.1', '^1.0.0')).toBe(false);
    // Unless the range itself names a prerelease of that same core version.
    expect(satisfies('1.0.0-rc.2', '^1.0.0-rc.1')).toBe(true);
  });

  it('picks the highest satisfying version, not the lowest', () => {
    // Picking the bottom of a range installs the oldest acceptable version, which is the one
    // with the security fixes missing.
    expect(maxSatisfying(['1.0.0', '1.2.0', '1.9.0', '2.0.0'], '^1.0.0')).toBe('1.9.0');
    expect(maxSatisfying(['2.0.0'], '^1.0.0')).toBeNull();
  });
});

describe('the compatibility matrix', () => {
  const matrix = new CompatibilityMatrix([
    {
      subject: 'module',
      id: 'notification',
      subjectRange: '^1.0.0',
      frameworkRange: '^0.4.0',
      verdict: 'compatible',
      note: '',
    },
    {
      subject: 'module',
      id: 'notification',
      subjectRange: '^1.0.0',
      frameworkRange: '^0.5.0',
      verdict: 'incompatible',
      note: 'The audit sink contract changed.',
    },
  ]);

  it('reports an unrecorded pairing as unknown, never as compatible', () => {
    /*
     * A rule that says "any framework at or above the minimum works" is right until the framework
     * removes something, and then it is silently wrong for every module ever published.
     */
    const verdict = matrix.check('module', 'search', '1.0.0', '0.4.0');

    expect(verdict.verdict).toBe('unknown');
    expect(verdict.note).toMatch(/Untested is not the same as broken/);
  });

  it('lets one recorded incompatibility outrank recorded successes', () => {
    expect(matrix.check('module', 'notification', '1.0.0', '0.4.0').verdict).toBe('compatible');
    expect(matrix.check('module', 'notification', '1.0.0', '0.5.0').verdict).toBe('incompatible');
  });

  it('refuses an incompatible entry with no reason', () => {
    expect(
      () =>
        new CompatibilityMatrix([
          {
            subject: 'module',
            id: 'x',
            subjectRange: '^1.0.0',
            frameworkRange: '^1.0.0',
            verdict: 'incompatible',
          },
        ]),
    ).toThrow();
  });
});

describe('upgrade recommendations', () => {
  const available = ['0.1.0', '0.2.0', '0.3.0', '0.4.0-rc.1'];

  it('offers the highest stable version and ignores prereleases by default', () => {
    const recommendation = recommendUpgrade({ current: '0.1.0', available });

    expect(recommendation.to).toBe('0.3.0');
    expect(recommendation.breaking).toBe(true);
  });

  it('offers a prerelease only when asked', () => {
    expect(recommendUpgrade({ current: '0.1.0', available, includePrereleases: true }).to).toBe(
      '0.4.0-rc.1',
    );
  });

  it('makes an upgrade required when it crosses a security fix', () => {
    const recommendation = recommendUpgrade({
      current: '0.1.0',
      available,
      securityFixes: ['0.2.0'],
    });

    expect(recommendation.urgency).toBe('required');
    expect(recommendation.reasons.join(' ')).toMatch(/Security fixes in 0\.2\.0/);
  });

  it('makes an upgrade required when the current version is out of support', () => {
    expect(recommendUpgrade({ current: '0.1.0', available, outOfSupport: true }).urgency).toBe(
      'required',
    );
  });

  it('says so when there is nothing newer', () => {
    const recommendation = recommendUpgrade({ current: '0.3.0', available });

    expect(recommendation.to).toBeNull();
    expect(recommendation.urgency).toBe('none');
  });

  it('reports required with nowhere to go when out of support at the newest version', () => {
    // The worst case, and the one worth saying out loud rather than reporting as "up to date".
    const recommendation = recommendUpgrade({
      current: '0.3.0',
      available,
      outOfSupport: true,
    });

    expect(recommendation.urgency).toBe('required');
    expect(recommendation.reasons.join(' ')).toMatch(/nothing newer to move to/);
  });

  it('refuses a downgrade rather than pretending it works', () => {
    // Migrations run forward. A schema migrated to 0.4 does not un-migrate by installing 0.3.
    expect(detailsOf(() => assertForwardUpgrade('0.4.0', '0.3.0'))).toMatch(
      /Migrations run forward/,
    );
    expect(() => assertForwardUpgrade('0.3.0', '0.4.0')).not.toThrow();
  });
});

describe('version history', () => {
  const history = new VersionHistory([
    {
      version: '0.2.0',
      releasedAt: '2026-02-01',
      summary: 'Second release.',
      breakingChanges: ['`Foo.bar` renamed to `Foo.baz`.'],
    },
    {
      version: '0.3.0',
      releasedAt: '2026-03-01',
      summary: 'Third release.',
      securityFixes: ['Fixed a token leak in the audit log.'],
      deprecations: [{ what: 'Foo.old', replacement: 'Foo.new', removedIn: '0.5.0' }],
    },
    { version: '0.1.0', releasedAt: '2026-01-01', summary: 'First release.' },
  ]);

  it('sorts by precedence regardless of input order', () => {
    expect(history.all().map((entry) => entry.version)).toEqual(['0.1.0', '0.2.0', '0.3.0']);
    expect(history.latest()?.version).toBe('0.3.0');
  });

  it('excludes the version you are on from the range', () => {
    // Including it would show a team the notes for a release they have run for a year.
    expect(history.between('0.1.0', '0.3.0').map((entry) => entry.version)).toEqual([
      '0.2.0',
      '0.3.0',
    ]);
  });

  it('collects breaking changes with the version that introduced them', () => {
    expect(history.breakingChangesBetween('0.1.0', '0.3.0')).toEqual([
      { version: '0.2.0', change: '`Foo.bar` renamed to `Foo.baz`.' },
    ]);
  });

  it('finds the security fixes an upgrade would pick up', () => {
    expect(history.securityFixesBetween('0.1.0', '0.3.0')).toEqual(['0.3.0']);
  });

  it('lists deprecations with the version that announced them', () => {
    expect(history.activeDeprecations('0.1.0', '0.3.0')).toEqual([
      { what: 'Foo.old', replacement: 'Foo.new', removedIn: '0.5.0', announcedIn: '0.3.0' },
    ]);
  });

  it('assumes breaking when there is no record across a boundary', () => {
    // Absence of a note is not evidence that nothing broke, and the safe assumption is the one
    // that makes somebody read.
    expect(new VersionHistory([]).isBreaking('0.1.0', '0.2.0')).toBe(true);
  });
});

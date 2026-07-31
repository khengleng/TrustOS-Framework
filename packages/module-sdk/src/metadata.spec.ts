import { describe, expect, it } from 'vitest';
import { compareSemver, satisfiesMinimum, satisfiesVersionRange } from './metadata';

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareSemver('0.1.2', '0.1.2')).toBe(0);
  });

  it('tolerates a leading v', () => {
    expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
  });

  it('refuses a range where a version was expected', () => {
    /*
     * A behaviour change, and a deliberate one. The previous implementation stripped `^` and `~`
     * before comparing, so `compareSemver('^1.2.3', '1.2.3')` returned 0 — which invites a caller
     * to compare a *range* as though it were a version and get a confident wrong answer.
     * Comparing a range is a category error; `satisfiesVersionRange` is the function for that.
     */
    expect(() => compareSemver('^1.2.3', '1.2.3')).toThrow();
  });

  it('orders a prerelease below the release it leads to', () => {
    /*
     * The bug this consolidation fixed. The local copy stripped everything after the patch, so
     * these compared equal — and `satisfiesMinimum('1.0.0-rc.1', '1.0.0')` was therefore true,
     * accepting a release candidate wherever the release was required.
     */
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(satisfiesMinimum('1.0.0-rc.1', '1.0.0')).toBe(false);
    // And numeric prerelease identifiers order numerically, not as strings.
    expect(compareSemver('1.0.0-rc.10', '1.0.0-rc.2')).toBeGreaterThan(0);
  });

  it('does not let a caret range accept a prerelease of the next major', () => {
    // `^1.0.0` matching `2.0.0-rc.1` would install a release candidate of the next major into an
    // application that asked for compatible updates.
    expect(satisfiesVersionRange('2.0.0-rc.1', '^1.0.0')).toBe(false);
  });
});

describe('satisfiesMinimum', () => {
  it('is inclusive of the minimum', () => {
    expect(satisfiesMinimum('0.1.0', '0.1.0')).toBe(true);
    expect(satisfiesMinimum('0.0.9', '0.1.0')).toBe(false);
  });
});

describe('satisfiesVersionRange', () => {
  it('treats a bare version as exact', () => {
    expect(satisfiesVersionRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesVersionRange('1.2.4', '1.2.3')).toBe(false);
  });

  it('allows patch and minor increases within a caret range', () => {
    expect(satisfiesVersionRange('1.3.0', '^1.2.3')).toBe(true);
    expect(satisfiesVersionRange('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfiesVersionRange('1.2.2', '^1.2.3')).toBe(false);
  });

  it('applies npm pre-1.0 caret rules, where the minor acts as the major', () => {
    // Every module in this repository is still 0.x. Treating ^0.1.0 as "any
    // 0.x" would let a breaking 0.2.0 satisfy a dependency that was reviewed
    // against 0.1.x.
    expect(satisfiesVersionRange('0.1.5', '^0.1.0')).toBe(true);
    expect(satisfiesVersionRange('0.2.0', '^0.1.0')).toBe(false);
    expect(satisfiesVersionRange('1.0.0', '^0.1.0')).toBe(false);
  });
});

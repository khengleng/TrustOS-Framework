import { describe, expect, it } from 'vitest';
import { compareSemver, satisfiesMinimum, satisfiesVersionRange } from './metadata';

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareSemver('0.1.2', '0.1.2')).toBe(0);
  });

  it('tolerates a leading v or range marker', () => {
    expect(compareSemver('v1.2.3', '^1.2.3')).toBe(0);
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

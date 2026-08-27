import { describe, expect, it } from 'vitest';
import {
  CLASSIFICATION_OBLIGATIONS,
  DATA_CLASSIFICATION_LEVELS,
  assertPermitted,
  classificationExtensionSchema,
  classificationRank,
  combineClassifications,
  obligationsFor,
} from './index';

describe('the obligation table', () => {
  it('gives every level obligations that actually differ', () => {
    // A scheme whose levels only differ in name is a scheme where everything is eventually
    // `internal`, because nothing follows from choosing anything else.
    const rendered = DATA_CLASSIFICATION_LEVELS.map((level) => {
      const { description, level: _level, ...obligations } = obligationsFor(level);
      void description;
      return JSON.stringify(obligations);
    });

    expect(new Set(rendered).size).toBe(DATA_CLASSIFICATION_LEVELS.length);
  });

  it('never loosens as it gets more restrictive', () => {
    // A table where RESTRICTED is somehow more permissive than CONFIDENTIAL in one column
    // produces exactly one wrong decision and nobody notices which.
    for (let index = 1; index < DATA_CLASSIFICATION_LEVELS.length; index += 1) {
      const looser = obligationsFor(DATA_CLASSIFICATION_LEVELS[index - 1]!);
      const stricter = obligationsFor(DATA_CLASSIFICATION_LEVELS[index]!);

      if (looser.maskByDefault) expect(stricter.maskByDefault).toBe(true);
      if (!looser.exportable) expect(stricter.exportable).toBe(false);
      if (looser.revealRequiresApproval) expect(stricter.revealRequiresApproval).toBe(true);
      if (!looser.crossRegionPermitted) expect(stricter.crossRegionPermitted).toBe(false);
      if (!looser.aiInputPermitted) expect(stricter.aiInputPermitted).toBe(false);
      expect(stricter.reviewIntervalDays).toBeLessThanOrEqual(looser.reviewIntervalDays);
    }
  });

  it('makes the highest level a level data does not leave the system from', () => {
    const highest = obligationsFor('HIGHLY_RESTRICTED');

    expect(highest.exportable).toBe(false);
    expect(highest.crossRegionPermitted).toBe(false);
    expect(highest.aiInputPermitted).toBe(false);
    expect(highest.revealRequiresApproval).toBe(true);
  });

  it('ships exactly the five levels the specification names', () => {
    expect([...DATA_CLASSIFICATION_LEVELS]).toEqual([
      'PUBLIC',
      'INTERNAL',
      'CONFIDENTIAL',
      'RESTRICTED',
      'HIGHLY_RESTRICTED',
    ]);
    expect(Object.keys(CLASSIFICATION_OBLIGATIONS)).toHaveLength(5);
  });
});

describe('combining classifications', () => {
  it('takes the highest, always', () => {
    // A report joining a public table to a restricted one and inheriting "public" is a restricted
    // extract with a public label, and every downstream control is then the wrong one.
    expect(combineClassifications('PUBLIC', 'RESTRICTED')).toBe('RESTRICTED');
    expect(combineClassifications('CONFIDENTIAL', 'INTERNAL', 'HIGHLY_RESTRICTED')).toBe(
      'HIGHLY_RESTRICTED',
    );
  });

  it('never averages or takes the destination’s own', () => {
    expect(combineClassifications('PUBLIC', 'HIGHLY_RESTRICTED')).not.toBe('CONFIDENTIAL');
  });

  it('defaults to INTERNAL when given nothing, rather than PUBLIC', () => {
    expect(combineClassifications()).toBe('INTERNAL');
  });

  it('ranks levels in order', () => {
    expect(classificationRank('PUBLIC')).toBeLessThan(classificationRank('HIGHLY_RESTRICTED'));
  });
});

describe('permitted operations', () => {
  it('refuses an export of the highest level, and explains the real fix', () => {
    try {
      assertPermitted('HIGHLY_RESTRICTED', 'export');
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('the classification is probably wrong');
    }
  });

  it('refuses cross-region for restricted data', () => {
    expect(() => assertPermitted('RESTRICTED', 'cross_region')).toThrow();
    expect(() => assertPermitted('CONFIDENTIAL', 'cross_region')).not.toThrow();
  });

  it('refuses AI input for the highest level only', () => {
    expect(() => assertPermitted('HIGHLY_RESTRICTED', 'ai_input')).toThrow();
    expect(() => assertPermitted('RESTRICTED', 'ai_input')).not.toThrow();
  });
});

describe('organization extensions', () => {
  it('accepts a level that is stricter than the one it sits above', () => {
    expect(() =>
      classificationExtensionSchema.parse({
        code: 'REGULATED',
        label: 'Regulated',
        description: 'Data a regulator has specific rules about.',
        insertAfter: 'CONFIDENTIAL',
        obligations: {
          maskByDefault: true,
          exportable: false,
          revealRequiresApproval: true,
          crossRegionPermitted: false,
          defaultRetentionDays: 3650,
          reviewIntervalDays: 90,
          aiInputPermitted: false,
        },
      }),
    ).not.toThrow();
  });

  it('refuses a level that sits higher and obliges less', () => {
    // A level that sits higher and obliges less is a level people use to get out of an
    // obligation.
    expect(() =>
      classificationExtensionSchema.parse({
        code: 'SPECIAL',
        label: 'Special',
        description: 'Sits above restricted and somehow exports.',
        insertAfter: 'RESTRICTED',
        obligations: {
          maskByDefault: false,
          exportable: true,
          revealRequiresApproval: false,
          crossRegionPermitted: true,
          defaultRetentionDays: 365,
          reviewIntervalDays: 365,
          aiInputPermitted: true,
        },
      }),
    ).toThrow(/obliges less/);
  });
});

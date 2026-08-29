import { describe, expect, it } from 'vitest';
import {
  OUTCOME,
  appendOnlyAssertionIsMeaningful,
  classifyOutcome,
  tenantAssertionIsMeaningful,
} from './validation-outcome.mjs';

/*
 * Tests for the validator, not for the framework.
 *
 * Every case here is a false positive that actually happened during Step 1. The
 * framework was correct each time; the validator reported confidently about something it
 * had not observed. These exist so that cannot recur silently.
 */

describe('classifying what was observed', () => {
  const expectRefusal = (observed) => observed.refused === true;

  it('passes when the control did what was expected', () => {
    expect(classifyOutcome({ observed: { refused: true }, expectation: expectRefusal })).toBe(
      OUTCOME.PASS,
    );
  });

  it('fails when the control did the opposite', () => {
    expect(classifyOutcome({ observed: { refused: false }, expectation: expectRefusal })).toBe(
      OUTCOME.FAIL,
    );
  });

  it('reports NOT_REACHED rather than a verdict when the step never ran', () => {
    // The bug this prevents: a self-approval check printing "THE MAKER APPROVED THEIR
    // OWN REQUEST" about a step that never executed, because the scenario had failed to
    // start. Alarming, and untrue.
    expect(classifyOutcome({ observed: undefined, expectation: expectRefusal })).toBe(
      OUTCOME.NOT_REACHED,
    );
    expect(classifyOutcome({ observed: null, expectation: expectRefusal })).toBe(
      OUTCOME.NOT_REACHED,
    );
  });

  it('never reports a pass for something it did not observe', () => {
    const alwaysTrue = () => true;

    // Even an expectation that would accept anything must not pass on absent evidence.
    expect(classifyOutcome({ observed: undefined, expectation: alwaysTrue })).not.toBe(
      OUTCOME.PASS,
    );
  });

  it('separates a broken check from a failing control', () => {
    // "The check threw" and "the control allowed it" need different responses, and only
    // one of them is an emergency.
    expect(classifyOutcome({ observed: undefined, expectation: expectRefusal, threw: true })).toBe(
      OUTCOME.ERROR,
    );
  });
});

describe('append-only assertions', () => {
  it('is meaningless when no row existed to mutate', () => {
    // An UPDATE matching zero rows succeeds: the row-level trigger never fires. Step 1
    // reported PASS from exactly this and had certified nothing.
    expect(
      appendOnlyAssertionIsMeaningful({ rowExistedBefore: false, mutationAttempted: true }),
    ).toBe(false);
  });

  it('is meaningless when no mutation was attempted', () => {
    expect(
      appendOnlyAssertionIsMeaningful({ rowExistedBefore: true, mutationAttempted: false }),
    ).toBe(false);
  });

  it('is meaningful when a real row was there and mutation was tried', () => {
    expect(
      appendOnlyAssertionIsMeaningful({ rowExistedBefore: true, mutationAttempted: true }),
    ).toBe(true);
  });
});

describe('tenant-isolation assertions', () => {
  it('is meaningless against a resource that carries no organization', () => {
    // Step 1 scoped `Organization` — the tenant itself, which has no organizationId.
    // Prisma rejected the query, and the check could never have failed honestly.
    expect(
      tenantAssertionIsMeaningful({
        resourceCarriesOrganizationId: false,
        foreignRowExisted: true,
      }),
    ).toBe(false);
  });

  it('is meaningless when the other tenant had no row to leak', () => {
    // Reading nothing proves nothing if there was nothing there to read.
    expect(
      tenantAssertionIsMeaningful({
        resourceCarriesOrganizationId: true,
        foreignRowExisted: false,
      }),
    ).toBe(false);
  });

  it('is meaningful when a foreign row genuinely existed on a tenant-owned model', () => {
    expect(
      tenantAssertionIsMeaningful({ resourceCarriesOrganizationId: true, foreignRowExisted: true }),
    ).toBe(true);
  });
});

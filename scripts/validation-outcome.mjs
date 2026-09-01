/**
 * How a validation check's outcome is classified.
 *
 * Extracted so it can be tested, because the three worst results Step 1 produced were
 * not framework faults — they were the validator reporting confidently about something
 * it had not actually observed. A validator nobody checks is just a second place for
 * bugs to hide, and its bugs are the expensive kind: they say "PASS".
 *
 * Four outcomes, deliberately, because collapsing them is how the false positives
 * happened:
 *
 *   PASS         the control did the expected thing
 *   DENIED       the control refused, and refusal was what was expected
 *   NOT_REACHED  the step never ran, so nothing was observed either way
 *   ERROR        the check itself broke
 *
 * `NOT_REACHED` is the one that matters. Reporting it as a failure is fine; reporting it
 * as ALLOWED — which an earlier version did, printing "THE MAKER APPROVED THEIR OWN
 * REQUEST" about a step that never executed — is worse than saying nothing.
 */

export const OUTCOME = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_REACHED: 'NOT_REACHED',
  ERROR: 'ERROR',
});

/**
 * Classifies what was observed.
 *
 * `observed` is undefined or null when the step never ran. That is not a failure of the
 * control — it is an absence of evidence, and the two must not be reported the same way.
 */
export function classifyOutcome({ observed, expectation, threw }) {
  if (threw) return OUTCOME.ERROR;
  if (observed === undefined || observed === null) return OUTCOME.NOT_REACHED;
  return expectation(observed) ? OUTCOME.PASS : OUTCOME.FAIL;
}

/**
 * Whether an append-only assertion is meaningful.
 *
 * An `UPDATE` matching zero rows succeeds trivially: a row-level trigger never fires, so
 * nothing was tested. A validator that reported PASS from that would be certifying an
 * audit guarantee it never exercised — which Step 1 did.
 */
export function appendOnlyAssertionIsMeaningful({ rowExistedBefore, mutationAttempted }) {
  return Boolean(rowExistedBefore) && Boolean(mutationAttempted);
}

/**
 * Whether a tenant-isolation assertion is meaningful.
 *
 * The resource has to *carry* tenant ownership. Scoping a model with no
 * `organizationId` — `Organization` itself, for instance — cannot demonstrate isolation,
 * and Step 1 tried exactly that.
 */
export function tenantAssertionIsMeaningful({ resourceCarriesOrganizationId, foreignRowExisted }) {
  return Boolean(resourceCarriesOrganizationId) && Boolean(foreignRowExisted);
}

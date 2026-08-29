import { describe, expect, it } from 'vitest';
import {
  NO_APPLICATION_EVIDENCE,
  validationStatusFor,
  type ApplicationEvidenceIndex,
} from './application-evidence';
import { CONSOLE_TEMPLATES } from './consoles';

/*
 * The rule these protect is one sentence: a validation status is a measurement, not a
 * claim. Every test here is a way that stops being true.
 */

const DEV_PASS: ApplicationEvidenceIndex = {
  'approval-workbench': {
    appId: 'approval-workbench',
    status: 'pass',
    environment: 'dev',
    suite: 'npm run validate:approval-workbench',
    commit: 'abc123',
    validatedAt: '2026-08-29T10:00:00.000Z',
    checks: { total: 33, passed: 33, failed: 0 },
    evidenceRef: 'docs/validation/approval-workbench-latest.json',
  },
};

describe('validation status from evidence', () => {
  it('reports not_tested when nothing has been validated', () => {
    expect(validationStatusFor('approval-workbench', NO_APPLICATION_EVIDENCE)).toBe('not_tested');
  });

  it('reports the measured status for the environment it was measured in', () => {
    expect(validationStatusFor('approval-workbench', DEV_PASS, 'dev')).toBe('pass');
  });

  it('does not carry a DEV result into another environment', () => {
    // A pass in DEV is a pass in DEV. Promotion is a decision somebody makes, not a
    // side effect of asking the catalog a question while pointed at production.
    expect(validationStatusFor('approval-workbench', DEV_PASS, 'prod')).toBe('not_tested');
    expect(validationStatusFor('approval-workbench', DEV_PASS, 'uat')).toBe('not_tested');
  });

  it('reports not_tested for an application with no record', () => {
    expect(validationStatusFor('case-management', DEV_PASS, 'dev')).toBe('not_tested');
  });

  it('carries a failure rather than falling back to not_tested', () => {
    // Stale green is worse than red: a failed run must not read as "never tested".
    const failed: ApplicationEvidenceIndex = {
      'approval-workbench': { ...DEV_PASS['approval-workbench']!, status: 'fail' },
    };

    expect(validationStatusFor('approval-workbench', failed, 'dev')).toBe('fail');
  });
});

describe('validation does not promote lifecycle', () => {
  it('ships every console template as draft, whatever the template asks for', () => {
    /*
     * A passing suite is evidence that an application works, not authority to release
     * it. The guarantee lives in `console_`, which sets `lifecycleStatus: 'draft'` after
     * spreading its input — so a template cannot promote itself, and neither can a
     * validation run.
     *
     * Asserting only that the Approval Workbench is draft would be vacuous: it is draft
     * because everything is, and the assertion would still pass if the workbench were
     * promoted through some other route. Checking every template makes the invariant the
     * subject, and moving that line above the spread fails this.
     */
    const promoted = CONSOLE_TEMPLATES.map((entry) => ({
      id: entry.id,
      lifecycle: entry.build().lifecycleStatus,
    })).filter((entry) => entry.lifecycle !== 'draft');

    expect(promoted).toEqual([]);
    expect(CONSOLE_TEMPLATES.length).toBeGreaterThan(5);
  });
});

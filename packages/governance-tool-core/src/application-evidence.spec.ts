import { describe, expect, it } from 'vitest';
import {
  NO_APPLICATION_EVIDENCE,
  validationStatusFor,
  type ApplicationEvidenceIndex,
} from './application-evidence';
import { CONSOLE_TEMPLATES } from './consoles';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORDED_APPLICATION_EVIDENCE } from './recorded-evidence';

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

describe('the evidence that actually ships', () => {
  /*
   * The bug these exist for: evidence was read at startup from a docs/ file, and the
   * runtime image copies packages/, apps/, node_modules and package.json — not docs/.
   * So the file was never present in any deployed environment and every application
   * reported not_tested. It failed safe, which is the only reason it was not misleading,
   * and it meant the feature did nothing where it mattered.
   */
  it('is a module, so it ships wherever the application ships', () => {
    // Importing it at all is the assertion: a module resolves through the package,
    // a docs file resolves through a filesystem that may not contain it.
    expect(RECORDED_APPLICATION_EVIDENCE).toBeDefined();
    expect(typeof RECORDED_APPLICATION_EVIDENCE).toBe('object');
  });

  it('cannot be mutated by whatever reads it', () => {
    expect(Object.isFrozen(RECORDED_APPLICATION_EVIDENCE)).toBe(true);
  });

  it('carries provenance on every record, not just a verdict', () => {
    /*
     * A bare status invites belief. The commit and suite let somebody re-run the thing
     * that produced it, which is the difference between evidence and a claim.
     */
    for (const [appId, record] of Object.entries(RECORDED_APPLICATION_EVIDENCE)) {
      expect(record.appId, appId).toBe(appId);
      expect(record.commit, appId).toMatch(/^[0-9a-f]{40}$/);
      expect(record.suite, appId).toBeTruthy();
      expect(record.environment, appId).toBeTruthy();
      expect(Number.isNaN(Date.parse(record.validatedAt)), appId).toBe(false);
    }
  });

  it('never records a pass whose own counts disagree with it', () => {
    // A record saying `pass` with failures in it would be a status that survived the
    // thing it summarises.
    for (const [appId, record] of Object.entries(RECORDED_APPLICATION_EVIDENCE)) {
      if (record.status === 'pass') {
        expect(record.checks.failed, appId).toBe(0);
        expect(record.checks.passed, appId).toBe(record.checks.total);
        expect(record.checks.total, appId).toBeGreaterThan(0);
      }
    }
  });

  it('resolves through the same environment rule as everything else', () => {
    const record = RECORDED_APPLICATION_EVIDENCE['approval-workbench'];
    expect(record).toBeDefined();

    expect(
      validationStatusFor('approval-workbench', RECORDED_APPLICATION_EVIDENCE, record!.environment),
    ).toBe(record!.status);
    expect(validationStatusFor('approval-workbench', RECORDED_APPLICATION_EVIDENCE, 'prod')).toBe(
      'not_tested',
    );
  });
});

describe('TOS-014 — the artifact reaches the runtime', () => {
  /*
   * The defect, restated so the test is legible without the finding open beside it:
   *
   * validation status was resolved at startup from docs/validation/application-evidence.json.
   * The runtime image copies node_modules, packages, apps and package.json. It does not
   * copy docs. So the file was absent in every deployed environment, the catalog reported
   * not_tested for everything, and the feature did nothing precisely where it was for.
   *
   * These assert the packaging boundary rather than the happy path, because the happy
   * path never broke — it worked perfectly on a developer machine, which is why it
   * survived review.
   */
  const packageRoot = join(__dirname, '..');

  it('is compiled into the package that the runtime image copies', () => {
    /*
     * The Dockerfile copies packages/ wholesale, so "is it in dist" is the packaging
     * question. Deleting the artifact, or moving it back to docs/, fails here.
     */
    const compiled = join(packageRoot, 'dist', 'recorded-evidence.js');

    expect(
      existsSync(compiled),
      'recorded-evidence must be compiled into dist/ — the runtime image copies packages/, not docs/',
    ).toBe(true);

    // And it must actually carry the evidence, not merely exist.
    expect(readFileSync(compiled, 'utf8')).toContain('RECORDED_APPLICATION_EVIDENCE');
  });

  it('is published by the package, so a consumer gets it too', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      files?: string[];
    };

    expect(manifest.files ?? []).toContain('dist');
  });

  it('does not resolve through docs/, which the runtime cannot see', () => {
    /*
     * A guard against the fix being quietly undone. If somebody reintroduces a read of
     * the documentation tree, this is the test that objects — the runtime has no docs/,
     * and a status that depends on one is a status that is absent when deployed.
     */
    const source = readFileSync(join(__dirname, 'recorded-evidence.ts'), 'utf8');

    expect(source).not.toMatch(/readFileSync|require\(|process\.cwd\(\)/);
    expect(source).not.toMatch(/docs\/validation\/application-evidence\.json/);
  });
});

describe('TOS-014 — nothing accidental produces a pass', () => {
  const record = RECORDED_APPLICATION_EVIDENCE['approval-workbench']!;

  it('missing evidence is not_tested', () => {
    expect(validationStatusFor('approval-workbench', {}, 'dev')).toBe('not_tested');
  });

  it('an unknown application is not_tested, even where evidence exists', () => {
    expect(validationStatusFor('case-management', RECORDED_APPLICATION_EVIDENCE, 'dev')).toBe(
      'not_tested',
    );
  });

  it('an unknown environment is not_tested', () => {
    expect(
      validationStatusFor('approval-workbench', RECORDED_APPLICATION_EVIDENCE, 'staging'),
    ).toBe('not_tested');
  });

  it('DEV evidence does not answer for UAT or PROD', () => {
    for (const environment of ['uat', 'prod', 'production']) {
      expect(
        validationStatusFor('approval-workbench', RECORDED_APPLICATION_EVIDENCE, environment),
        environment,
      ).toBe('not_tested');
    }
  });

  it('failed evidence reports fail, not not_tested and not pass', () => {
    // Stale green: a failed run must supersede an earlier pass rather than looking like
    // an absence of testing, which reads as "not yet run" instead of "it broke".
    const failed = { 'approval-workbench': { ...record, status: 'fail' as const } };

    expect(validationStatusFor('approval-workbench', failed, 'dev')).toBe('fail');
  });

  it('partial evidence reports partial', () => {
    const partial = { 'approval-workbench': { ...record, status: 'partial' as const } };

    expect(validationStatusFor('approval-workbench', partial, 'dev')).toBe('partial');
  });

  it('malformed evidence does not become a pass', () => {
    /*
     * Whatever arrives — a null, an array, a record with no status — the answer is
     * not_tested. The one thing it must never be is the optimistic reading.
     */
    const malformed: unknown[] = [
      null,
      undefined,
      {},
      { 'approval-workbench': null },
      { 'approval-workbench': {} },
      { 'approval-workbench': { status: 'pass' } }, // no environment
      [],
    ];

    for (const value of malformed) {
      const status = validationStatusFor('approval-workbench', (value ?? {}) as never, 'dev');
      expect(status, JSON.stringify(value)).not.toBe('pass');
    }
  });

  it('carries no credential-shaped value', () => {
    const serialized = JSON.stringify(RECORDED_APPLICATION_EVIDENCE);

    for (const needle of ['secret', 'token', 'password', 'apiKey', 'BEGIN ', 'Bearer ']) {
      expect(serialized.toLowerCase(), needle).not.toContain(needle.toLowerCase());
    }
  });
});

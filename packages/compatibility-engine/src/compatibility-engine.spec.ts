import { describe, expect, it } from 'vitest';
import { CompatibilityMatrix } from '@trustsystem/version-manager';
import { blockingFindings, checkCompatibility, summarize } from './index';

/**
 * Every failure here is a *pair*: the framework moved and the module did not, the schema migrated
 * and the CLI did not, a client is ahead of its server. Checking each surface alone finds none of
 * them, because each one is individually fine.
 */

describe('modules', () => {
  it('fails a module needing a newer framework', () => {
    const report = checkCompatibility({
      frameworkVersion: '0.4.0',
      modules: [{ id: 'search', version: '1.0.0', minimumFrameworkVersion: '0.5.0' }],
    });

    expect(report.ok).toBe(false);
    expect(blockingFindings(report)[0]?.detail).toMatch(/needs framework 0\.5\.0 or newer/);
  });

  it('warns on a declared-but-unverified pairing rather than failing', () => {
    /*
     * Refusing every module that has not been matrix-tested would make the framework unusable on
     * the day it releases. The declaration is real evidence, just weaker than a recorded test.
     */
    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      modules: [{ id: 'search', version: '1.0.0', minimumFrameworkVersion: '0.4.0' }],
    });

    expect(report.ok).toBe(true);
    expect(report.hasUnknowns).toBe(true);
    expect(report.findings[0]?.severity).toBe('warning');
  });

  it('fails a pairing recorded as incompatible even when the declaration is satisfied', () => {
    const matrix = new CompatibilityMatrix([
      {
        subject: 'module',
        id: 'search',
        subjectRange: '^1.0.0',
        frameworkRange: '^0.5.0',
        verdict: 'incompatible',
        note: 'The audit sink contract changed.',
      },
    ]);

    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      modules: [{ id: 'search', version: '1.0.0', minimumFrameworkVersion: '0.4.0' }],
      matrix,
    });

    expect(report.ok).toBe(false);
    expect(blockingFindings(report)[0]?.detail).toMatch(/audit sink contract changed/);
  });
});

describe('the CLI', () => {
  it('accepts a CLI ahead of the framework', () => {
    // Tools lead.
    const report = checkCompatibility({ frameworkVersion: '0.4.0', cliVersion: '0.5.0' });

    expect(report.findings[0]?.severity).toBe('ok');
  });

  it('warns when the CLI is behind by a minor', () => {
    const report = checkCompatibility({ frameworkVersion: '0.5.2', cliVersion: '0.5.0' });

    expect(report.findings[0]?.severity).toBe('warning');
    expect(report.findings[0]?.remediation).toMatch(/ignoring the fields it does not know/);
  });

  it('fails when the CLI is a major behind', () => {
    const report = checkCompatibility({ frameworkVersion: '0.5.0', cliVersion: '0.4.0' });

    expect(report.ok).toBe(false);
  });
});

describe('the database', () => {
  it('accepts a supported engine at or above the floor', () => {
    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      database: { engine: 'postgresql', version: '16.2.0' },
    });

    expect(report.ok).toBe(true);
  });

  it('fails below the floor and on an unsupported engine', () => {
    expect(
      checkCompatibility({
        frameworkVersion: '0.5.0',
        database: { engine: 'postgresql', version: '13.0.0' },
      }).ok,
    ).toBe(false);

    const other = checkCompatibility({
      frameworkVersion: '0.5.0',
      database: { engine: 'mysql', version: '8.0.0' },
    });

    expect(other.ok).toBe(false);
    expect(blockingFindings(other)[0]?.remediation).toMatch(/no portable equivalent/);
  });
});

describe('the API contract', () => {
  it('fails a client ahead of its server', () => {
    // It calls endpoints that do not exist yet.
    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      apiVersion: { client: '2.0.0', server: '1.0.0' },
    });

    expect(report.ok).toBe(false);
    expect(blockingFindings(report)[0]?.remediation).toMatch(/Deploy the server first/);
  });

  it('accepts a client behind within the same major', () => {
    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      apiVersion: { client: '1.2.0', server: '1.5.0' },
    });

    expect(report.ok).toBe(true);
  });

  it('fails a client a major behind', () => {
    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      apiVersion: { client: '1.0.0', server: '2.0.0' },
    });

    expect(report.ok).toBe(false);
  });
});

describe('templates', () => {
  it('does not nag about a generated project whose template moved on', () => {
    /*
     * Nothing generated has a runtime dependency on its template. Telling somebody their year-old
     * project is "out of date" every time they run a check is how the check gets muted.
     */
    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      templates: [{ id: 'crm', version: '0.1.0', minimumFrameworkVersion: '0.1.0' }],
    });

    expect(report.findings[0]?.severity).toBe('ok');
  });
});

describe('summaries', () => {
  it('leads with the count that blocks', () => {
    const report = checkCompatibility({
      frameworkVersion: '0.4.0',
      modules: [{ id: 'a', version: '1.0.0', minimumFrameworkVersion: '0.9.0' }],
    });

    expect(summarize(report)).toMatch(/1 incompatibility/);
  });

  it('says how many pairings are unverified when everything passes', () => {
    const report = checkCompatibility({
      frameworkVersion: '0.5.0',
      modules: [{ id: 'a', version: '1.0.0', minimumFrameworkVersion: '0.4.0' }],
    });

    expect(summarize(report)).toMatch(/1 unverified pairing/);
  });
});

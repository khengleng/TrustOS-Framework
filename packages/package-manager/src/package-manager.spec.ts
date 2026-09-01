import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import {
  applyPlan,
  assertIntegrity,
  emptyLockfile,
  outdated,
  parseLockfile,
  planInstall,
  planRemove,
  rollback,
  verifyLockfile,
  type AvailablePackage,
  type Lockfile,
} from './index';

const NOW = new Date('2026-07-01T00:00:00.000Z');

function detailsOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (error) {
    if (error instanceof ApiError) {
      return [error.message, ...(error.details ?? []).map((detail) => detail.message)].join(' | ');
    }
    return error instanceof Error ? error.message : String(error);
  }
}

const AVAILABLE: AvailablePackage[] = [
  { id: 'core', version: '1.0.0', integrity: 'a'.repeat(64), signedBy: 'release' },
  { id: 'core', version: '1.5.0', integrity: 'b'.repeat(64), signedBy: 'release' },
  { id: 'core', version: '2.0.0', integrity: 'c'.repeat(64), signedBy: 'release' },
  {
    id: 'reporting',
    version: '1.0.0',
    integrity: 'd'.repeat(64),
    signedBy: 'release',
    dependencies: [{ moduleId: 'core', versionRange: '^1.0.0' }],
  },
  { id: 'unsigned-thing', version: '1.0.0', integrity: 'e'.repeat(64), signedBy: null },
];

const base = (): Lockfile => emptyLockfile('0.5.0', NOW);

describe('planning an install', () => {
  it('picks the highest satisfying version, not the lowest', () => {
    /*
     * A range says "anything from here up to the boundary". Picking the bottom installs the oldest
     * acceptable version, which is the one with the security fixes missing.
     */
    const plan = planInstall(
      { id: 'core', versionRange: '^1.0.0' },
      { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0' },
    );

    expect(plan.steps[0]).toMatchObject({ id: 'core', toVersion: '1.5.0', action: 'install' });
  });

  it('pulls in dependencies and says why each is there', () => {
    const plan = planInstall(
      { id: 'reporting' },
      { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0' },
    );

    expect(plan.steps.map((step) => [step.id, step.reason])).toEqual([
      ['reporting', 'requested'],
      ['core', 'required by reporting'],
    ]);
  });

  it('refuses something it cannot find rather than reaching for it', () => {
    // The installer never fetches. That is what makes an air-gapped install the same operation
    // as a connected one.
    const plan = planInstall(
      { id: 'nowhere' },
      { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0' },
    );

    expect(plan.ok).toBe(false);
    expect(plan.conflicts[0]).toMatch(/not available offline. The installer never fetches/);
  });

  it('refuses a package that needs a newer framework', () => {
    const plan = planInstall(
      { id: 'core' },
      {
        lockfile: base(),
        available: [{ ...AVAILABLE[0]!, minimumFrameworkVersion: '0.9.0' }],
        frameworkVersion: '0.5.0',
      },
    );

    expect(plan.conflicts[0]).toMatch(/needs framework 0\.9\.0 or newer/);
  });

  it('warns about an unsigned package without refusing it', () => {
    const plan = planInstall(
      { id: 'unsigned-thing' },
      { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0' },
    );

    expect(plan.ok).toBe(true);
    expect(plan.warnings).toEqual(['unsigned-thing@1.0.0 is unsigned.']);
  });

  it('reports an unsatisfiable conflict rather than backtracking to some solution', () => {
    /*
     * Backtracking picks a solution nobody chose — usually a downgrade of a package that was
     * working, to satisfy one that was just added.
     */
    const lockfile: Lockfile = {
      ...base(),
      packages: [
        {
          id: 'core',
          version: '2.0.0',
          integrity: 'c'.repeat(64),
          signedBy: 'release',
          requiredBy: [],
          installedAt: NOW.toISOString(),
        },
      ],
    };

    const plan = planInstall(
      { id: 'reporting' },
      { lockfile, available: AVAILABLE, frameworkVersion: '0.5.0' },
    );

    expect(plan.ok).toBe(false);
    expect(plan.conflicts.join(' ')).toMatch(/No single version satisfies everything/);
  });

  it('marks an already-current package unchanged', () => {
    const applied = applyPlan(
      planInstall(
        { id: 'core', versionRange: '1.0.0' },
        { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0' },
      ),
      { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0', now: NOW },
    );

    const second = planInstall(
      { id: 'core', versionRange: '1.0.0' },
      { lockfile: applied.lockfile, available: AVAILABLE, frameworkVersion: '0.5.0' },
    );

    expect(second.steps[0]?.action).toBe('unchanged');
  });
});

describe('applying a plan', () => {
  it('refuses a plan with conflicts rather than applying the part that works', () => {
    // A half-applied plan leaves a deployment in a state no lockfile describes.
    const plan = planInstall(
      { id: 'nowhere' },
      { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0' },
    );

    expect(
      detailsOf(() =>
        applyPlan(plan, {
          lockfile: base(),
          available: AVAILABLE,
          frameworkVersion: '0.5.0',
          now: NOW,
        }),
      ),
    ).toMatch(/Refusing to apply a plan with 1 conflict/);
  });

  it('records what was installed, with its digest and signer', () => {
    const options = { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0', now: NOW };
    const result = applyPlan(planInstall({ id: 'reporting' }, options), options);

    expect(result.lockfile.packages.map((entry) => entry.id)).toEqual(['core', 'reporting']);
    expect(result.lockfile.packages[0]).toMatchObject({
      signedBy: 'release',
      integrity: 'b'.repeat(64),
    });
  });

  it('fails when the bytes changed since they were locked', () => {
    /*
     * The check a compromised mirror has to defeat, and it runs on a reinstall of something
     * already present — which is exactly when nobody looks.
     */
    const options = { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0', now: NOW };
    const first = applyPlan(planInstall({ id: 'core', versionRange: '1.0.0' }, options), options);

    const second = {
      lockfile: first.lockfile,
      available: AVAILABLE,
      frameworkVersion: '0.5.0',
      now: NOW,
      digests: { 'core@1.0.0': 'f'.repeat(64) },
    };

    expect(
      detailsOf(() =>
        applyPlan(planInstall({ id: 'core', versionRange: '1.0.0' }, second), second),
      ),
    ).toMatch(/Integrity check failed/);
  });

  it('keeps the previous lockfile so a rollback has somewhere to go', () => {
    const options = { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0', now: NOW };
    const result = applyPlan(planInstall({ id: 'core' }, options), options);

    expect(rollback(result.previous, NOW).packages).toEqual([]);
  });
});

describe('removal', () => {
  it('refuses while something depends on it', () => {
    // Cascading takes modules with it that nobody reviewed.
    const options = { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0', now: NOW };
    const installed = applyPlan(planInstall({ id: 'reporting' }, options), options);

    const plan = planRemove('core', {
      lockfile: installed.lockfile,
      available: AVAILABLE,
      frameworkVersion: '0.5.0',
    });

    expect(plan.ok).toBe(false);
    expect(plan.conflicts[0]).toMatch(/reporting depend on it/);
  });

  it('refuses to remove something that is not installed', () => {
    const plan = planRemove('core', {
      lockfile: base(),
      available: AVAILABLE,
      frameworkVersion: '0.5.0',
    });

    expect(plan.conflicts[0]).toBe('"core" is not installed.');
  });
});

describe('the lockfile', () => {
  it('refuses a format written by a newer installer', () => {
    // An older installer must refuse rather than guess at a format it does not know.
    expect(
      detailsOf(() =>
        parseLockfile({
          lockfileVersion: 2,
          frameworkVersion: '1.0.0',
          packages: [],
          generatedAt: 'x',
        }),
      ),
    ).toMatch(/written by a newer installer/);
  });

  it('refuses two entries for one package', () => {
    expect(
      detailsOf(() =>
        parseLockfile({
          lockfileVersion: 1,
          frameworkVersion: '0.5.0',
          generatedAt: '2026-07-01',
          packages: [
            {
              id: 'a',
              version: '1.0.0',
              integrity: 'a'.repeat(64),
              signedBy: null,
              requiredBy: [],
              installedAt: '2026-07-01',
            },
            {
              id: 'a',
              version: '2.0.0',
              integrity: 'b'.repeat(64),
              signedBy: null,
              requiredBy: [],
              installedAt: '2026-07-01',
            },
          ],
        }),
      ),
    ).toMatch(/appears twice/);
  });

  it('refuses an integrity value that is not a digest', () => {
    expect(
      detailsOf(() =>
        parseLockfile({
          lockfileVersion: 1,
          frameworkVersion: '0.5.0',
          generatedAt: '2026-07-01',
          packages: [
            {
              id: 'a',
              version: '1.0.0',
              integrity: 'nope',
              signedBy: null,
              requiredBy: [],
              installedAt: 'x',
            },
          ],
        }),
      ),
    ).toMatch(/hex SHA-256/);
  });

  it('reports every package whose bytes no longer match', () => {
    const options = { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0', now: NOW };
    const installed = applyPlan(planInstall({ id: 'reporting' }, options), options);

    expect(
      verifyLockfile(installed.lockfile, {
        'core@1.5.0': 'b'.repeat(64),
        'reporting@1.0.0': '0'.repeat(64),
      }),
    ).toEqual([{ id: 'reporting', expected: 'd'.repeat(64), actual: '0'.repeat(64) }]);
  });

  it('rejects a digest mismatch directly', () => {
    expect(
      detailsOf(() =>
        assertIntegrity(
          {
            id: 'a',
            version: '1.0.0',
            integrity: 'a'.repeat(64),
            signedBy: null,
            requiredBy: [],
            installedAt: 'x',
          },
          'b'.repeat(64),
        ),
      ),
    ).toMatch(/contents changed since they were locked/);
  });
});

describe('outdated', () => {
  it('lists what has moved on', () => {
    const options = { lockfile: base(), available: AVAILABLE, frameworkVersion: '0.5.0', now: NOW };
    const installed = applyPlan(
      planInstall({ id: 'core', versionRange: '1.0.0' }, options),
      options,
    );

    expect(outdated(installed.lockfile, AVAILABLE)).toEqual([
      { id: 'core', current: '1.0.0', latest: '2.0.0' },
    ]);
  });
});

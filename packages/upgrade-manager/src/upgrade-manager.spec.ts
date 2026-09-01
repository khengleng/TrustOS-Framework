import { describe, expect, it } from 'vitest';
import { migrationSchema, type Migration } from '@trustsystem/migration-tools';
import { ReleaseManager } from '@trustsystem/release-manager';
import { VersionHistory } from '@trustsystem/version-manager';
import {
  executeUpgrade,
  planUpgrade,
  recommendTarget,
  renderReport,
  type UpgradeExecutor,
} from './index';

const NOW = new Date('2026-07-01T00:00:00.000Z');

const releases = new ReleaseManager([
  {
    version: '0.4.0',
    channel: 'stable',
    releasedAt: '2026-03-01',
    securitySupportUntil: '2026-06-01',
  },
  {
    version: '0.5.0',
    channel: 'stable',
    releasedAt: '2026-06-01',
    notes: 'Includes a security fix.',
  },
]);

const history = new VersionHistory([
  {
    version: '0.5.0',
    releasedAt: '2026-06-01',
    summary: 'Platform.',
    breakingChanges: ['`Foo.bar` renamed.'],
  },
]);

const migration = (overrides: Record<string, unknown> = {}): Migration =>
  migrationSchema.parse({
    id: '20260601000000_platform',
    kind: 'database',
    description: 'Adds the platform tables.',
    targetVersion: '0.5.0',
    ...overrides,
  });

const request = (overrides: Record<string, unknown> = {}) => ({
  fromVersion: '0.4.0',
  toVersion: '0.5.0',
  modules: [],
  migrations: [migration()],
  compatibility: {},
  releases,
  history,
  now: NOW,
  ...overrides,
});

describe('the preflight', () => {
  it('refuses a downgrade outright', () => {
    // There is no plan for a downgrade — migrations run forward.
    expect(() => planUpgrade(request({ fromVersion: '0.5.0', toVersion: '0.4.0' }))).toThrow(
      /Downgrade refused/,
    );
  });

  it('refuses an unregistered target', () => {
    const plan = planUpgrade(request({ toVersion: '0.9.0', migrations: [] }));

    expect(plan.canProceed).toBe(false);
    expect(plan.preflight.find((f) => f.check === 'release')?.detail).toMatch(
      /not in the release register/,
    );
  });

  it('refuses a withdrawn target', () => {
    const withdrawn = new ReleaseManager([
      { version: '0.4.0', channel: 'stable', releasedAt: '2026-03-01' },
      { version: '0.5.0', channel: 'stable', releasedAt: '2026-06-01' },
    ]);
    withdrawn.withdraw('0.5.0', 'Data loss on upgrade.');

    const plan = planUpgrade(request({ releases: withdrawn, migrations: [] }));

    expect(plan.canProceed).toBe(false);
    expect(plan.preflight.find((f) => f.check === 'release')?.detail).toMatch(
      /Data loss on upgrade/,
    );
  });

  it('warns rather than blocks when the current version is out of support', () => {
    /*
     * Being out of support is the *reason* to upgrade. Blocking on it would trap exactly the
     * deployments that most need to move.
     */
    const plan = planUpgrade(request({ migrations: [] }));

    expect(plan.canProceed).toBe(true);
    expect(plan.preflight.find((f) => f.check === 'support')?.detail).toMatch(
      /overdue rather than optional/,
    );
  });

  it('checks compatibility against the target, not the current version', () => {
    // The question is whether things work after the upgrade, not whether they work now.
    const plan = planUpgrade(
      request({
        migrations: [],
        compatibility: {
          modules: [{ id: 'legacy', version: '1.0.0', minimumFrameworkVersion: '0.9.0' }],
        },
      }),
    );

    expect(plan.canProceed).toBe(false);
    expect(plan.compatibility.frameworkVersion).toBe('0.5.0');
  });

  it('demands a backup for a destructive plan', () => {
    const plan = planUpgrade(request({ migrations: [migration({ destructive: true })] }));

    expect(plan.backupRequired).toBe(true);
    expect(plan.canProceed).toBe(false);
    expect(plan.preflight.find((f) => f.check === 'backup')?.detail).toMatch(/cannot be reversed/);
  });

  it('proceeds once a backup is recorded', () => {
    const plan = planUpgrade(
      request({
        migrations: [migration({ destructive: true })],
        backup: {
          id: 'b1',
          takenAt: '2026-07-01',
          includes: ['database'],
          location: '/backups/b1',
        },
      }),
    );

    expect(plan.canProceed).toBe(true);
  });

  it('surfaces the breaking changes an upgrade would cross', () => {
    const plan = planUpgrade(request({ migrations: [] }));

    expect(plan.breakingChanges).toEqual([{ version: '0.5.0', change: '`Foo.bar` renamed.' }]);
  });

  it('decides the rollback strategy before starting', () => {
    /*
     * Deciding it at failure time, with a half-migrated database, is deciding it under the worst
     * possible conditions.
     */
    expect(
      planUpgrade(request({ migrations: [migration({ destructive: true })] })).rollback.strategy,
    ).toBe('restore');
    expect(
      planUpgrade(request({ migrations: [migration({ kind: 'config', reversible: true })] }))
        .rollback.strategy,
    ).toBe('reverse');
  });
});

describe('recommending a target', () => {
  it('raises urgency when the current version is out of support', () => {
    const recommendation = recommendTarget({ current: '0.4.0', releases, now: NOW });

    expect(recommendation.to).toBe('0.5.0');
    expect(recommendation.urgency).toBe('required');
  });
});

describe('execution', () => {
  function executor(
    overrides: Partial<UpgradeExecutor> = {},
  ): UpgradeExecutor & { calls: string[] } {
    const calls: string[] = [];

    return {
      calls,
      async backup() {
        calls.push('backup');
        return { id: 'b1', takenAt: NOW.toISOString(), includes: ['database'], location: '/b1' };
      },
      async runMigration(migration) {
        calls.push(`run:${migration.id}`);
      },
      async reverseMigration(migration) {
        calls.push(`reverse:${migration.id}`);
      },
      async validate() {
        calls.push('validate');
        return { ok: true, detail: 'Healthy.' };
      },
      async restore() {
        calls.push('restore');
      },
      ...overrides,
    };
  }

  it('refuses a plan that cannot proceed rather than trying', () => {
    const plan = planUpgrade(request({ migrations: [migration({ destructive: true })] }));

    return expect(executeUpgrade(plan, executor(), { now: () => NOW })).rejects.toThrow(
      /Refusing to execute/,
    );
  });

  it('runs backup, migrations and validation in order', async () => {
    const plan = planUpgrade(
      request({
        migrations: [migration({ destructive: true })],
        backup: { id: 'b0', takenAt: '2026-07-01', includes: ['database'], location: '/b0' },
      }),
    );

    const runner = executor();
    const report = await executeUpgrade(plan, runner, { now: () => NOW });

    expect(runner.calls).toEqual(['backup', 'run:20260601000000_platform', 'validate']);
    expect(report.succeeded).toBe(true);
  });

  it('reverses when every applied migration was reversible', async () => {
    const plan = planUpgrade(
      request({ migrations: [migration({ kind: 'config', reversible: true })] }),
    );

    const runner = executor({
      async validate() {
        return { ok: false, detail: 'Health check failed.' };
      },
    });

    const report = await executeUpgrade(plan, runner, { now: () => NOW });

    expect(report.succeeded).toBe(false);
    expect(report.rolledBack).toBe(true);
    expect(runner.calls).toContain('reverse:20260601000000_platform');
  });

  it('restores when anything applied was irreversible', async () => {
    const plan = planUpgrade(
      request({
        migrations: [migration({ destructive: true })],
        backup: { id: 'b0', takenAt: '2026-07-01', includes: ['database'], location: '/b0' },
      }),
    );

    const runner = executor({
      async runMigration() {
        throw new Error('constraint violation');
      },
    });

    const report = await executeUpgrade(plan, runner, { now: () => NOW });

    expect(report.rolledBack).toBe(true);
    expect(runner.calls).toContain('restore');
  });

  it('says plainly when it could not roll back', async () => {
    /*
     * A report that says "rolled back" when nothing was is the worst possible output. This is the
     * case where the system is genuinely stuck between versions.
     */
    const plan = planUpgrade(request({ migrations: [migration({ destructive: false })] }));

    const runner = executor({
      async validate() {
        return { ok: false, detail: 'Broken.' };
      },
    });

    const report = await executeUpgrade(plan, runner, { now: () => NOW });

    expect(report.rolledBack).toBe(false);
    expect(renderReport(report)).toMatch(/was not rolled back and is between versions/);
  });

  it('renders a report naming the breaking changes crossed', async () => {
    const plan = planUpgrade(request({ migrations: [] }));
    const report = await executeUpgrade(plan, executor(), { now: () => NOW });

    expect(renderReport(report)).toMatch(/`Foo\.bar` renamed/);
  });
});

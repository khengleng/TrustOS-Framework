import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import {
  assertBackupTaken,
  describePlan,
  migrationSchema,
  planMigrations,
  planRollback,
} from './index';

const migration = (overrides: Record<string, unknown> = {}) =>
  migrationSchema.parse({
    id: '20260101000000_add_thing',
    kind: 'database',
    description: 'Adds a thing.',
    targetVersion: '0.2.0',
    ...overrides,
  });

describe('declarations', () => {
  it('refuses a destructive migration marked reversible', () => {
    // A dropped column does not come back, and a "down" script that claims otherwise is trusted
    // and wrong.
    expect(() => migration({ reversible: true, destructive: true })).toThrow();
  });

  it('defaults to irreversible', () => {
    /*
     * A migration assumed reversible and then found not to be is discovered during a rollback,
     * which is the worst moment available.
     */
    expect(migration().reversible).toBe(false);
  });

  it('refuses a long database migration marked reversible', () => {
    // Reversing it takes at least as long, during an incident.
    expect(() => migration({ reversible: true, estimatedSeconds: 600 })).toThrow();
  });
});

describe('planning', () => {
  const migrations = [
    migration({ id: '20260101000000_a', targetVersion: '0.2.0', estimatedSeconds: 30 }),
    migration({
      id: '20260201000000_b',
      targetVersion: '0.3.0',
      dependsOn: ['20260101000000_a'],
      destructive: true,
    }),
    migration({ id: '20260301000000_c', targetVersion: '0.4.0', kind: 'config', reversible: true }),
  ];

  it('includes only what the range needs', () => {
    const plan = planMigrations({ migrations, fromVersion: '0.2.0', toVersion: '0.3.0' });

    expect(plan.steps.map((step) => step.migration.id)).toEqual(['20260201000000_b']);
  });

  it('orders by dependency', () => {
    const plan = planMigrations({ migrations, fromVersion: '0.1.0', toVersion: '0.4.0' });

    expect(plan.steps.map((step) => step.migration.id)).toEqual([
      '20260101000000_a',
      '20260201000000_b',
      '20260301000000_c',
    ]);
  });

  it('is deterministic', () => {
    // A migration order that depends on directory listing differs between a laptop and CI.
    const forward = planMigrations({ migrations, fromVersion: '0.1.0', toVersion: '0.4.0' });
    const reversed = planMigrations({
      migrations: [...migrations].reverse(),
      fromVersion: '0.1.0',
      toVersion: '0.4.0',
    });

    expect(forward.steps.map((step) => step.migration.id)).toEqual(
      reversed.steps.map((step) => step.migration.id),
    );
  });

  it('skips what has already been applied', () => {
    const plan = planMigrations({
      migrations,
      fromVersion: '0.1.0',
      toVersion: '0.4.0',
      applied: ['20260101000000_a'],
    });

    expect(plan.steps[0]).toMatchObject({ status: 'skipped', reason: 'already applied' });
  });

  it('reports a dependency that is neither applied nor in range', () => {
    const plan = planMigrations({
      migrations: [migration({ id: '20260101000000_x', dependsOn: ['20250101000000_missing'] })],
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
    });

    expect(plan.problems[0]).toMatch(/neither applied nor in this range/);
  });

  it('reports a cycle', () => {
    const plan = planMigrations({
      migrations: [
        migration({ id: '20260101000000_a', dependsOn: ['20260102000000_b'] }),
        migration({ id: '20260102000000_b', dependsOn: ['20260101000000_a'] }),
      ],
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
    });

    expect(plan.problems.join(' ')).toMatch(/Migration cycle/);
  });

  it('says whether the plan is destructive and how long it takes', () => {
    const plan = planMigrations({ migrations, fromVersion: '0.1.0', toVersion: '0.4.0' });

    expect(plan.destructive).toBe(true);
    expect(plan.fullyReversible).toBe(false);
    expect(describePlan(plan)).toMatch(/rollback means restore/);
  });
});

describe('backups', () => {
  it('refuses a destructive plan with no backup', () => {
    /*
     * Not a warning. The most expensive failure in this phase is a destructive migration run
     * against production with nothing to restore from, and it happens because a warning scrolled
     * past.
     */
    const plan = planMigrations({
      migrations: [migration({ destructive: true })],
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
    });

    expect(() => assertBackupTaken(plan, null)).toThrow(ApiError);
    expect(() => assertBackupTaken(plan, { takenAt: '2026-07-01' })).not.toThrow();
  });

  it('needs no backup for a non-destructive plan', () => {
    const plan = planMigrations({
      migrations: [migration({ reversible: true, kind: 'config' })],
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
    });

    expect(() => assertBackupTaken(plan, null)).not.toThrow();
  });
});

describe('rollback', () => {
  it('reverses in the opposite order when everything is reversible', () => {
    const plan = planMigrations({
      migrations: [
        migration({ id: '20260101000000_a', kind: 'config', reversible: true }),
        migration({
          id: '20260201000000_b',
          kind: 'config',
          reversible: true,
          targetVersion: '0.3.0',
        }),
      ],
      fromVersion: '0.1.0',
      toVersion: '0.3.0',
    });

    const rollback = planRollback(plan);

    expect(rollback.strategy).toBe('reverse');
    expect(rollback.reversible.map((step) => step.migration.id)).toEqual([
      '20260201000000_b',
      '20260101000000_a',
    ]);
  });

  it('needs a restore when anything is irreversible', () => {
    const plan = planMigrations({
      migrations: [migration({ destructive: true })],
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
    });

    expect(planRollback(plan).strategy).toBe('restore');
  });
});

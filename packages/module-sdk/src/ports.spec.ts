import { describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import { HealthRegistry } from '@trustsystem/observability';
import type { ModuleAuditPort } from './context';
import { alwaysHealthy, moduleHealthIndicator } from './health';

/**
 * Port compatibility.
 *
 * The SDK declares a deliberately narrow `ModuleAuditPort` instead of importing
 * `AuditService`, so a module can be tested with a two-line fake and does not
 * drag a Prisma client into its dependency graph. That only holds while the real
 * service still satisfies the port — which is what this file checks, so the
 * narrowing cannot rot into an incompatibility discovered at wiring time.
 */

describe('ModuleAuditPort', () => {
  it('is satisfied by the framework AuditService', async () => {
    const sink = new InMemoryAuditSink();
    const service = new AuditService({ sink });

    // The assignment is the assertion: it fails to compile if the shapes drift.
    const port: ModuleAuditPort = service;

    await port.record({
      action: 'demo.thing.created',
      entityType: 'Thing',
      entityId: 'thing_1',
      organizationId: 'org_acme',
      after: { label: 'New' },
    });

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.organizationId).toBe('org_acme');
  });
});

describe('moduleHealthIndicator', () => {
  it('produces an indicator the framework HealthRegistry accepts', async () => {
    const registry = new HealthRegistry({
      service: 'test',
      version: '0.1.0',
      environment: 'test',
    });

    registry.register(alwaysHealthy('demo', 'no external dependency'));
    const report = await registry.readiness();

    expect(report.checks.map((check) => check.name)).toEqual(['module:demo']);
    expect(report.status).toBe('ok');
  });

  it('degrades readiness without failing it, by default', async () => {
    const registry = new HealthRegistry({ service: 'test', version: '0.1.0', environment: 'test' });
    registry.register(
      moduleHealthIndicator('demo', () => Promise.resolve({ status: 'down', detail: 'queue' })),
    );

    const report = await registry.readiness();
    // A broken notification queue must not take the whole instance out of
    // rotation; it must be visible in the report.
    expect(report.status).toBe('degraded');
  });

  it('fails readiness when the module declares itself critical', async () => {
    const registry = new HealthRegistry({ service: 'test', version: '0.1.0', environment: 'test' });
    registry.register(
      moduleHealthIndicator('demo', () => Promise.resolve({ status: 'down' }), { critical: true }),
    );

    expect((await registry.readiness()).status).toBe('down');
  });
});

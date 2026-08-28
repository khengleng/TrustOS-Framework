import { describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import { assertNoLeakedValues, assertSecretFieldsRedacted } from '@trustos/security-testing';
import {
  InMemorySecurityEventSink,
  SecurityEventEmitter,
  severityOf,
  type SecurityEvent,
  type SecurityEventSink,
} from './events';
import { AuditSecurityEventSink, LoggerSecurityEventSink, type AuditPort } from './sinks';

function build(sinks: SecurityEventSink[] = []) {
  const memory = new InMemorySecurityEventSink();
  const lines: Array<{ level: string; payload: Record<string, unknown>; message: string }> = [];

  const logger = {
    info: (payload: Record<string, unknown>, message: string) =>
      void lines.push({ level: 'info', payload, message }),
    warn: (payload: Record<string, unknown>, message: string) =>
      void lines.push({ level: 'warn', payload, message }),
    error: (payload: Record<string, unknown>, message: string) =>
      void lines.push({ level: 'error', payload, message }),
  };

  const emitter = new SecurityEventEmitter({
    sinks: [memory, ...sinks],
    logger,
    application: 'test-app',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    newId: () => 'evt_fixed',
  });

  return { emitter, memory, lines };
}

describe('building an event', () => {
  it('fills in the id, timestamp, application and severity', async () => {
    const { emitter, memory } = build();

    await emitter.emit({ type: 'auth.succeeded', result: 'success' });

    expect(memory.events[0]).toMatchObject({
      id: 'evt_fixed',
      type: 'auth.succeeded',
      severity: 'info',
      application: 'test-app',
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('marks the events that mean an active compromise is likely as critical', () => {
    // Reserved for those, rather than for anything merely unwanted, so an alert on
    // `critical` is worth waking somebody for.
    expect(severityOf('session.refresh_reuse_detected')).toBe('critical');
    expect(severityOf('authz.cross_tenant_blocked')).toBe('critical');
    expect(severityOf('authz.role_escalation_blocked')).toBe('critical');
    expect(severityOf('auth.failed')).toBe('warning');
    expect(severityOf('session.created')).toBe('info');
  });

  it('leaves the actor and organization null when authentication did not succeed', async () => {
    const { emitter, memory } = build();

    // Most security events have neither, and that is the point: a failed login has
    // no actor and no audit record, and it is the most useful record there is.
    await emitter.emit({ type: 'auth.failed', result: 'failure', reason: 'invalid_credentials' });

    expect(memory.events[0]?.actorId).toBe(null);
    expect(memory.events[0]?.organizationId).toBe(null);
  });
});

describe('redaction', () => {
  it('redacts secret-named fields before any sink sees them', async () => {
    const { emitter, memory } = build();

    await emitter.emit({
      type: 'auth.failed',
      result: 'failure',
      context: {
        identifier: 'abc123',
        password: 'hunter2-not-a-real-password',
        nested: { refreshToken: 'refresh-token-value-here' },
      },
    });

    const event = memory.events[0] as SecurityEvent;

    // Redacted once, in the emitter — not in each sink, where one forgetting would
    // be enough.
    assertNoLeakedValues(
      event,
      ['hunter2-not-a-real-password', 'refresh-token-value-here'],
      'the event',
    );
    assertSecretFieldsRedacted(event, 'the event');
    expect(event.context?.identifier).toBe('abc123');
  });

  it('redacts before the event reaches the log as well', async () => {
    const { emitter, lines } = build();

    await emitter.emit({
      type: 'session.refresh_reuse_detected',
      result: 'blocked',
      context: { token: 'the-actual-refresh-token-value' },
    });

    assertNoLeakedValues(lines, ['the-actual-refresh-token-value'], 'the log');
  });
});

describe('sink failure', () => {
  it('never lets a sink failure propagate', async () => {
    const broken: SecurityEventSink = {
      id: 'broken',
      emit: () => {
        throw new Error('event store unreachable');
      },
    };

    const { emitter, memory, lines } = build([broken]);

    // An authentication that succeeds and then 500s because the event store was
    // unreachable is worse than one that succeeds unrecorded.
    await expect(emitter.emit({ type: 'auth.succeeded', result: 'success' })).resolves.toBeTruthy();

    // The working sink still received it, and the failure was logged.
    expect(memory.events).toHaveLength(1);
    expect(lines.some((line) => line.message === 'security event sink failed')).toBe(true);
  });

  it('calls every sink even when an earlier one fails', async () => {
    const order: string[] = [];
    const broken: SecurityEventSink = {
      id: 'broken',
      emit: () => {
        order.push('broken');
        throw new Error('nope');
      },
    };
    const working: SecurityEventSink = { id: 'working', emit: () => void order.push('working') };

    const emitter = new SecurityEventEmitter({ sinks: [broken, working] });
    await emitter.emit({ type: 'auth.succeeded', result: 'success' });

    expect(order).toEqual(['broken', 'working']);
  });

  it('logs a critical event directly, in case a sink is misconfigured', async () => {
    const { emitter, lines } = build();

    await emitter.emit({ type: 'session.refresh_reuse_detected', result: 'blocked' });

    // The application log is the one place an operator is definitely already looking.
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });
});

describe('the in-memory sink', () => {
  it('is bounded, so a long-running process does not leak', () => {
    const sink = new InMemorySecurityEventSink(3);

    for (let index = 0; index < 10; index += 1) {
      sink.emit({
        id: `evt_${index}`,
        type: 'auth.succeeded',
        severity: 'info',
        result: 'success',
        reason: null,
        actorId: null,
        actorType: null,
        organizationId: null,
        ipAddress: null,
        userAgent: null,
        requestId: null,
        application: null,
        provider: null,
        risk: null,
        context: null,
        occurredAt: new Date(),
      });
    }

    expect(sink.events).toHaveLength(3);
    // The oldest are dropped, which are the least useful.
    expect(sink.events[0]?.id).toBe('evt_7');
    expect(sink.recent(2).map((event) => event.id)).toEqual(['evt_9', 'evt_8']);
  });
});

describe('the audit bridge', () => {
  it('is satisfied by the framework AuditService', async () => {
    const auditSink = new InMemoryAuditSink();
    // The assignment is the assertion: it fails to compile if the shapes drift.
    const port: AuditPort = new AuditService({ sink: auditSink });

    const bridge = new AuditSecurityEventSink(port);
    const { emitter } = build([bridge]);

    await emitter.emit({
      type: 'api_key.revoked',
      result: 'success',
      organizationId: 'org_acme',
      actorId: 'user_admin',
      actorType: 'user',
      context: { apiKeyId: 'key_1' },
    });

    expect(auditSink.records[0]).toMatchObject({
      action: 'security.api_key.revoked',
      entityType: 'SecurityEvent',
      organizationId: 'org_acme',
      actorId: 'user_admin',
    });
  });

  it('writes only events an organization should see, and only when it has one', async () => {
    const auditSink = new InMemoryAuditSink();
    const bridge = new AuditSecurityEventSink(new AuditService({ sink: auditSink }));
    const { emitter } = build([bridge]);

    // A failed login for an unknown email has no organization and belongs nowhere
    // near a customer's audit log.
    await emitter.emit({ type: 'auth.failed', result: 'failure' });
    // Nor does perimeter noise that happens to carry one.
    await emitter.emit({
      type: 'abuse.rate_limited',
      result: 'blocked',
      organizationId: 'org_acme',
    });
    // A revoked key does belong in it.
    await emitter.emit({
      type: 'api_key.revoked',
      result: 'success',
      organizationId: 'org_acme',
    });

    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]?.action).toBe('security.api_key.revoked');
  });

  it('prefixes the action, so its origin is visible in the trail', async () => {
    const auditSink = new InMemoryAuditSink();
    const bridge = new AuditSecurityEventSink(new AuditService({ sink: auditSink }));
    const { emitter } = build([bridge]);

    await emitter.emit({
      type: 'authz.role_changed',
      result: 'success',
      organizationId: 'org_acme',
    });

    // A reader can tell a record that originated as a security event from one written
    // by business code.
    expect(auditSink.records[0]?.action.startsWith('security.')).toBe(true);
  });
});

describe('the logging sink', () => {
  it('routes by severity', () => {
    const lines: Array<{ level: string }> = [];
    const logger = {
      info: () => void lines.push({ level: 'info' }),
      warn: () => void lines.push({ level: 'warn' }),
      error: () => void lines.push({ level: 'error' }),
    };

    const sink = new LoggerSecurityEventSink(logger);
    const event = (type: SecurityEvent['type'], severity: SecurityEvent['severity']) =>
      sink.emit({
        id: 'evt',
        type,
        severity,
        result: 'blocked',
        reason: null,
        actorId: null,
        actorType: null,
        organizationId: null,
        ipAddress: null,
        userAgent: null,
        requestId: null,
        application: null,
        provider: null,
        risk: null,
        context: null,
        occurredAt: new Date(),
      });

    event('session.created', 'info');
    event('auth.failed', 'warning');
    event('session.refresh_reuse_detected', 'critical');

    expect(lines.map((line) => line.level)).toEqual(['info', 'warn', 'error']);
  });
});

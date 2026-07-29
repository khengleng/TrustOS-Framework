import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { WidgetsRepository } from './widgets.repository';
import { WidgetsService } from './widgets.service';

/**
 * Tenant isolation tests for a product module.
 *
 * Copy this file alongside your own feature. Every product model that carries
 * `organizationId` owes the codebase these four assertions — the framework
 * guarantees the guard and the query helpers, but only a test proves that
 * *your* service used them.
 */
const ACME = 'org_acme';
const RIVAL = 'org_rival';

describe('WidgetsService tenant isolation', () => {
  let sink: InMemoryAuditSink;
  let widgets: WidgetsService;

  beforeEach(() => {
    sink = new InMemoryAuditSink();
    widgets = new WidgetsService(new WidgetsRepository(), new AuditService({ sink }));
  });

  it('lists only the calling organization widgets', async () => {
    await widgets.create(ACME, 'Acme widget');
    await widgets.create(RIVAL, 'Rival widget');

    expect((await widgets.list(ACME)).map((widget) => widget.name)).toEqual(['Acme widget']);
    expect((await widgets.list(RIVAL)).map((widget) => widget.name)).toEqual(['Rival widget']);
  });

  it('stamps new rows with the calling organization', async () => {
    const widget = await widgets.create(ACME, 'Acme widget');
    expect(widget.organizationId).toBe(ACME);
  });

  it('cannot delete another organization row, and reports not_found', async () => {
    const rivalWidget = await widgets.create(RIVAL, 'Rival widget');

    try {
      await widgets.remove(ACME, rivalWidget.id);
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }

    expect(await widgets.list(RIVAL)).toHaveLength(1);
  });

  it('audits every mutation with the organization attached', async () => {
    const widget = await widgets.create(ACME, 'Acme widget');
    await widgets.remove(ACME, widget.id);

    expect(sink.records.map((record) => record.action)).toEqual([
      'widget.created',
      'widget.deleted',
    ]);
    expect(sink.records.every((record) => record.organizationId === ACME)).toBe(true);
  });

  it('does not audit reads', async () => {
    await widgets.list(ACME);
    expect(sink.records).toHaveLength(0);
  });
});

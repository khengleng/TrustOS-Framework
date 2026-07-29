import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { AUDIT_SERVICE } from '../../tokens';
import { WidgetsRepository, type Widget } from './widgets.repository';

/**
 * Example product service.
 *
 * The shape to copy:
 *   * `organizationId` is a parameter, never ambient state a method reaches for
 *   * mutations are audited; reads are not
 *   * audit records carry before/after, so "who changed what" is answerable
 */
@Injectable()
export class WidgetsService {
  constructor(
    private readonly widgets: WidgetsRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  list(organizationId: string): Promise<Widget[]> {
    return this.widgets.list(organizationId);
  }

  async create(organizationId: string, name: string): Promise<Widget> {
    const widget = await this.widgets.create(organizationId, name);

    await this.audit.record({
      action: 'widget.created',
      entityType: 'Widget',
      entityId: widget.id,
      organizationId,
      after: { name: widget.name },
    });

    return widget;
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const widget = await this.widgets.softDelete(organizationId, id);

    await this.audit.record({
      action: 'widget.deleted',
      entityType: 'Widget',
      entityId: widget.id,
      organizationId,
      before: { name: widget.name, deletedAt: null },
      after: { name: widget.name, deletedAt: widget.deletedAt },
    });
  }
}

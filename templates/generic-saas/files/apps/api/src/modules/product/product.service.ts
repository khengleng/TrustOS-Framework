import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import type { AppPrismaService } from '../../core/prisma.service';
import { AUDIT_SERVICE } from '../../tokens';
import { TenantRepository } from '../../common/tenant-repository';

export interface WorkspaceItemRow {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * WorkspaceItem service — the shape every product service should copy.
 *
 *   * `organizationId` is a parameter, never ambient state a method reaches for
 *   * reads go through the tenant-scoped repository
 *   * every mutation is audited with before/after; reads are not
 */
@Injectable()
export class ProductService {
  private readonly items: TenantRepository<WorkspaceItemRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.items = new TenantRepository<WorkspaceItemRow>(prisma, 'workspaceItem');
  }

  list(): Promise<WorkspaceItemRow[]> {
    return this.items.list();
  }

  findById(id: string, organizationId: string): Promise<WorkspaceItemRow> {
    return this.items.findById(id, organizationId);
  }

  async create(
    input: { name: string; description?: string; status?: WorkspaceItemRow['status'] },
    organizationId: string,
  ): Promise<WorkspaceItemRow> {
    const item = await this.items.create({
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'DRAFT',
    });

    await this.audit.record({
      action: 'workspaceItem.created',
      entityType: 'WorkspaceItem',
      entityId: item.id,
      organizationId,
      after: { name: item.name, status: item.status },
    });

    return item;
  }

  async update(
    id: string,
    input: { name?: string; description?: string; status?: WorkspaceItemRow['status'] },
    organizationId: string,
  ): Promise<WorkspaceItemRow> {
    // Load first so a cross-tenant id fails as not_found before anything is
    // written, and *snapshot* the values immediately: reading them after the
    // update would make the audit record depend on the repository returning a
    // detached object, which is a property no store guarantees.
    const existing = await this.items.findById(id, organizationId);
    const before = {
      name: existing.name,
      description: existing.description,
      status: existing.status,
    };

    const updated = await this.items.update(id, input);
    const after = {
      name: updated.name,
      description: updated.description,
      status: updated.status,
    };

    await this.audit.recordChange({
      action: 'workspaceItem.updated',
      entityType: 'WorkspaceItem',
      entityId: id,
      organizationId,
      before,
      after,
    });

    return updated;
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const existing = await this.items.findById(id, organizationId);
    const before = { name: existing.name, status: existing.status };

    await this.items.softDelete(id);

    await this.audit.record({
      action: 'workspaceItem.deleted',
      entityType: 'WorkspaceItem',
      entityId: id,
      organizationId,
      before,
    });
  }
}

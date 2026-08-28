import { Injectable } from '@nestjs/common';
import { assertTenantMatch } from '@trustos/tenancy';

export interface Widget {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date;
  deletedAt: Date | null;
}

/**
 * Placeholder store for the example product model.
 *
 * It is in-memory so the template runs before you have added a table, but it
 * follows the framework rules exactly, and swapping it for Prisma is a
 * mechanical change:
 *
 *   1. Add the model to your product's Prisma schema — `organizationId`,
 *      `createdAt`, `updatedAt`, `deletedAt`, and `@@index([organizationId])`.
 *   2. Inject `PrismaService` here.
 *   3. Replace the array filtering with a tenant-scoped delegate:
 *
 *        import { scopedDelegate } from '@trustos/tenancy';
 *
 *        private get widgets() {
 *          return scopedDelegate(this.prisma.widget, { model: 'widget' });
 *        }
 *
 *        list()   { return this.widgets.findMany({ where: { deletedAt: null } }); }
 *        create() { return this.widgets.create({ data: { name } }); }
 *
 *      The delegate adds `organizationId` to every query and every write from
 *      the ambient tenant context, so no method here can read or touch another
 *      organization's rows even if a filter is forgotten.
 *
 * Until then, note that every method below takes `organizationId` and filters
 * on it first. That is the rule the tests in `widgets.spec.ts` enforce.
 */
@Injectable()
export class WidgetsRepository {
  private readonly rows: Widget[] = [];
  private sequence = 0;

  async list(organizationId: string): Promise<Widget[]> {
    return this.rows.filter(
      (row) => row.organizationId === organizationId && row.deletedAt === null,
    );
  }

  async create(organizationId: string, name: string): Promise<Widget> {
    this.sequence += 1;
    const widget: Widget = {
      id: `widget_${this.sequence}`,
      organizationId,
      name,
      createdAt: new Date(),
      deletedAt: null,
    };
    this.rows.push(widget);
    return widget;
  }

  async findById(organizationId: string, id: string): Promise<Widget> {
    const row = this.rows.find((candidate) => candidate.id === id && candidate.deletedAt === null);
    // A lookup by primary key cannot carry the tenant filter in the query, so
    // the row is verified after loading. A foreign row reports not_found.
    return assertTenantMatch(row ?? null, organizationId);
  }

  /** Soft delete: the row stays so the audit trail keeps pointing at something. */
  async softDelete(organizationId: string, id: string): Promise<Widget> {
    const widget = await this.findById(organizationId, id);
    widget.deletedAt = new Date();
    return widget;
  }
}

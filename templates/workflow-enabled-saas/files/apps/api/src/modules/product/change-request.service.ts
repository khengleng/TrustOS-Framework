import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '@trustsystem/errors';
import { PrismaService } from '@trustsystem/database';
import { requireOrganizationId, scopedDelegate } from '@trustsystem/tenancy';
import type { BusinessObjectValidator } from '@trustsystem/workflow-runtime';
import type { AppPrismaService } from '../../core/prisma.service';

/**
 * The example business object.
 *
 * The point of this file is the `BusinessObjectValidator` at the bottom. Without one the
 * workflow engine refuses to start an instance in production, because `objectType` and
 * `objectId` would otherwise be strings nobody has checked — and an instance started against
 * a record in another organization puts that record's id into this organization's history,
 * where every participant can read it.
 *
 * `scopedDelegate` is the framework's tenant-scoped Prisma wrapper. Using it rather than the
 * raw client means the organization filter is applied by construction, so a query written in
 * a hurry is still scoped.
 */
@Injectable()
export class ChangeRequestService {
  /*
   * Injected under the framework's `PrismaService` token, typed as the app's own client.
   *
   * They are the same object — `AppModule` registers the app's client under that token — and
   * different types: the framework's knows only the framework models, and `ChangeRequest`
   * lives in this application's schema.
   */
  constructor(@Inject(PrismaService) private readonly prisma: AppPrismaService) {}

  private get scoped() {
    // Reads the tenant scope the middleware opened. Throws when there is none, which is the
    // correct outcome: a query with no organization is a query with no WHERE clause.
    return scopedDelegate(this.prisma.changeRequest);
  }

  async create(input: {
    title: string;
    description?: string;
    amount: number;
    riskRating: 'low' | 'medium' | 'high';
    justification?: string;
    createdById: string;
  }) {
    return this.scoped.create({
      data: {
        organizationId: requireOrganizationId(),
        title: input.title,
        description: input.description ?? '',
        amount: input.amount,
        riskRating: input.riskRating,
        justification: input.justification ?? '',
        createdById: input.createdById,
      },
    });
  }

  async find(id: string) {
    const record = await this.scoped.findFirst({ where: { id, deletedAt: null } });
    // Not found rather than forbidden: a 403 would confirm the record exists in another
    // organization.
    if (!record) throw ApiError.notFound();
    return record;
  }

  async list(input: { page: number; pageSize: number }) {
    const [items, total] = await Promise.all([
      this.scoped.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.scoped.count({ where: { deletedAt: null } }),
    ]);

    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  /**
   * Links a started workflow instance to the request.
   *
   * Called after the engine creates the instance, not before: if the link were written first
   * and the start then failed, the request would reference an instance that does not exist.
   */
  async linkWorkflow(id: string, workflowInstanceId: string) {
    await this.find(id);
    return this.scoped.update({ where: { id }, data: { workflowInstanceId } });
  }

  /**
   * The instance data a workflow reads.
   *
   * Only what the definition's conditions need. Passing the whole record would put fields
   * into workflow history that the definition never reads — and history is the longest-lived
   * record in the system.
   */
  async workflowData(id: string): Promise<Record<string, unknown>> {
    const record = await this.find(id);

    return {
      title: record.title,
      amount: record.amount,
      riskRating: record.riskRating,
      justification: record.justification,
    };
  }
}

/**
 * The validator the engine requires.
 *
 * Registered in `AppModule`. It answers one question — does this object exist *in this
 * organization* — and the answer is a boolean rather than the record, so a caller cannot
 * accidentally use it to read across a tenant boundary.
 */
export function changeRequestValidator(prisma: AppPrismaService): BusinessObjectValidator {
  return {
    objectType: 'ChangeRequest',
    exists: async (input) => {
      const record = await prisma.changeRequest.findFirst({
        // Both conditions, always. The organization is what makes this a tenant check rather
        // than an existence check.
        where: {
          id: input.objectId,
          organizationId: input.organizationId,
          deletedAt: null,
        },
        select: { id: true },
      });

      return record !== null;
    },
  };
}

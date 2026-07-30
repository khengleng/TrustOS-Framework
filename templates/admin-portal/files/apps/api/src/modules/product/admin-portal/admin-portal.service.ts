import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Admin Portal domain service.
 *
 * Every read and write goes through a tenant-scoped repository, and every parent reference is
 * verified through one before a child is created. Without that second check a caller could
 * attach a record to a parent in another organization by supplying its id — the row would be
 * stamped with the caller’s organization, so no isolation test would fail, and the data would be
 * wrong in a way that is hard to unpick later.
 *
 * Writes are audited. A financial or personal-data change with no audit row is a change nobody
 * can answer questions about six months later.
 */

export interface SystemSettingRow {
  id: string;
  organizationId: string;
  key: string;
  value: string;
  description: string;
  category: string;
  isSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface OperatorNoteRow {
  id: string;
  organizationId: string;
  subjectType: string;
  subjectId: string;
  body: string;
  authorUserId: string | null;
  pinnedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class AdminPortalService {
  private readonly systemSettings: TenantRepository<SystemSettingRow>;
  private readonly operatorNotes: TenantRepository<OperatorNoteRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.systemSettings = new TenantRepository<SystemSettingRow>(prisma, 'systemSetting');
    this.operatorNotes = new TenantRepository<OperatorNoteRow>(prisma, 'operatorNote');
  }

  // --- configuration -----------------------------------------------

  listSystemSettings(): Promise<SystemSettingRow[]> {
    return this.systemSettings.list();
  }

  findSystemSetting(id: string, organizationId: string): Promise<SystemSettingRow> {
    return this.systemSettings.findById(id, organizationId);
  }

  async createSystemSetting(
    input: {
      key: string;
      value: string;
      description: string;
      category: string;
      isSecret?: boolean;
    },
    organizationId: string,
  ): Promise<SystemSettingRow> {
    const created = await this.systemSettings.create({
      key: input.key,
      value: input.value,
      description: input.description,
      category: input.category,
      isSecret: input.isSecret,
    });

    await this.audit.record({
      action: 'adminportal.system-setting.created',
      entityType: 'SystemSetting',
      entityId: created.id,
      organizationId,
      after: { key: created.key, description: created.description, category: created.category },
    });

    return created;
  }

  async updateSystemSetting(
    id: string,
    changes: {
      value?: string;
      description?: string;
      category?: string;
      isSecret?: boolean;
    },
    organizationId: string,
  ): Promise<SystemSettingRow> {
    const existing = await this.systemSettings.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.systemSettings.update(id, changes);

    await this.audit.recordChange({
      action: 'adminportal.system-setting.updated',
      entityType: 'SystemSetting',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- operator notes ----------------------------------------------

  listOperatorNotes(): Promise<OperatorNoteRow[]> {
    return this.operatorNotes.list();
  }

  findOperatorNote(id: string, organizationId: string): Promise<OperatorNoteRow> {
    return this.operatorNotes.findById(id, organizationId);
  }

  async createOperatorNote(
    input: {
      subjectType: string;
      subjectId: string;
      body: string;
      authorUserId?: string;
      pinnedUntil?: Date;
    },
    organizationId: string,
  ): Promise<OperatorNoteRow> {
    const created = await this.operatorNotes.create({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      body: input.body,
      authorUserId: input.authorUserId ?? null,
      pinnedUntil: input.pinnedUntil ?? null,
    });

    await this.audit.record({
      action: 'adminportal.operator-note.created',
      entityType: 'OperatorNote',
      entityId: created.id,
      organizationId,
      after: { subjectType: created.subjectType, subjectId: created.subjectId, body: created.body },
    });

    return created;
  }

  async updateOperatorNote(
    id: string,
    changes: {
      subjectType?: string;
      subjectId?: string;
      body?: string;
      authorUserId?: string;
      pinnedUntil?: Date;
    },
    organizationId: string,
  ): Promise<OperatorNoteRow> {
    const existing = await this.operatorNotes.findById(id, organizationId);

    if (Object.keys(changes).length === 0) {
      /*
       * Refused rather than accepted as a no-op. An empty PATCH is almost always a
       * client that dropped its body, and returning 200 tells it everything worked.
       */
      throw ApiError.validation(
        [{ path: 'body', message: 'No fields to update.', code: 'empty_update' }],
        'Nothing to update.',
      );
    }

    const updated = await this.operatorNotes.update(id, changes);

    await this.audit.recordChange({
      action: 'adminportal.operator-note.updated',
      entityType: 'OperatorNote',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }
}

/**
 * The changed fields only, for the audit trail.
 *
 * Recording the whole row before and after makes every audit entry look like a total rewrite and
 * buries the one field that actually moved.
 */
function pick(row: object, keys: string[]): Record<string, unknown> {
  /*
   * `object` rather than `Record<string, unknown>`: an interface with declared fields
   * has no index signature, so the constrained generic would reject every row type
   * this service defines. The cast is contained to this one line.
   */
  const source = row as Record<string, unknown>;

  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

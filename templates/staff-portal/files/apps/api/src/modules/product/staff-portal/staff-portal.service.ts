import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Staff Portal domain service.
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

export interface StaffProfileRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  team: string | null;
  jobTitle: string | null;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface StaffTaskRow {
  id: string;
  organizationId: string;
  assigneeUserId: string;
  title: string;
  detail: string | null;
  workflowTaskId: string | null;
  dueAt: Date | null;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  status: 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface SavedSearchRow {
  id: string;
  organizationId: string;
  ownerUserId: string;
  name: string;
  resourceKey: string;
  filters: Record<string, unknown>;
  isShared: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface StaffNotificationRow {
  id: string;
  organizationId: string;
  recipientUserId: string;
  subject: string;
  body: string;
  href: string | null;
  sentAt: Date;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class StaffPortalService {
  private readonly staffProfiles: TenantRepository<StaffProfileRow>;
  private readonly staffTasks: TenantRepository<StaffTaskRow>;
  private readonly savedSearches: TenantRepository<SavedSearchRow>;
  private readonly staffNotifications: TenantRepository<StaffNotificationRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.staffProfiles = new TenantRepository<StaffProfileRow>(prisma, 'staffProfile');
    this.staffTasks = new TenantRepository<StaffTaskRow>(prisma, 'staffTask');
    this.savedSearches = new TenantRepository<SavedSearchRow>(prisma, 'savedSearch');
    this.staffNotifications = new TenantRepository<StaffNotificationRow>(
      prisma,
      'staffNotification',
    );
  }

  // --- staff -------------------------------------------------------

  listStaffProfiles(): Promise<StaffProfileRow[]> {
    return this.staffProfiles.list();
  }

  findStaffProfile(id: string, organizationId: string): Promise<StaffProfileRow> {
    return this.staffProfiles.findById(id, organizationId);
  }

  async createStaffProfile(
    input: {
      userId: string;
      displayName: string;
      team?: string;
      jobTitle?: string;
      isAvailable?: boolean;
    },
    organizationId: string,
  ): Promise<StaffProfileRow> {
    const created = await this.staffProfiles.create({
      userId: input.userId,
      displayName: input.displayName,
      team: input.team ?? null,
      jobTitle: input.jobTitle ?? null,
      isAvailable: input.isAvailable,
    });

    await this.audit.record({
      action: 'staffportal.staff-profile.created',
      entityType: 'StaffProfile',
      entityId: created.id,
      organizationId,
      after: { userId: created.userId, displayName: created.displayName, team: created.team },
    });

    return created;
  }

  async updateStaffProfile(
    id: string,
    changes: {
      displayName?: string;
      team?: string;
      jobTitle?: string;
      isAvailable?: boolean;
    },
    organizationId: string,
  ): Promise<StaffProfileRow> {
    const existing = await this.staffProfiles.findById(id, organizationId);

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

    const updated = await this.staffProfiles.update(id, changes);

    await this.audit.recordChange({
      action: 'staffportal.staff-profile.updated',
      entityType: 'StaffProfile',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- tasks -------------------------------------------------------

  listStaffTasks(): Promise<StaffTaskRow[]> {
    return this.staffTasks.list();
  }

  findStaffTask(id: string, organizationId: string): Promise<StaffTaskRow> {
    return this.staffTasks.findById(id, organizationId);
  }

  async createStaffTask(
    input: {
      assigneeUserId: string;
      title: string;
      detail?: string;
      workflowTaskId?: string;
      dueAt?: Date;
      priority?: 'LOW' | 'NORMAL' | 'HIGH';
      status?: 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<StaffTaskRow> {
    const created = await this.staffTasks.create({
      assigneeUserId: input.assigneeUserId,
      title: input.title,
      detail: input.detail ?? null,
      workflowTaskId: input.workflowTaskId ?? null,
      dueAt: input.dueAt ?? null,
      priority: input.priority,
      status: input.status,
    });

    await this.audit.record({
      action: 'staffportal.staff-task.created',
      entityType: 'StaffTask',
      entityId: created.id,
      organizationId,
      after: {
        assigneeUserId: created.assigneeUserId,
        title: created.title,
        detail: created.detail,
      },
    });

    return created;
  }

  async updateStaffTask(
    id: string,
    changes: {
      assigneeUserId?: string;
      title?: string;
      detail?: string;
      dueAt?: Date;
      priority?: 'LOW' | 'NORMAL' | 'HIGH';
      status?: 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<StaffTaskRow> {
    const existing = await this.staffTasks.findById(id, organizationId);

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

    const updated = await this.staffTasks.update(id, changes);

    await this.audit.recordChange({
      action: 'staffportal.staff-task.updated',
      entityType: 'StaffTask',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- saved searches ----------------------------------------------

  listSavedSearches(): Promise<SavedSearchRow[]> {
    return this.savedSearches.list();
  }

  findSavedSearch(id: string, organizationId: string): Promise<SavedSearchRow> {
    return this.savedSearches.findById(id, organizationId);
  }

  async createSavedSearch(
    input: {
      ownerUserId: string;
      name: string;
      resourceKey: string;
      filters: Record<string, unknown>;
      isShared?: boolean;
    },
    organizationId: string,
  ): Promise<SavedSearchRow> {
    const created = await this.savedSearches.create({
      ownerUserId: input.ownerUserId,
      name: input.name,
      resourceKey: input.resourceKey,
      filters: input.filters,
      isShared: input.isShared,
    });

    await this.audit.record({
      action: 'staffportal.saved-search.created',
      entityType: 'SavedSearch',
      entityId: created.id,
      organizationId,
      after: {
        ownerUserId: created.ownerUserId,
        name: created.name,
        resourceKey: created.resourceKey,
      },
    });

    return created;
  }

  async updateSavedSearch(
    id: string,
    changes: {
      ownerUserId?: string;
      name?: string;
      resourceKey?: string;
      filters?: Record<string, unknown>;
      isShared?: boolean;
    },
    organizationId: string,
  ): Promise<SavedSearchRow> {
    const existing = await this.savedSearches.findById(id, organizationId);

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

    const updated = await this.savedSearches.update(id, changes);

    await this.audit.recordChange({
      action: 'staffportal.saved-search.updated',
      entityType: 'SavedSearch',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- notifications -----------------------------------------------

  listStaffNotifications(): Promise<StaffNotificationRow[]> {
    return this.staffNotifications.list();
  }

  findStaffNotification(id: string, organizationId: string): Promise<StaffNotificationRow> {
    return this.staffNotifications.findById(id, organizationId);
  }

  async createStaffNotification(
    input: {
      recipientUserId: string;
      subject: string;
      body: string;
      href?: string;
      sentAt: Date;
      readAt?: Date;
    },
    organizationId: string,
  ): Promise<StaffNotificationRow> {
    const created = await this.staffNotifications.create({
      recipientUserId: input.recipientUserId,
      subject: input.subject,
      body: input.body,
      href: input.href ?? null,
      sentAt: input.sentAt,
      readAt: input.readAt ?? null,
    });

    await this.audit.record({
      action: 'staffportal.staff-notification.created',
      entityType: 'StaffNotification',
      entityId: created.id,
      organizationId,
      after: {
        recipientUserId: created.recipientUserId,
        subject: created.subject,
        body: created.body,
      },
    });

    return created;
  }

  async updateStaffNotification(
    id: string,
    changes: {
      recipientUserId?: string;
      subject?: string;
      body?: string;
      href?: string;
      sentAt?: Date;
      readAt?: Date;
    },
    organizationId: string,
  ): Promise<StaffNotificationRow> {
    const existing = await this.staffNotifications.findById(id, organizationId);

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

    const updated = await this.staffNotifications.update(id, changes);

    await this.audit.recordChange({
      action: 'staffportal.staff-notification.updated',
      entityType: 'StaffNotification',
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

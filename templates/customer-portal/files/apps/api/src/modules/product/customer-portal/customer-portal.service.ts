import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Customer Portal domain service.
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

export interface PortalProfileRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PortalDocumentRow {
  id: string;
  organizationId: string;
  ownerUserId: string;
  title: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  category: 'STATEMENT' | 'CONTRACT' | 'INVOICE' | 'IDENTITY' | 'OTHER';
  availableFrom: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PortalNotificationRow {
  id: string;
  organizationId: string;
  recipientUserId: string;
  notificationKey: string;
  subject: string;
  body: string;
  href: string | null;
  sentAt: Date;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface SupportRequestRow {
  id: string;
  organizationId: string;
  requesterUserId: string;
  reference: string;
  subject: string;
  body: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  openedAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class CustomerPortalService {
  private readonly portalProfiles: TenantRepository<PortalProfileRow>;
  private readonly portalDocuments: TenantRepository<PortalDocumentRow>;
  private readonly portalNotifications: TenantRepository<PortalNotificationRow>;
  private readonly supportRequests: TenantRepository<SupportRequestRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.portalProfiles = new TenantRepository<PortalProfileRow>(prisma, 'portalProfile');
    this.portalDocuments = new TenantRepository<PortalDocumentRow>(prisma, 'portalDocument');
    this.portalNotifications = new TenantRepository<PortalNotificationRow>(
      prisma,
      'portalNotification',
    );
    this.supportRequests = new TenantRepository<SupportRequestRow>(prisma, 'supportRequest');
  }

  // --- profiles ----------------------------------------------------

  listPortalProfiles(): Promise<PortalProfileRow[]> {
    return this.portalProfiles.list();
  }

  findPortalProfile(id: string, organizationId: string): Promise<PortalProfileRow> {
    return this.portalProfiles.findById(id, organizationId);
  }

  async createPortalProfile(
    input: {
      userId: string;
      displayName: string;
      email?: string;
      phone?: string;
      locale?: string;
      timezone?: string;
    },
    organizationId: string,
  ): Promise<PortalProfileRow> {
    const created = await this.portalProfiles.create({
      userId: input.userId,
      displayName: input.displayName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      locale: input.locale,
      timezone: input.timezone,
    });

    await this.audit.record({
      action: 'customerportal.portal-profile.created',
      entityType: 'PortalProfile',
      entityId: created.id,
      organizationId,
      after: { userId: created.userId, displayName: created.displayName, locale: created.locale },
    });

    return created;
  }

  async updatePortalProfile(
    id: string,
    changes: {
      displayName?: string;
      email?: string;
      phone?: string;
      locale?: string;
      timezone?: string;
    },
    organizationId: string,
  ): Promise<PortalProfileRow> {
    const existing = await this.portalProfiles.findById(id, organizationId);

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

    const updated = await this.portalProfiles.update(id, changes);

    await this.audit.recordChange({
      action: 'customerportal.portal-profile.updated',
      entityType: 'PortalProfile',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- documents ---------------------------------------------------

  listPortalDocuments(): Promise<PortalDocumentRow[]> {
    return this.portalDocuments.list();
  }

  findPortalDocument(id: string, organizationId: string): Promise<PortalDocumentRow> {
    return this.portalDocuments.findById(id, organizationId);
  }

  async createPortalDocument(
    input: {
      ownerUserId: string;
      title: string;
      storageKey: string;
      contentType: string;
      sizeBytes: number;
      category?: 'STATEMENT' | 'CONTRACT' | 'INVOICE' | 'IDENTITY' | 'OTHER';
      availableFrom: Date;
    },
    organizationId: string,
  ): Promise<PortalDocumentRow> {
    const created = await this.portalDocuments.create({
      ownerUserId: input.ownerUserId,
      title: input.title,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      category: input.category,
      availableFrom: input.availableFrom,
    });

    await this.audit.record({
      action: 'customerportal.portal-document.created',
      entityType: 'PortalDocument',
      entityId: created.id,
      organizationId,
      after: {
        ownerUserId: created.ownerUserId,
        title: created.title,
        contentType: created.contentType,
      },
    });

    return created;
  }

  async updatePortalDocument(
    id: string,
    changes: {
      ownerUserId?: string;
      title?: string;
      contentType?: string;
      sizeBytes?: number;
      category?: 'STATEMENT' | 'CONTRACT' | 'INVOICE' | 'IDENTITY' | 'OTHER';
      availableFrom?: Date;
    },
    organizationId: string,
  ): Promise<PortalDocumentRow> {
    const existing = await this.portalDocuments.findById(id, organizationId);

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

    const updated = await this.portalDocuments.update(id, changes);

    await this.audit.recordChange({
      action: 'customerportal.portal-document.updated',
      entityType: 'PortalDocument',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- notifications -----------------------------------------------

  listPortalNotifications(): Promise<PortalNotificationRow[]> {
    return this.portalNotifications.list();
  }

  findPortalNotification(id: string, organizationId: string): Promise<PortalNotificationRow> {
    return this.portalNotifications.findById(id, organizationId);
  }

  async createPortalNotification(
    input: {
      recipientUserId: string;
      notificationKey: string;
      subject: string;
      body: string;
      href?: string;
      sentAt: Date;
      readAt?: Date;
    },
    organizationId: string,
  ): Promise<PortalNotificationRow> {
    const created = await this.portalNotifications.create({
      recipientUserId: input.recipientUserId,
      notificationKey: input.notificationKey,
      subject: input.subject,
      body: input.body,
      href: input.href ?? null,
      sentAt: input.sentAt,
      readAt: input.readAt ?? null,
    });

    await this.audit.record({
      action: 'customerportal.portal-notification.created',
      entityType: 'PortalNotification',
      entityId: created.id,
      organizationId,
      after: {
        recipientUserId: created.recipientUserId,
        notificationKey: created.notificationKey,
        subject: created.subject,
      },
    });

    return created;
  }

  async updatePortalNotification(
    id: string,
    changes: {
      recipientUserId?: string;
      notificationKey?: string;
      subject?: string;
      body?: string;
      href?: string;
      sentAt?: Date;
      readAt?: Date;
    },
    organizationId: string,
  ): Promise<PortalNotificationRow> {
    const existing = await this.portalNotifications.findById(id, organizationId);

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

    const updated = await this.portalNotifications.update(id, changes);

    await this.audit.recordChange({
      action: 'customerportal.portal-notification.updated',
      entityType: 'PortalNotification',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- support requests --------------------------------------------

  listSupportRequests(): Promise<SupportRequestRow[]> {
    return this.supportRequests.list();
  }

  findSupportRequest(id: string, organizationId: string): Promise<SupportRequestRow> {
    return this.supportRequests.findById(id, organizationId);
  }

  async createSupportRequest(
    input: {
      requesterUserId: string;
      reference: string;
      subject: string;
      body: string;
      status?: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
      openedAt: Date;
      closedAt?: Date;
    },
    organizationId: string,
  ): Promise<SupportRequestRow> {
    const created = await this.supportRequests.create({
      requesterUserId: input.requesterUserId,
      reference: input.reference,
      subject: input.subject,
      body: input.body,
      status: input.status,
      openedAt: input.openedAt,
      closedAt: input.closedAt ?? null,
    });

    await this.audit.record({
      action: 'customerportal.support-request.created',
      entityType: 'SupportRequest',
      entityId: created.id,
      organizationId,
      after: {
        requesterUserId: created.requesterUserId,
        reference: created.reference,
        subject: created.subject,
      },
    });

    return created;
  }

  async updateSupportRequest(
    id: string,
    changes: {
      requesterUserId?: string;
      subject?: string;
      body?: string;
      status?: 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
      openedAt?: Date;
      closedAt?: Date;
    },
    organizationId: string,
  ): Promise<SupportRequestRow> {
    const existing = await this.supportRequests.findById(id, organizationId);

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

    const updated = await this.supportRequests.update(id, changes);

    await this.audit.recordChange({
      action: 'customerportal.support-request.updated',
      entityType: 'SupportRequest',
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

import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Telegram Mini App domain service.
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

export interface MiniAppUserRow {
  id: string;
  organizationId: string;
  platform: 'TELEGRAM' | 'WHATSAPP' | 'MESSENGER';
  platformUserId: string;
  userId: string | null;
  displayName: string;
  languageCode: string;
  status: 'ACTIVE' | 'BLOCKED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MiniAppSessionRow {
  id: string;
  organizationId: string;
  miniAppUserId: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  launchParam: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DeepLinkRow {
  id: string;
  organizationId: string;
  code: string;
  label: string;
  target: string;
  isActive: boolean;
  openCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MenuEntryRow {
  id: string;
  organizationId: string;
  label: string;
  href: string;
  icon: string | null;
  position: number;
  requiredPermission: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MiniAppNotificationSettingRow {
  id: string;
  organizationId: string;
  miniAppUserId: string;
  notificationKey: string;
  muted: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class TelegramMiniappService {
  private readonly miniAppUsers: TenantRepository<MiniAppUserRow>;
  private readonly miniAppSessions: TenantRepository<MiniAppSessionRow>;
  private readonly deepLinks: TenantRepository<DeepLinkRow>;
  private readonly menuEntries: TenantRepository<MenuEntryRow>;
  private readonly miniAppNotificationSettings: TenantRepository<MiniAppNotificationSettingRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.miniAppUsers = new TenantRepository<MiniAppUserRow>(prisma, 'miniAppUser');
    this.miniAppSessions = new TenantRepository<MiniAppSessionRow>(prisma, 'miniAppSession');
    this.deepLinks = new TenantRepository<DeepLinkRow>(prisma, 'deepLink');
    this.menuEntries = new TenantRepository<MenuEntryRow>(prisma, 'menuEntry');
    this.miniAppNotificationSettings = new TenantRepository<MiniAppNotificationSettingRow>(
      prisma,
      'miniAppNotificationSetting',
    );
  }

  // --- users -------------------------------------------------------

  listMiniAppUsers(): Promise<MiniAppUserRow[]> {
    return this.miniAppUsers.list();
  }

  findMiniAppUser(id: string, organizationId: string): Promise<MiniAppUserRow> {
    return this.miniAppUsers.findById(id, organizationId);
  }

  async createMiniAppUser(
    input: {
      platform: 'TELEGRAM' | 'WHATSAPP' | 'MESSENGER';
      platformUserId: string;
      userId?: string;
      displayName: string;
      languageCode?: string;
      status?: 'ACTIVE' | 'BLOCKED';
    },
    organizationId: string,
  ): Promise<MiniAppUserRow> {
    const created = await this.miniAppUsers.create({
      platform: input.platform,
      platformUserId: input.platformUserId,
      userId: input.userId ?? null,
      displayName: input.displayName,
      languageCode: input.languageCode,
      status: input.status,
    });

    await this.audit.record({
      action: 'telegramminiapp.mini-app-user.created',
      entityType: 'MiniAppUser',
      entityId: created.id,
      organizationId,
      after: {
        platform: created.platform,
        platformUserId: created.platformUserId,
        userId: created.userId,
      },
    });

    return created;
  }

  async updateMiniAppUser(
    id: string,
    changes: {
      userId?: string;
      displayName?: string;
      languageCode?: string;
      status?: 'ACTIVE' | 'BLOCKED';
    },
    organizationId: string,
  ): Promise<MiniAppUserRow> {
    const existing = await this.miniAppUsers.findById(id, organizationId);

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

    const updated = await this.miniAppUsers.update(id, changes);

    await this.audit.recordChange({
      action: 'telegramminiapp.mini-app-user.updated',
      entityType: 'MiniAppUser',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- sessions ----------------------------------------------------

  listMiniAppSessions(): Promise<MiniAppSessionRow[]> {
    return this.miniAppSessions.list();
  }

  findMiniAppSession(id: string, organizationId: string): Promise<MiniAppSessionRow> {
    return this.miniAppSessions.findById(id, organizationId);
  }

  async createMiniAppSession(
    input: {
      miniAppUserId: string;
      startedAt: Date;
      expiresAt: Date;
      endedAt?: Date;
      launchParam?: string;
    },
    organizationId: string,
  ): Promise<MiniAppSessionRow> {
    await this.miniAppUsers.findById(input.miniAppUserId, organizationId);

    const created = await this.miniAppSessions.create({
      miniAppUserId: input.miniAppUserId,
      startedAt: input.startedAt,
      expiresAt: input.expiresAt,
      endedAt: input.endedAt ?? null,
      launchParam: input.launchParam ?? null,
    });

    await this.audit.record({
      action: 'telegramminiapp.mini-app-session.created',
      entityType: 'MiniAppSession',
      entityId: created.id,
      organizationId,
      after: {
        miniAppUserId: created.miniAppUserId,
        startedAt: created.startedAt,
        expiresAt: created.expiresAt,
      },
    });

    return created;
  }

  async updateMiniAppSession(
    id: string,
    changes: {
      miniAppUserId?: string;
      startedAt?: Date;
      expiresAt?: Date;
      endedAt?: Date;
      launchParam?: string;
    },
    organizationId: string,
  ): Promise<MiniAppSessionRow> {
    const existing = await this.miniAppSessions.findById(id, organizationId);

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

    const updated = await this.miniAppSessions.update(id, changes);

    await this.audit.recordChange({
      action: 'telegramminiapp.mini-app-session.updated',
      entityType: 'MiniAppSession',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- deep links --------------------------------------------------

  listDeepLinks(): Promise<DeepLinkRow[]> {
    return this.deepLinks.list();
  }

  findDeepLink(id: string, organizationId: string): Promise<DeepLinkRow> {
    return this.deepLinks.findById(id, organizationId);
  }

  async createDeepLink(
    input: {
      code: string;
      label: string;
      target: string;
      isActive?: boolean;
      openCount?: number;
    },
    organizationId: string,
  ): Promise<DeepLinkRow> {
    const created = await this.deepLinks.create({
      code: input.code,
      label: input.label,
      target: input.target,
      isActive: input.isActive,
      openCount: input.openCount,
    });

    await this.audit.record({
      action: 'telegramminiapp.deep-link.created',
      entityType: 'DeepLink',
      entityId: created.id,
      organizationId,
      after: { code: created.code, label: created.label, target: created.target },
    });

    return created;
  }

  async updateDeepLink(
    id: string,
    changes: {
      label?: string;
      target?: string;
      isActive?: boolean;
      openCount?: number;
    },
    organizationId: string,
  ): Promise<DeepLinkRow> {
    const existing = await this.deepLinks.findById(id, organizationId);

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

    const updated = await this.deepLinks.update(id, changes);

    await this.audit.recordChange({
      action: 'telegramminiapp.deep-link.updated',
      entityType: 'DeepLink',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- menu --------------------------------------------------------

  listMenuEntries(): Promise<MenuEntryRow[]> {
    return this.menuEntries.list();
  }

  findMenuEntry(id: string, organizationId: string): Promise<MenuEntryRow> {
    return this.menuEntries.findById(id, organizationId);
  }

  async createMenuEntry(
    input: {
      label: string;
      href: string;
      icon?: string;
      position: number;
      requiredPermission?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<MenuEntryRow> {
    const created = await this.menuEntries.create({
      label: input.label,
      href: input.href,
      icon: input.icon ?? null,
      position: input.position,
      requiredPermission: input.requiredPermission ?? null,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'telegramminiapp.menu-entry.created',
      entityType: 'MenuEntry',
      entityId: created.id,
      organizationId,
      after: { label: created.label, href: created.href, icon: created.icon },
    });

    return created;
  }

  async updateMenuEntry(
    id: string,
    changes: {
      label?: string;
      href?: string;
      icon?: string;
      position?: number;
      requiredPermission?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<MenuEntryRow> {
    const existing = await this.menuEntries.findById(id, organizationId);

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

    const updated = await this.menuEntries.update(id, changes);

    await this.audit.recordChange({
      action: 'telegramminiapp.menu-entry.updated',
      entityType: 'MenuEntry',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- notification settings ---------------------------------------

  listMiniAppNotificationSettings(): Promise<MiniAppNotificationSettingRow[]> {
    return this.miniAppNotificationSettings.list();
  }

  findMiniAppNotificationSetting(
    id: string,
    organizationId: string,
  ): Promise<MiniAppNotificationSettingRow> {
    return this.miniAppNotificationSettings.findById(id, organizationId);
  }

  async createMiniAppNotificationSetting(
    input: {
      miniAppUserId: string;
      notificationKey: string;
      muted?: boolean;
    },
    organizationId: string,
  ): Promise<MiniAppNotificationSettingRow> {
    await this.miniAppUsers.findById(input.miniAppUserId, organizationId);

    const created = await this.miniAppNotificationSettings.create({
      miniAppUserId: input.miniAppUserId,
      notificationKey: input.notificationKey,
      muted: input.muted,
    });

    await this.audit.record({
      action: 'telegramminiapp.mini-app-notification-setting.created',
      entityType: 'MiniAppNotificationSetting',
      entityId: created.id,
      organizationId,
      after: {
        miniAppUserId: created.miniAppUserId,
        notificationKey: created.notificationKey,
        muted: created.muted,
      },
    });

    return created;
  }

  async updateMiniAppNotificationSetting(
    id: string,
    changes: {
      miniAppUserId?: string;
      notificationKey?: string;
      muted?: boolean;
    },
    organizationId: string,
  ): Promise<MiniAppNotificationSettingRow> {
    const existing = await this.miniAppNotificationSettings.findById(id, organizationId);

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

    const updated = await this.miniAppNotificationSettings.update(id, changes);

    await this.audit.recordChange({
      action: 'telegramminiapp.mini-app-notification-setting.updated',
      entityType: 'MiniAppNotificationSetting',
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

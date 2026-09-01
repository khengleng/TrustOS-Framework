import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Messenger Mini App domain service.
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

export interface MessengerProfileRow {
  id: string;
  organizationId: string;
  miniAppUserId: string;
  pageScopedId: string;
  pageRef: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class MessengerMiniappService {
  private readonly messengerProfiles: TenantRepository<MessengerProfileRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.messengerProfiles = new TenantRepository<MessengerProfileRow>(prisma, 'messengerProfile');
  }

  // --- messenger profiles ------------------------------------------

  listMessengerProfiles(): Promise<MessengerProfileRow[]> {
    return this.messengerProfiles.list();
  }

  findMessengerProfile(id: string, organizationId: string): Promise<MessengerProfileRow> {
    return this.messengerProfiles.findById(id, organizationId);
  }

  async createMessengerProfile(
    input: {
      miniAppUserId: string;
      pageScopedId: string;
      pageRef: string;
    },
    organizationId: string,
  ): Promise<MessengerProfileRow> {
    const created = await this.messengerProfiles.create({
      miniAppUserId: input.miniAppUserId,
      pageScopedId: input.pageScopedId,
      pageRef: input.pageRef,
    });

    await this.audit.record({
      action: 'messengerminiapp.messenger-profile.created',
      entityType: 'MessengerProfile',
      entityId: created.id,
      organizationId,
      after: {
        miniAppUserId: created.miniAppUserId,
        pageScopedId: created.pageScopedId,
        pageRef: created.pageRef,
      },
    });

    return created;
  }

  async updateMessengerProfile(
    id: string,
    changes: {
      miniAppUserId?: string;
      pageRef?: string;
    },
    organizationId: string,
  ): Promise<MessengerProfileRow> {
    const existing = await this.messengerProfiles.findById(id, organizationId);

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

    const updated = await this.messengerProfiles.update(id, changes);

    await this.audit.recordChange({
      action: 'messengerminiapp.messenger-profile.updated',
      entityType: 'MessengerProfile',
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

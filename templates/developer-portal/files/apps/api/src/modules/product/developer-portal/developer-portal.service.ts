import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Developer Portal domain service.
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

export interface ApiApplicationRow {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  ownerUserId: string;
  description: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  status: 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REVOKED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ApiKeyRecordRow {
  id: string;
  organizationId: string;
  applicationId: string;
  apiKeyId: string;
  label: string;
  keyPrefix: string;
  issuedAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ApiUsageRecordRow {
  id: string;
  organizationId: string;
  applicationId: string;
  usageOn: Date;
  endpoint: string;
  callCount: number;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CodeExampleRow {
  id: string;
  organizationId: string;
  slug: string;
  title: string;
  language: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
  body: string;
  endpoint: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface SdkReleaseRow {
  id: string;
  organizationId: string;
  language: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
  version: string;
  downloadUrl: string;
  checksum: string;
  releasedAt: Date;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class DeveloperPortalService {
  private readonly apiApplications: TenantRepository<ApiApplicationRow>;
  private readonly apiKeyRecords: TenantRepository<ApiKeyRecordRow>;
  private readonly apiUsageRecords: TenantRepository<ApiUsageRecordRow>;
  private readonly codeExamples: TenantRepository<CodeExampleRow>;
  private readonly sdkReleases: TenantRepository<SdkReleaseRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.apiApplications = new TenantRepository<ApiApplicationRow>(prisma, 'apiApplication');
    this.apiKeyRecords = new TenantRepository<ApiKeyRecordRow>(prisma, 'apiKeyRecord');
    this.apiUsageRecords = new TenantRepository<ApiUsageRecordRow>(prisma, 'apiUsageRecord');
    this.codeExamples = new TenantRepository<CodeExampleRow>(prisma, 'codeExample');
    this.sdkReleases = new TenantRepository<SdkReleaseRow>(prisma, 'sdkRelease');
  }

  // --- applications ------------------------------------------------

  listApiApplications(): Promise<ApiApplicationRow[]> {
    return this.apiApplications.list();
  }

  findApiApplication(id: string, organizationId: string): Promise<ApiApplicationRow> {
    return this.apiApplications.findById(id, organizationId);
  }

  async createApiApplication(
    input: {
      name: string;
      slug: string;
      ownerUserId: string;
      description?: string;
      environment?: 'SANDBOX' | 'PRODUCTION';
      status?: 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REVOKED';
    },
    organizationId: string,
  ): Promise<ApiApplicationRow> {
    const created = await this.apiApplications.create({
      name: input.name,
      slug: input.slug,
      ownerUserId: input.ownerUserId,
      description: input.description ?? null,
      environment: input.environment,
      status: input.status,
    });

    await this.audit.record({
      action: 'developerportal.api-application.created',
      entityType: 'ApiApplication',
      entityId: created.id,
      organizationId,
      after: { name: created.name, slug: created.slug, ownerUserId: created.ownerUserId },
    });

    return created;
  }

  async updateApiApplication(
    id: string,
    changes: {
      name?: string;
      ownerUserId?: string;
      description?: string;
      environment?: 'SANDBOX' | 'PRODUCTION';
      status?: 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REVOKED';
    },
    organizationId: string,
  ): Promise<ApiApplicationRow> {
    const existing = await this.apiApplications.findById(id, organizationId);

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

    const updated = await this.apiApplications.update(id, changes);

    await this.audit.recordChange({
      action: 'developerportal.api-application.updated',
      entityType: 'ApiApplication',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- api keys ----------------------------------------------------

  listApiKeyRecords(): Promise<ApiKeyRecordRow[]> {
    return this.apiKeyRecords.list();
  }

  findApiKeyRecord(id: string, organizationId: string): Promise<ApiKeyRecordRow> {
    return this.apiKeyRecords.findById(id, organizationId);
  }

  async createApiKeyRecord(
    input: {
      applicationId: string;
      apiKeyId: string;
      label: string;
      keyPrefix: string;
      issuedAt: Date;
      lastUsedAt?: Date;
      revokedAt?: Date;
    },
    organizationId: string,
  ): Promise<ApiKeyRecordRow> {
    await this.apiApplications.findById(input.applicationId, organizationId);

    const created = await this.apiKeyRecords.create({
      applicationId: input.applicationId,
      apiKeyId: input.apiKeyId,
      label: input.label,
      keyPrefix: input.keyPrefix,
      issuedAt: input.issuedAt,
      lastUsedAt: input.lastUsedAt ?? null,
      revokedAt: input.revokedAt ?? null,
    });

    await this.audit.record({
      action: 'developerportal.api-key-record.created',
      entityType: 'ApiKeyRecord',
      entityId: created.id,
      organizationId,
      after: {
        applicationId: created.applicationId,
        apiKeyId: created.apiKeyId,
        label: created.label,
      },
    });

    return created;
  }

  async updateApiKeyRecord(
    id: string,
    changes: {
      applicationId?: string;
      label?: string;
      issuedAt?: Date;
      lastUsedAt?: Date;
      revokedAt?: Date;
    },
    organizationId: string,
  ): Promise<ApiKeyRecordRow> {
    const existing = await this.apiKeyRecords.findById(id, organizationId);

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

    const updated = await this.apiKeyRecords.update(id, changes);

    await this.audit.recordChange({
      action: 'developerportal.api-key-record.updated',
      entityType: 'ApiKeyRecord',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- usage -------------------------------------------------------

  listApiUsageRecords(): Promise<ApiUsageRecordRow[]> {
    return this.apiUsageRecords.list();
  }

  findApiUsageRecord(id: string, organizationId: string): Promise<ApiUsageRecordRow> {
    return this.apiUsageRecords.findById(id, organizationId);
  }

  async createApiUsageRecord(
    input: {
      applicationId: string;
      usageOn: Date;
      endpoint: string;
      callCount: number;
      errorCount: number;
    },
    organizationId: string,
  ): Promise<ApiUsageRecordRow> {
    await this.apiApplications.findById(input.applicationId, organizationId);

    const created = await this.apiUsageRecords.create({
      applicationId: input.applicationId,
      usageOn: input.usageOn,
      endpoint: input.endpoint,
      callCount: input.callCount,
      errorCount: input.errorCount,
    });

    await this.audit.record({
      action: 'developerportal.api-usage-record.created',
      entityType: 'ApiUsageRecord',
      entityId: created.id,
      organizationId,
      after: {
        applicationId: created.applicationId,
        usageOn: created.usageOn,
        endpoint: created.endpoint,
      },
    });

    return created;
  }

  async updateApiUsageRecord(
    id: string,
    changes: {
      applicationId?: string;
      usageOn?: Date;
      endpoint?: string;
      callCount?: number;
      errorCount?: number;
    },
    organizationId: string,
  ): Promise<ApiUsageRecordRow> {
    const existing = await this.apiUsageRecords.findById(id, organizationId);

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

    const updated = await this.apiUsageRecords.update(id, changes);

    await this.audit.recordChange({
      action: 'developerportal.api-usage-record.updated',
      entityType: 'ApiUsageRecord',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- examples ----------------------------------------------------

  listCodeExamples(): Promise<CodeExampleRow[]> {
    return this.codeExamples.list();
  }

  findCodeExample(id: string, organizationId: string): Promise<CodeExampleRow> {
    return this.codeExamples.findById(id, organizationId);
  }

  async createCodeExample(
    input: {
      slug: string;
      title: string;
      language: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
      body: string;
      endpoint?: string;
      position?: number;
    },
    organizationId: string,
  ): Promise<CodeExampleRow> {
    const created = await this.codeExamples.create({
      slug: input.slug,
      title: input.title,
      language: input.language,
      body: input.body,
      endpoint: input.endpoint ?? null,
      position: input.position,
    });

    await this.audit.record({
      action: 'developerportal.code-example.created',
      entityType: 'CodeExample',
      entityId: created.id,
      organizationId,
      after: { slug: created.slug, title: created.title, language: created.language },
    });

    return created;
  }

  async updateCodeExample(
    id: string,
    changes: {
      title?: string;
      language?: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
      body?: string;
      endpoint?: string;
      position?: number;
    },
    organizationId: string,
  ): Promise<CodeExampleRow> {
    const existing = await this.codeExamples.findById(id, organizationId);

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

    const updated = await this.codeExamples.update(id, changes);

    await this.audit.recordChange({
      action: 'developerportal.code-example.updated',
      entityType: 'CodeExample',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- sdk downloads -----------------------------------------------

  listSdkReleases(): Promise<SdkReleaseRow[]> {
    return this.sdkReleases.list();
  }

  findSdkRelease(id: string, organizationId: string): Promise<SdkReleaseRow> {
    return this.sdkReleases.findById(id, organizationId);
  }

  async createSdkRelease(
    input: {
      language: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
      version: string;
      downloadUrl: string;
      checksum: string;
      releasedAt: Date;
      isCurrent?: boolean;
    },
    organizationId: string,
  ): Promise<SdkReleaseRow> {
    const created = await this.sdkReleases.create({
      language: input.language,
      version: input.version,
      downloadUrl: input.downloadUrl,
      checksum: input.checksum,
      releasedAt: input.releasedAt,
      isCurrent: input.isCurrent,
    });

    await this.audit.record({
      action: 'developerportal.sdk-release.created',
      entityType: 'SdkRelease',
      entityId: created.id,
      organizationId,
      after: {
        language: created.language,
        version: created.version,
        downloadUrl: created.downloadUrl,
      },
    });

    return created;
  }

  async updateSdkRelease(
    id: string,
    changes: {
      language?: 'CURL' | 'TYPESCRIPT' | 'PYTHON' | 'GO' | 'PHP' | 'JAVA';
      version?: string;
      downloadUrl?: string;
      checksum?: string;
      releasedAt?: Date;
      isCurrent?: boolean;
    },
    organizationId: string,
  ): Promise<SdkReleaseRow> {
    const existing = await this.sdkReleases.findById(id, organizationId);

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

    const updated = await this.sdkReleases.update(id, changes);

    await this.audit.recordChange({
      action: 'developerportal.sdk-release.updated',
      entityType: 'SdkRelease',
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

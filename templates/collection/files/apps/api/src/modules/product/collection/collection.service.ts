import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Collections domain service.
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

export interface CollectorRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  team: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CollectionCaseRow {
  id: string;
  organizationId: string;
  reference: string;
  debtorName: string;
  debtorPhone: string | null;
  externalAccountRef: string | null;
  outstandingAmount: string;
  currency: string;
  daysPastDue: number;
  bucket: 'B0' | 'B1' | 'B2' | 'B3' | 'B4_PLUS';
  status: 'OPEN' | 'IN_PROGRESS' | 'PROMISED' | 'SETTLED' | 'ESCALATED' | 'CLOSED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CaseAssignmentRow {
  id: string;
  organizationId: string;
  caseId: string;
  collectorId: string;
  assignedAt: Date;
  endedAt: Date | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PaymentPromiseRow {
  id: string;
  organizationId: string;
  caseId: string;
  collectorId: string;
  promisedAmount: string;
  currency: string;
  promisedFor: Date;
  takenAt: Date;
  status: 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface FieldVisitRow {
  id: string;
  organizationId: string;
  caseId: string;
  collectorId: string;
  scheduledFor: Date;
  completedAt: Date | null;
  outcome: 'NOT_VISITED' | 'MET' | 'NOT_FOUND' | 'REFUSED' | 'RELOCATED' | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class CollectionService {
  private readonly collectors: TenantRepository<CollectorRow>;
  private readonly collectionCases: TenantRepository<CollectionCaseRow>;
  private readonly caseAssignments: TenantRepository<CaseAssignmentRow>;
  private readonly paymentPromises: TenantRepository<PaymentPromiseRow>;
  private readonly fieldVisits: TenantRepository<FieldVisitRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.collectors = new TenantRepository<CollectorRow>(prisma, 'collector');
    this.collectionCases = new TenantRepository<CollectionCaseRow>(prisma, 'collectionCase');
    this.caseAssignments = new TenantRepository<CaseAssignmentRow>(prisma, 'caseAssignment');
    this.paymentPromises = new TenantRepository<PaymentPromiseRow>(prisma, 'paymentPromise');
    this.fieldVisits = new TenantRepository<FieldVisitRow>(prisma, 'fieldVisit');
  }

  // --- collectors --------------------------------------------------

  listCollectors(): Promise<CollectorRow[]> {
    return this.collectors.list();
  }

  findCollector(id: string, organizationId: string): Promise<CollectorRow> {
    return this.collectors.findById(id, organizationId);
  }

  async createCollector(
    input: {
      userId: string;
      displayName: string;
      team?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<CollectorRow> {
    const created = await this.collectors.create({
      userId: input.userId,
      displayName: input.displayName,
      team: input.team ?? null,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'collection.collector.created',
      entityType: 'Collector',
      entityId: created.id,
      organizationId,
      after: { userId: created.userId, displayName: created.displayName, team: created.team },
    });

    return created;
  }

  async updateCollector(
    id: string,
    changes: {
      userId?: string;
      displayName?: string;
      team?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<CollectorRow> {
    const existing = await this.collectors.findById(id, organizationId);

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

    const updated = await this.collectors.update(id, changes);

    await this.audit.recordChange({
      action: 'collection.collector.updated',
      entityType: 'Collector',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- cases -------------------------------------------------------

  listCollectionCases(): Promise<CollectionCaseRow[]> {
    return this.collectionCases.list();
  }

  findCollectionCase(id: string, organizationId: string): Promise<CollectionCaseRow> {
    return this.collectionCases.findById(id, organizationId);
  }

  async createCollectionCase(
    input: {
      reference: string;
      debtorName: string;
      debtorPhone?: string;
      externalAccountRef?: string;
      outstandingAmount: string;
      currency: string;
      daysPastDue?: number;
      bucket?: 'B0' | 'B1' | 'B2' | 'B3' | 'B4_PLUS';
      status?: 'OPEN' | 'IN_PROGRESS' | 'PROMISED' | 'SETTLED' | 'ESCALATED' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<CollectionCaseRow> {
    const created = await this.collectionCases.create({
      reference: input.reference,
      debtorName: input.debtorName,
      debtorPhone: input.debtorPhone ?? null,
      externalAccountRef: input.externalAccountRef ?? null,
      outstandingAmount: input.outstandingAmount,
      currency: input.currency,
      daysPastDue: input.daysPastDue,
      bucket: input.bucket,
      status: input.status,
    });

    await this.audit.record({
      action: 'collection.collection-case.created',
      entityType: 'CollectionCase',
      entityId: created.id,
      organizationId,
      after: {
        reference: created.reference,
        debtorName: created.debtorName,
        debtorPhone: created.debtorPhone,
      },
    });

    return created;
  }

  async updateCollectionCase(
    id: string,
    changes: {
      debtorName?: string;
      debtorPhone?: string;
      externalAccountRef?: string;
      outstandingAmount?: string;
      currency?: string;
      daysPastDue?: number;
      bucket?: 'B0' | 'B1' | 'B2' | 'B3' | 'B4_PLUS';
      status?: 'OPEN' | 'IN_PROGRESS' | 'PROMISED' | 'SETTLED' | 'ESCALATED' | 'CLOSED';
    },
    organizationId: string,
  ): Promise<CollectionCaseRow> {
    const existing = await this.collectionCases.findById(id, organizationId);

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

    const updated = await this.collectionCases.update(id, changes);

    await this.audit.recordChange({
      action: 'collection.collection-case.updated',
      entityType: 'CollectionCase',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- assignments -------------------------------------------------

  listCaseAssignments(): Promise<CaseAssignmentRow[]> {
    return this.caseAssignments.list();
  }

  findCaseAssignment(id: string, organizationId: string): Promise<CaseAssignmentRow> {
    return this.caseAssignments.findById(id, organizationId);
  }

  async createCaseAssignment(
    input: {
      caseId: string;
      collectorId: string;
      assignedAt: Date;
      endedAt?: Date;
      reason?: string;
    },
    organizationId: string,
  ): Promise<CaseAssignmentRow> {
    await this.collectionCases.findById(input.caseId, organizationId);
    await this.collectors.findById(input.collectorId, organizationId);

    const created = await this.caseAssignments.create({
      caseId: input.caseId,
      collectorId: input.collectorId,
      assignedAt: input.assignedAt,
      endedAt: input.endedAt ?? null,
      reason: input.reason ?? null,
    });

    await this.audit.record({
      action: 'collection.case-assignment.created',
      entityType: 'CaseAssignment',
      entityId: created.id,
      organizationId,
      after: {
        caseId: created.caseId,
        collectorId: created.collectorId,
        assignedAt: created.assignedAt,
      },
    });

    return created;
  }

  async updateCaseAssignment(
    id: string,
    changes: {
      caseId?: string;
      collectorId?: string;
      assignedAt?: Date;
      endedAt?: Date;
      reason?: string;
    },
    organizationId: string,
  ): Promise<CaseAssignmentRow> {
    const existing = await this.caseAssignments.findById(id, organizationId);

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

    const updated = await this.caseAssignments.update(id, changes);

    await this.audit.recordChange({
      action: 'collection.case-assignment.updated',
      entityType: 'CaseAssignment',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- promises ----------------------------------------------------

  listPaymentPromises(): Promise<PaymentPromiseRow[]> {
    return this.paymentPromises.list();
  }

  findPaymentPromise(id: string, organizationId: string): Promise<PaymentPromiseRow> {
    return this.paymentPromises.findById(id, organizationId);
  }

  async createPaymentPromise(
    input: {
      caseId: string;
      collectorId: string;
      promisedAmount: string;
      currency: string;
      promisedFor: Date;
      takenAt: Date;
      status?: 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';
      note?: string;
    },
    organizationId: string,
  ): Promise<PaymentPromiseRow> {
    await this.collectionCases.findById(input.caseId, organizationId);
    await this.collectors.findById(input.collectorId, organizationId);

    const created = await this.paymentPromises.create({
      caseId: input.caseId,
      collectorId: input.collectorId,
      promisedAmount: input.promisedAmount,
      currency: input.currency,
      promisedFor: input.promisedFor,
      takenAt: input.takenAt,
      status: input.status,
      note: input.note ?? null,
    });

    await this.audit.record({
      action: 'collection.payment-promise.created',
      entityType: 'PaymentPromise',
      entityId: created.id,
      organizationId,
      after: {
        caseId: created.caseId,
        collectorId: created.collectorId,
        promisedAmount: created.promisedAmount,
      },
    });

    return created;
  }

  async updatePaymentPromise(
    id: string,
    changes: {
      caseId?: string;
      collectorId?: string;
      promisedAmount?: string;
      currency?: string;
      promisedFor?: Date;
      takenAt?: Date;
      status?: 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';
      note?: string;
    },
    organizationId: string,
  ): Promise<PaymentPromiseRow> {
    const existing = await this.paymentPromises.findById(id, organizationId);

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

    const updated = await this.paymentPromises.update(id, changes);

    await this.audit.recordChange({
      action: 'collection.payment-promise.updated',
      entityType: 'PaymentPromise',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- visits ------------------------------------------------------

  listFieldVisits(): Promise<FieldVisitRow[]> {
    return this.fieldVisits.list();
  }

  findFieldVisit(id: string, organizationId: string): Promise<FieldVisitRow> {
    return this.fieldVisits.findById(id, organizationId);
  }

  async createFieldVisit(
    input: {
      caseId: string;
      collectorId: string;
      scheduledFor: Date;
      completedAt?: Date;
      outcome?: 'NOT_VISITED' | 'MET' | 'NOT_FOUND' | 'REFUSED' | 'RELOCATED';
      notes?: string;
    },
    organizationId: string,
  ): Promise<FieldVisitRow> {
    await this.collectionCases.findById(input.caseId, organizationId);
    await this.collectors.findById(input.collectorId, organizationId);

    const created = await this.fieldVisits.create({
      caseId: input.caseId,
      collectorId: input.collectorId,
      scheduledFor: input.scheduledFor,
      completedAt: input.completedAt ?? null,
      outcome: input.outcome ?? null,
      notes: input.notes ?? null,
    });

    await this.audit.record({
      action: 'collection.field-visit.created',
      entityType: 'FieldVisit',
      entityId: created.id,
      organizationId,
      after: {
        caseId: created.caseId,
        collectorId: created.collectorId,
        scheduledFor: created.scheduledFor,
      },
    });

    return created;
  }

  async updateFieldVisit(
    id: string,
    changes: {
      caseId?: string;
      collectorId?: string;
      scheduledFor?: Date;
      completedAt?: Date;
      outcome?: 'NOT_VISITED' | 'MET' | 'NOT_FOUND' | 'REFUSED' | 'RELOCATED';
      notes?: string;
    },
    organizationId: string,
  ): Promise<FieldVisitRow> {
    const existing = await this.fieldVisits.findById(id, organizationId);

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

    const updated = await this.fieldVisits.update(id, changes);

    await this.audit.recordChange({
      action: 'collection.field-visit.updated',
      entityType: 'FieldVisit',
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

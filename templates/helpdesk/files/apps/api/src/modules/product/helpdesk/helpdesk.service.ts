import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS Helpdesk domain service.
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

export interface TicketQueueRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface SupportAgentRow {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  queueId: string | null;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface SlaPolicyRow {
  id: string;
  organizationId: string;
  name: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHoursOnly: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TicketRow {
  id: string;
  organizationId: string;
  reference: string;
  queueId: string;
  assigneeId: string | null;
  requesterName: string;
  requesterEmail: string | null;
  subject: string;
  body: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  status: 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
  openedAt: Date;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface TicketCommentRow {
  id: string;
  organizationId: string;
  ticketId: string;
  authorUserId: string | null;
  body: string;
  isInternal: boolean;
  postedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class HelpdeskService {
  private readonly ticketQueues: TenantRepository<TicketQueueRow>;
  private readonly supportAgents: TenantRepository<SupportAgentRow>;
  private readonly slaPolicies: TenantRepository<SlaPolicyRow>;
  private readonly tickets: TenantRepository<TicketRow>;
  private readonly ticketComments: TenantRepository<TicketCommentRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.ticketQueues = new TenantRepository<TicketQueueRow>(prisma, 'ticketQueue');
    this.supportAgents = new TenantRepository<SupportAgentRow>(prisma, 'supportAgent');
    this.slaPolicies = new TenantRepository<SlaPolicyRow>(prisma, 'slaPolicy');
    this.tickets = new TenantRepository<TicketRow>(prisma, 'ticket');
    this.ticketComments = new TenantRepository<TicketCommentRow>(prisma, 'ticketComment');
  }

  // --- queues ------------------------------------------------------

  listTicketQueues(): Promise<TicketQueueRow[]> {
    return this.ticketQueues.list();
  }

  findTicketQueue(id: string, organizationId: string): Promise<TicketQueueRow> {
    return this.ticketQueues.findById(id, organizationId);
  }

  async createTicketQueue(
    input: {
      name: string;
      code: string;
      description?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<TicketQueueRow> {
    const created = await this.ticketQueues.create({
      name: input.name,
      code: input.code,
      description: input.description ?? null,
      isActive: input.isActive,
    });

    await this.audit.record({
      action: 'helpdesk.ticket-queue.created',
      entityType: 'TicketQueue',
      entityId: created.id,
      organizationId,
      after: { name: created.name, code: created.code, description: created.description },
    });

    return created;
  }

  async updateTicketQueue(
    id: string,
    changes: {
      name?: string;
      description?: string;
      isActive?: boolean;
    },
    organizationId: string,
  ): Promise<TicketQueueRow> {
    const existing = await this.ticketQueues.findById(id, organizationId);

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

    const updated = await this.ticketQueues.update(id, changes);

    await this.audit.recordChange({
      action: 'helpdesk.ticket-queue.updated',
      entityType: 'TicketQueue',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- agents ------------------------------------------------------

  listSupportAgents(): Promise<SupportAgentRow[]> {
    return this.supportAgents.list();
  }

  findSupportAgent(id: string, organizationId: string): Promise<SupportAgentRow> {
    return this.supportAgents.findById(id, organizationId);
  }

  async createSupportAgent(
    input: {
      userId: string;
      displayName: string;
      queueId?: string;
      isAvailable?: boolean;
    },
    organizationId: string,
  ): Promise<SupportAgentRow> {
    if (input.queueId !== undefined) {
      await this.ticketQueues.findById(input.queueId, organizationId);
    }

    const created = await this.supportAgents.create({
      userId: input.userId,
      displayName: input.displayName,
      queueId: input.queueId ?? null,
      isAvailable: input.isAvailable,
    });

    await this.audit.record({
      action: 'helpdesk.support-agent.created',
      entityType: 'SupportAgent',
      entityId: created.id,
      organizationId,
      after: { userId: created.userId, displayName: created.displayName, queueId: created.queueId },
    });

    return created;
  }

  async updateSupportAgent(
    id: string,
    changes: {
      userId?: string;
      displayName?: string;
      queueId?: string;
      isAvailable?: boolean;
    },
    organizationId: string,
  ): Promise<SupportAgentRow> {
    const existing = await this.supportAgents.findById(id, organizationId);

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

    const updated = await this.supportAgents.update(id, changes);

    await this.audit.recordChange({
      action: 'helpdesk.support-agent.updated',
      entityType: 'SupportAgent',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- sla policies ------------------------------------------------

  listSlaPolicies(): Promise<SlaPolicyRow[]> {
    return this.slaPolicies.list();
  }

  findSlaPolicy(id: string, organizationId: string): Promise<SlaPolicyRow> {
    return this.slaPolicies.findById(id, organizationId);
  }

  async createSlaPolicy(
    input: {
      name: string;
      priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      firstResponseMinutes: number;
      resolutionMinutes: number;
      businessHoursOnly?: boolean;
    },
    organizationId: string,
  ): Promise<SlaPolicyRow> {
    const created = await this.slaPolicies.create({
      name: input.name,
      priority: input.priority,
      firstResponseMinutes: input.firstResponseMinutes,
      resolutionMinutes: input.resolutionMinutes,
      businessHoursOnly: input.businessHoursOnly,
    });

    await this.audit.record({
      action: 'helpdesk.sla-policy.created',
      entityType: 'SlaPolicy',
      entityId: created.id,
      organizationId,
      after: {
        name: created.name,
        priority: created.priority,
        firstResponseMinutes: created.firstResponseMinutes,
      },
    });

    return created;
  }

  async updateSlaPolicy(
    id: string,
    changes: {
      name?: string;
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      firstResponseMinutes?: number;
      resolutionMinutes?: number;
      businessHoursOnly?: boolean;
    },
    organizationId: string,
  ): Promise<SlaPolicyRow> {
    const existing = await this.slaPolicies.findById(id, organizationId);

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

    const updated = await this.slaPolicies.update(id, changes);

    await this.audit.recordChange({
      action: 'helpdesk.sla-policy.updated',
      entityType: 'SlaPolicy',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- tickets -----------------------------------------------------

  listTickets(): Promise<TicketRow[]> {
    return this.tickets.list();
  }

  findTicket(id: string, organizationId: string): Promise<TicketRow> {
    return this.tickets.findById(id, organizationId);
  }

  async createTicket(
    input: {
      reference: string;
      queueId: string;
      assigneeId?: string;
      requesterName: string;
      requesterEmail?: string;
      subject: string;
      body: string;
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      status?: 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
      openedAt: Date;
      firstRespondedAt?: Date;
      resolvedAt?: Date;
    },
    organizationId: string,
  ): Promise<TicketRow> {
    await this.ticketQueues.findById(input.queueId, organizationId);
    if (input.assigneeId !== undefined) {
      await this.supportAgents.findById(input.assigneeId, organizationId);
    }

    const created = await this.tickets.create({
      reference: input.reference,
      queueId: input.queueId,
      assigneeId: input.assigneeId ?? null,
      requesterName: input.requesterName,
      requesterEmail: input.requesterEmail ?? null,
      subject: input.subject,
      body: input.body,
      priority: input.priority,
      status: input.status,
      openedAt: input.openedAt,
      firstRespondedAt: input.firstRespondedAt ?? null,
      resolvedAt: input.resolvedAt ?? null,
    });

    await this.audit.record({
      action: 'helpdesk.ticket.created',
      entityType: 'Ticket',
      entityId: created.id,
      organizationId,
      after: {
        reference: created.reference,
        queueId: created.queueId,
        assigneeId: created.assigneeId,
      },
    });

    return created;
  }

  async updateTicket(
    id: string,
    changes: {
      queueId?: string;
      assigneeId?: string;
      requesterName?: string;
      requesterEmail?: string;
      subject?: string;
      body?: string;
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
      status?: 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
      openedAt?: Date;
      firstRespondedAt?: Date;
      resolvedAt?: Date;
    },
    organizationId: string,
  ): Promise<TicketRow> {
    const existing = await this.tickets.findById(id, organizationId);

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

    const updated = await this.tickets.update(id, changes);

    await this.audit.recordChange({
      action: 'helpdesk.ticket.updated',
      entityType: 'Ticket',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- comments ----------------------------------------------------

  listTicketComments(): Promise<TicketCommentRow[]> {
    return this.ticketComments.list();
  }

  findTicketComment(id: string, organizationId: string): Promise<TicketCommentRow> {
    return this.ticketComments.findById(id, organizationId);
  }

  async createTicketComment(
    input: {
      ticketId: string;
      authorUserId?: string;
      body: string;
      isInternal?: boolean;
      postedAt: Date;
    },
    organizationId: string,
  ): Promise<TicketCommentRow> {
    await this.tickets.findById(input.ticketId, organizationId);

    const created = await this.ticketComments.create({
      ticketId: input.ticketId,
      authorUserId: input.authorUserId ?? null,
      body: input.body,
      isInternal: input.isInternal,
      postedAt: input.postedAt,
    });

    await this.audit.record({
      action: 'helpdesk.ticket-comment.created',
      entityType: 'TicketComment',
      entityId: created.id,
      organizationId,
      after: { ticketId: created.ticketId, authorUserId: created.authorUserId, body: created.body },
    });

    return created;
  }

  async updateTicketComment(
    id: string,
    changes: {
      ticketId?: string;
      authorUserId?: string;
      body?: string;
      isInternal?: boolean;
      postedAt?: Date;
    },
    organizationId: string,
  ): Promise<TicketCommentRow> {
    const existing = await this.ticketComments.findById(id, organizationId);

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

    const updated = await this.ticketComments.update(id, changes);

    await this.audit.recordChange({
      action: 'helpdesk.ticket-comment.updated',
      entityType: 'TicketComment',
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

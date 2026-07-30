import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustos/audit';
import { PrismaService } from '@trustos/database';
import { ApiError } from '@trustos/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS CRM domain service.
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

export interface CustomerRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  industry: string | null;
  website: string | null;
  status: 'PROSPECT' | 'ACTIVE' | 'DORMANT' | 'LOST';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ContactRow {
  id: string;
  organizationId: string;
  customerId: string;
  fullName: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface LeadRow {
  id: string;
  organizationId: string;
  fullName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: 'WEB' | 'REFERRAL' | 'EVENT' | 'OUTBOUND' | 'PARTNER' | 'OTHER';
  status: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'DISQUALIFIED';
  ownerUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PipelineStageRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  position: number;
  isWon: boolean;
  isClosed: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface OpportunityRow {
  id: string;
  organizationId: string;
  customerId: string;
  stageId: string;
  name: string;
  amount: string;
  currency: string;
  expectedCloseOn: Date | null;
  ownerUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ActivityRow {
  id: string;
  organizationId: string;
  customerId: string | null;
  leadId: string | null;
  kind: 'CALL' | 'MEETING' | 'EMAIL' | 'NOTE' | 'VISIT';
  subject: string;
  body: string | null;
  occurredAt: Date;
  actorUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CrmTaskRow {
  id: string;
  organizationId: string;
  customerId: string | null;
  opportunityId: string | null;
  title: string;
  dueOn: Date | null;
  assigneeUserId: string | null;
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class CrmService {
  private readonly customers: TenantRepository<CustomerRow>;
  private readonly contacts: TenantRepository<ContactRow>;
  private readonly leads: TenantRepository<LeadRow>;
  private readonly pipelineStages: TenantRepository<PipelineStageRow>;
  private readonly opportunities: TenantRepository<OpportunityRow>;
  private readonly activities: TenantRepository<ActivityRow>;
  private readonly crmTasks: TenantRepository<CrmTaskRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.customers = new TenantRepository<CustomerRow>(prisma, 'customer');
    this.contacts = new TenantRepository<ContactRow>(prisma, 'contact');
    this.leads = new TenantRepository<LeadRow>(prisma, 'lead');
    this.pipelineStages = new TenantRepository<PipelineStageRow>(prisma, 'pipelineStage');
    this.opportunities = new TenantRepository<OpportunityRow>(prisma, 'opportunity');
    this.activities = new TenantRepository<ActivityRow>(prisma, 'activity');
    this.crmTasks = new TenantRepository<CrmTaskRow>(prisma, 'crmTask');
  }

  // --- customers ---------------------------------------------------

  listCustomers(): Promise<CustomerRow[]> {
    return this.customers.list();
  }

  findCustomer(id: string, organizationId: string): Promise<CustomerRow> {
    return this.customers.findById(id, organizationId);
  }

  async createCustomer(
    input: {
      name: string;
      code: string;
      industry?: string;
      website?: string;
      status?: 'PROSPECT' | 'ACTIVE' | 'DORMANT' | 'LOST';
    },
    organizationId: string,
  ): Promise<CustomerRow> {
    const created = await this.customers.create({
      name: input.name,
      code: input.code,
      industry: input.industry ?? null,
      website: input.website ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'crm.customer.created',
      entityType: 'Customer',
      entityId: created.id,
      organizationId,
      after: { name: created.name, code: created.code, industry: created.industry },
    });

    return created;
  }

  async updateCustomer(
    id: string,
    changes: {
      name?: string;
      industry?: string;
      website?: string;
      status?: 'PROSPECT' | 'ACTIVE' | 'DORMANT' | 'LOST';
    },
    organizationId: string,
  ): Promise<CustomerRow> {
    const existing = await this.customers.findById(id, organizationId);

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

    const updated = await this.customers.update(id, changes);

    await this.audit.recordChange({
      action: 'crm.customer.updated',
      entityType: 'Customer',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- contacts ----------------------------------------------------

  listContacts(): Promise<ContactRow[]> {
    return this.contacts.list();
  }

  findContact(id: string, organizationId: string): Promise<ContactRow> {
    return this.contacts.findById(id, organizationId);
  }

  async createContact(
    input: {
      customerId: string;
      fullName: string;
      title?: string;
      email?: string;
      phone?: string;
      isPrimary?: boolean;
    },
    organizationId: string,
  ): Promise<ContactRow> {
    await this.customers.findById(input.customerId, organizationId);

    const created = await this.contacts.create({
      customerId: input.customerId,
      fullName: input.fullName,
      title: input.title ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      isPrimary: input.isPrimary,
    });

    await this.audit.record({
      action: 'crm.contact.created',
      entityType: 'Contact',
      entityId: created.id,
      organizationId,
      after: { customerId: created.customerId, fullName: created.fullName, title: created.title },
    });

    return created;
  }

  async updateContact(
    id: string,
    changes: {
      customerId?: string;
      fullName?: string;
      title?: string;
      email?: string;
      phone?: string;
      isPrimary?: boolean;
    },
    organizationId: string,
  ): Promise<ContactRow> {
    const existing = await this.contacts.findById(id, organizationId);

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

    const updated = await this.contacts.update(id, changes);

    await this.audit.recordChange({
      action: 'crm.contact.updated',
      entityType: 'Contact',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- leads -------------------------------------------------------

  listLeads(): Promise<LeadRow[]> {
    return this.leads.list();
  }

  findLead(id: string, organizationId: string): Promise<LeadRow> {
    return this.leads.findById(id, organizationId);
  }

  async createLead(
    input: {
      fullName: string;
      company?: string;
      email?: string;
      phone?: string;
      source?: 'WEB' | 'REFERRAL' | 'EVENT' | 'OUTBOUND' | 'PARTNER' | 'OTHER';
      status?: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'DISQUALIFIED';
      ownerUserId?: string;
    },
    organizationId: string,
  ): Promise<LeadRow> {
    const created = await this.leads.create({
      fullName: input.fullName,
      company: input.company ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      source: input.source,
      status: input.status,
      ownerUserId: input.ownerUserId ?? null,
    });

    await this.audit.record({
      action: 'crm.lead.created',
      entityType: 'Lead',
      entityId: created.id,
      organizationId,
      after: { fullName: created.fullName, company: created.company, email: created.email },
    });

    return created;
  }

  async updateLead(
    id: string,
    changes: {
      fullName?: string;
      company?: string;
      email?: string;
      phone?: string;
      source?: 'WEB' | 'REFERRAL' | 'EVENT' | 'OUTBOUND' | 'PARTNER' | 'OTHER';
      status?: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'DISQUALIFIED';
      ownerUserId?: string;
    },
    organizationId: string,
  ): Promise<LeadRow> {
    const existing = await this.leads.findById(id, organizationId);

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

    const updated = await this.leads.update(id, changes);

    await this.audit.recordChange({
      action: 'crm.lead.updated',
      entityType: 'Lead',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- pipeline stages ---------------------------------------------

  listPipelineStages(): Promise<PipelineStageRow[]> {
    return this.pipelineStages.list();
  }

  findPipelineStage(id: string, organizationId: string): Promise<PipelineStageRow> {
    return this.pipelineStages.findById(id, organizationId);
  }

  async createPipelineStage(
    input: {
      name: string;
      code: string;
      position: number;
      isWon?: boolean;
      isClosed?: boolean;
    },
    organizationId: string,
  ): Promise<PipelineStageRow> {
    const created = await this.pipelineStages.create({
      name: input.name,
      code: input.code,
      position: input.position,
      isWon: input.isWon,
      isClosed: input.isClosed,
    });

    await this.audit.record({
      action: 'crm.pipeline-stage.created',
      entityType: 'PipelineStage',
      entityId: created.id,
      organizationId,
      after: { name: created.name, code: created.code, position: created.position },
    });

    return created;
  }

  async updatePipelineStage(
    id: string,
    changes: {
      name?: string;
      position?: number;
      isWon?: boolean;
      isClosed?: boolean;
    },
    organizationId: string,
  ): Promise<PipelineStageRow> {
    const existing = await this.pipelineStages.findById(id, organizationId);

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

    const updated = await this.pipelineStages.update(id, changes);

    await this.audit.recordChange({
      action: 'crm.pipeline-stage.updated',
      entityType: 'PipelineStage',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- opportunities -----------------------------------------------

  listOpportunities(): Promise<OpportunityRow[]> {
    return this.opportunities.list();
  }

  findOpportunity(id: string, organizationId: string): Promise<OpportunityRow> {
    return this.opportunities.findById(id, organizationId);
  }

  async createOpportunity(
    input: {
      customerId: string;
      stageId: string;
      name: string;
      amount: string;
      currency: string;
      expectedCloseOn?: Date;
      ownerUserId?: string;
    },
    organizationId: string,
  ): Promise<OpportunityRow> {
    await this.customers.findById(input.customerId, organizationId);
    await this.pipelineStages.findById(input.stageId, organizationId);

    const created = await this.opportunities.create({
      customerId: input.customerId,
      stageId: input.stageId,
      name: input.name,
      amount: input.amount,
      currency: input.currency,
      expectedCloseOn: input.expectedCloseOn ?? null,
      ownerUserId: input.ownerUserId ?? null,
    });

    await this.audit.record({
      action: 'crm.opportunity.created',
      entityType: 'Opportunity',
      entityId: created.id,
      organizationId,
      after: { customerId: created.customerId, stageId: created.stageId, name: created.name },
    });

    return created;
  }

  async updateOpportunity(
    id: string,
    changes: {
      customerId?: string;
      stageId?: string;
      name?: string;
      amount?: string;
      currency?: string;
      expectedCloseOn?: Date;
      ownerUserId?: string;
    },
    organizationId: string,
  ): Promise<OpportunityRow> {
    const existing = await this.opportunities.findById(id, organizationId);

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

    const updated = await this.opportunities.update(id, changes);

    await this.audit.recordChange({
      action: 'crm.opportunity.updated',
      entityType: 'Opportunity',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- activities --------------------------------------------------

  listActivities(): Promise<ActivityRow[]> {
    return this.activities.list();
  }

  findActivity(id: string, organizationId: string): Promise<ActivityRow> {
    return this.activities.findById(id, organizationId);
  }

  async createActivity(
    input: {
      customerId?: string;
      leadId?: string;
      kind: 'CALL' | 'MEETING' | 'EMAIL' | 'NOTE' | 'VISIT';
      subject: string;
      body?: string;
      occurredAt: Date;
      actorUserId?: string;
    },
    organizationId: string,
  ): Promise<ActivityRow> {
    if (input.customerId !== undefined) {
      await this.customers.findById(input.customerId, organizationId);
    }
    if (input.leadId !== undefined) {
      await this.leads.findById(input.leadId, organizationId);
    }

    const created = await this.activities.create({
      customerId: input.customerId ?? null,
      leadId: input.leadId ?? null,
      kind: input.kind,
      subject: input.subject,
      body: input.body ?? null,
      occurredAt: input.occurredAt,
      actorUserId: input.actorUserId ?? null,
    });

    await this.audit.record({
      action: 'crm.activity.created',
      entityType: 'Activity',
      entityId: created.id,
      organizationId,
      after: { customerId: created.customerId, leadId: created.leadId, kind: created.kind },
    });

    return created;
  }

  async updateActivity(
    id: string,
    changes: {
      customerId?: string;
      leadId?: string;
      kind?: 'CALL' | 'MEETING' | 'EMAIL' | 'NOTE' | 'VISIT';
      subject?: string;
      body?: string;
      occurredAt?: Date;
      actorUserId?: string;
    },
    organizationId: string,
  ): Promise<ActivityRow> {
    const existing = await this.activities.findById(id, organizationId);

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

    const updated = await this.activities.update(id, changes);

    await this.audit.recordChange({
      action: 'crm.activity.updated',
      entityType: 'Activity',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- tasks -------------------------------------------------------

  listCrmTasks(): Promise<CrmTaskRow[]> {
    return this.crmTasks.list();
  }

  findCrmTask(id: string, organizationId: string): Promise<CrmTaskRow> {
    return this.crmTasks.findById(id, organizationId);
  }

  async createCrmTask(
    input: {
      customerId?: string;
      opportunityId?: string;
      title: string;
      dueOn?: Date;
      assigneeUserId?: string;
      status?: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<CrmTaskRow> {
    if (input.customerId !== undefined) {
      await this.customers.findById(input.customerId, organizationId);
    }
    if (input.opportunityId !== undefined) {
      await this.opportunities.findById(input.opportunityId, organizationId);
    }

    const created = await this.crmTasks.create({
      customerId: input.customerId ?? null,
      opportunityId: input.opportunityId ?? null,
      title: input.title,
      dueOn: input.dueOn ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'crm.crm-task.created',
      entityType: 'CrmTask',
      entityId: created.id,
      organizationId,
      after: {
        customerId: created.customerId,
        opportunityId: created.opportunityId,
        title: created.title,
      },
    });

    return created;
  }

  async updateCrmTask(
    id: string,
    changes: {
      customerId?: string;
      opportunityId?: string;
      title?: string;
      dueOn?: Date;
      assigneeUserId?: string;
      status?: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<CrmTaskRow> {
    const existing = await this.crmTasks.findById(id, organizationId);

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

    const updated = await this.crmTasks.update(id, changes);

    await this.audit.recordChange({
      action: 'crm.crm-task.updated',
      entityType: 'CrmTask',
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

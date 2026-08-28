import { ModuleRepository, type ModuleContext } from '@trustos/module-sdk';
import type { ChannelId } from './channels';
import type { NotificationConfig } from './config';
import type { DeliveryStatus } from './delivery';

/** Where templates, messages and attempts live. */

export interface NotificationTemplateRow {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  channel: ChannelId;
  subject: string;
  body: string;
  /** Variable names the template is allowed to reference. */
  variables: string[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface NotificationMessageRow {
  id: string;
  organizationId: string;
  templateKey: string;
  channel: ChannelId;
  target: string;
  subject: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  providerReference: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * One delivery attempt.
 *
 * Append-only: rows are written and never updated, so the history of what was
 * tried and what the provider said survives whatever the message's current status
 * happens to be.
 */
export interface NotificationAttemptRow {
  id: string;
  organizationId: string;
  messageId: string;
  attempt: number;
  accepted: boolean;
  failureReason: string | null;
  providerReference: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface NotificationStore {
  findTemplate(key: string): Promise<NotificationTemplateRow | null>;
  requireTemplate(id: string, organizationId: string): Promise<NotificationTemplateRow>;
  listTemplates(): Promise<NotificationTemplateRow[]>;
  createTemplate(
    row: Omit<
      NotificationTemplateRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<NotificationTemplateRow>;
  updateTemplate(
    id: string,
    patch: Partial<NotificationTemplateRow>,
  ): Promise<NotificationTemplateRow>;
  deleteTemplate(id: string, now: Date): Promise<NotificationTemplateRow>;

  createMessage(
    row: Omit<
      NotificationMessageRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<NotificationMessageRow>;
  findMessage(id: string, organizationId: string): Promise<NotificationMessageRow>;
  listMessages(options: {
    status?: DeliveryStatus;
    skip?: number;
    take?: number;
  }): Promise<NotificationMessageRow[]>;
  countMessages(status?: DeliveryStatus): Promise<number>;
  updateMessage(
    id: string,
    patch: Partial<NotificationMessageRow>,
  ): Promise<NotificationMessageRow>;

  addAttempt(
    row: Omit<NotificationAttemptRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<NotificationAttemptRow>;
  listAttempts(messageId: string): Promise<NotificationAttemptRow[]>;
}

export class PrismaNotificationStore implements NotificationStore {
  private readonly templates: ModuleRepository<NotificationTemplateRow>;
  private readonly messages: ModuleRepository<NotificationMessageRow>;
  private readonly attempts: ModuleRepository<NotificationAttemptRow>;

  constructor(context: ModuleContext<NotificationConfig>) {
    const { prisma, moduleId } = context;
    this.templates = new ModuleRepository(prisma, 'notificationTemplate', moduleId);
    this.messages = new ModuleRepository(prisma, 'notificationMessage', moduleId);
    this.attempts = new ModuleRepository(prisma, 'notificationAttempt', moduleId);
  }

  findTemplate(key: string): Promise<NotificationTemplateRow | null> {
    return this.templates.findFirst({ key });
  }

  requireTemplate(id: string, organizationId: string): Promise<NotificationTemplateRow> {
    return this.templates.findById(id, organizationId);
  }

  listTemplates(): Promise<NotificationTemplateRow[]> {
    return this.templates.list();
  }

  createTemplate(
    row: Omit<
      NotificationTemplateRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<NotificationTemplateRow> {
    return this.templates.create({ ...row });
  }

  updateTemplate(
    id: string,
    patch: Partial<NotificationTemplateRow>,
  ): Promise<NotificationTemplateRow> {
    return this.templates.update(id, { ...patch });
  }

  deleteTemplate(id: string, now: Date): Promise<NotificationTemplateRow> {
    return this.templates.softDelete(id, now);
  }

  createMessage(
    row: Omit<
      NotificationMessageRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<NotificationMessageRow> {
    return this.messages.create({ ...row });
  }

  findMessage(id: string, organizationId: string): Promise<NotificationMessageRow> {
    return this.messages.findById(id, organizationId);
  }

  listMessages(options: {
    status?: DeliveryStatus;
    skip?: number;
    take?: number;
  }): Promise<NotificationMessageRow[]> {
    return this.messages.list({
      ...(options.status ? { where: { status: options.status } } : {}),
      ...(options.skip === undefined ? {} : { skip: options.skip }),
      ...(options.take === undefined ? {} : { take: options.take }),
    });
  }

  countMessages(status?: DeliveryStatus): Promise<number> {
    return this.messages.count(status ? { status } : {});
  }

  updateMessage(
    id: string,
    patch: Partial<NotificationMessageRow>,
  ): Promise<NotificationMessageRow> {
    return this.messages.update(id, { ...patch });
  }

  addAttempt(
    row: Omit<NotificationAttemptRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<NotificationAttemptRow> {
    return this.attempts.create({ ...row });
  }

  listAttempts(messageId: string): Promise<NotificationAttemptRow[]> {
    return this.attempts.list({ where: { messageId }, orderBy: { attempt: 'asc' } });
  }
}

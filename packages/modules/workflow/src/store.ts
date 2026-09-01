import { ModuleRepository, type ModuleContext } from '@trustsystem/module-sdk';
import type { WorkflowConfig } from './config';
import type { ApprovalStep } from './definition';

/** Instance and task states. Terminal states have no outgoing transitions. */
export const INSTANCE_STATUSES = ['RUNNING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const TASK_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_INSTANCE_STATUSES: InstanceStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];

export interface WorkflowDefinitionRow {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  description: string;
  steps: ApprovalStep[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface WorkflowInstanceRow {
  id: string;
  organizationId: string;
  definitionKey: string;
  /** What is being approved. The module does not interpret either field. */
  subjectType: string;
  subjectId: string;
  submittedBy: string;
  status: InstanceStatus;
  currentStep: number;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface WorkflowTaskRow {
  id: string;
  organizationId: string;
  instanceId: string;
  stepOrder: number;
  stepName: string;
  approverPermission: string;
  requiredApprovals: number;
  status: TaskStatus;
  dueAt: Date;
  /** Set when the SLA breach has been acted on, so it escalates once. */
  escalatedAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Append-only history.
 *
 * This is more than a log: it is the source of truth for *who has approved a
 * task*, which is how "two distinct approvers" is counted without a second
 * mutable counter that could disagree with the trail.
 */
export interface WorkflowHistoryRow {
  id: string;
  organizationId: string;
  instanceId: string;
  taskId: string | null;
  action: string;
  actorId: string | null;
  comment: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface WorkflowStore {
  listDefinitions(): Promise<WorkflowDefinitionRow[]>;
  findDefinition(key: string): Promise<WorkflowDefinitionRow | null>;
  createDefinition(
    row: Omit<
      WorkflowDefinitionRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<WorkflowDefinitionRow>;

  createInstance(
    row: Omit<
      WorkflowInstanceRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<WorkflowInstanceRow>;
  findInstance(id: string, organizationId: string): Promise<WorkflowInstanceRow>;
  listInstances(options: {
    status?: InstanceStatus;
    skip?: number;
    take?: number;
  }): Promise<WorkflowInstanceRow[]>;
  countInstances(status?: InstanceStatus): Promise<number>;
  updateInstance(id: string, patch: Partial<WorkflowInstanceRow>): Promise<WorkflowInstanceRow>;

  createTask(
    row: Omit<WorkflowTaskRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<WorkflowTaskRow>;
  findTask(id: string, organizationId: string): Promise<WorkflowTaskRow>;
  listTasks(options: { status?: TaskStatus; instanceId?: string }): Promise<WorkflowTaskRow[]>;
  updateTask(id: string, patch: Partial<WorkflowTaskRow>): Promise<WorkflowTaskRow>;

  appendHistory(
    row: Omit<WorkflowHistoryRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<WorkflowHistoryRow>;
  listHistory(instanceId: string): Promise<WorkflowHistoryRow[]>;
  listTaskHistory(taskId: string): Promise<WorkflowHistoryRow[]>;
}

export class PrismaWorkflowStore implements WorkflowStore {
  private readonly definitions: ModuleRepository<WorkflowDefinitionRow>;
  private readonly instances: ModuleRepository<WorkflowInstanceRow>;
  private readonly tasks: ModuleRepository<WorkflowTaskRow>;
  private readonly history: ModuleRepository<WorkflowHistoryRow>;

  constructor(context: ModuleContext<WorkflowConfig>) {
    const { prisma, moduleId } = context;
    this.definitions = new ModuleRepository(prisma, 'workflowDefinition', moduleId);
    this.instances = new ModuleRepository(prisma, 'workflowInstance', moduleId);
    this.tasks = new ModuleRepository(prisma, 'workflowTask', moduleId);
    this.history = new ModuleRepository(prisma, 'workflowHistoryEntry', moduleId);
  }

  listDefinitions(): Promise<WorkflowDefinitionRow[]> {
    return this.definitions.list({ orderBy: { key: 'asc' } });
  }

  findDefinition(key: string): Promise<WorkflowDefinitionRow | null> {
    return this.definitions.findFirst({ key });
  }

  createDefinition(
    row: Omit<
      WorkflowDefinitionRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<WorkflowDefinitionRow> {
    return this.definitions.create({ ...row });
  }

  createInstance(
    row: Omit<
      WorkflowInstanceRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<WorkflowInstanceRow> {
    return this.instances.create({ ...row });
  }

  findInstance(id: string, organizationId: string): Promise<WorkflowInstanceRow> {
    return this.instances.findById(id, organizationId);
  }

  listInstances(options: {
    status?: InstanceStatus;
    skip?: number;
    take?: number;
  }): Promise<WorkflowInstanceRow[]> {
    return this.instances.list({
      ...(options.status ? { where: { status: options.status } } : {}),
      ...(options.skip === undefined ? {} : { skip: options.skip }),
      ...(options.take === undefined ? {} : { take: options.take }),
    });
  }

  countInstances(status?: InstanceStatus): Promise<number> {
    return this.instances.count(status ? { status } : {});
  }

  updateInstance(id: string, patch: Partial<WorkflowInstanceRow>): Promise<WorkflowInstanceRow> {
    return this.instances.update(id, { ...patch });
  }

  createTask(
    row: Omit<WorkflowTaskRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<WorkflowTaskRow> {
    return this.tasks.create({ ...row });
  }

  findTask(id: string, organizationId: string): Promise<WorkflowTaskRow> {
    return this.tasks.findById(id, organizationId);
  }

  listTasks(options: { status?: TaskStatus; instanceId?: string }): Promise<WorkflowTaskRow[]> {
    return this.tasks.list({
      where: {
        ...(options.status ? { status: options.status } : {}),
        ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      },
      orderBy: { dueAt: 'asc' },
    });
  }

  updateTask(id: string, patch: Partial<WorkflowTaskRow>): Promise<WorkflowTaskRow> {
    return this.tasks.update(id, { ...patch });
  }

  appendHistory(
    row: Omit<WorkflowHistoryRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<WorkflowHistoryRow> {
    return this.history.create({ ...row });
  }

  listHistory(instanceId: string): Promise<WorkflowHistoryRow[]> {
    return this.history.list({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
  }

  listTaskHistory(taskId: string): Promise<WorkflowHistoryRow[]> {
    return this.history.list({ where: { taskId }, orderBy: { createdAt: 'asc' } });
  }
}

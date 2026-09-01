import { Inject, Injectable } from '@nestjs/common';
import type { AuditService } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import type { AppPrismaService } from '../../../core/prisma.service';
import { AUDIT_SERVICE } from '../../../tokens';
import { TenantRepository } from '../../../common/tenant-repository';

/**
 * TrustOS ERP domain service.
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

export interface DepartmentRow {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  parentId: string | null;
  costCentre: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface EmployeeRow {
  id: string;
  organizationId: string;
  employeeNumber: string;
  userId: string | null;
  departmentId: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  startedOn: Date;
  status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'LEFT';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface ProjectRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  departmentId: string;
  managerEmployeeId: string | null;
  budget: string;
  currency: string;
  startsOn: Date | null;
  endsOn: Date | null;
  status: 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface InventoryItemRow {
  id: string;
  organizationId: string;
  sku: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  reorderLevel: number;
  location: string | null;
  unitCost: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface PurchaseRequestRow {
  id: string;
  organizationId: string;
  reference: string;
  departmentId: string;
  requestedByEmployeeId: string;
  projectId: string | null;
  description: string;
  estimatedAmount: string;
  currency: string;
  workflowInstanceId: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'ORDERED' | 'RECEIVED' | 'CANCELLED';
  neededBy: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class ErpService {
  private readonly departments: TenantRepository<DepartmentRow>;
  private readonly employees: TenantRepository<EmployeeRow>;
  private readonly projects: TenantRepository<ProjectRow>;
  private readonly inventoryItems: TenantRepository<InventoryItemRow>;
  private readonly purchaseRequests: TenantRepository<PurchaseRequestRow>;

  constructor(
    @Inject(PrismaService) prisma: AppPrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {
    this.departments = new TenantRepository<DepartmentRow>(prisma, 'department');
    this.employees = new TenantRepository<EmployeeRow>(prisma, 'employee');
    this.projects = new TenantRepository<ProjectRow>(prisma, 'project');
    this.inventoryItems = new TenantRepository<InventoryItemRow>(prisma, 'inventoryItem');
    this.purchaseRequests = new TenantRepository<PurchaseRequestRow>(prisma, 'purchaseRequest');
  }

  // --- departments -------------------------------------------------

  listDepartments(): Promise<DepartmentRow[]> {
    return this.departments.list();
  }

  findDepartment(id: string, organizationId: string): Promise<DepartmentRow> {
    return this.departments.findById(id, organizationId);
  }

  async createDepartment(
    input: {
      name: string;
      code: string;
      parentId?: string;
      costCentre?: string;
    },
    organizationId: string,
  ): Promise<DepartmentRow> {
    if (input.parentId !== undefined) {
      await this.departments.findById(input.parentId, organizationId);
    }

    const created = await this.departments.create({
      name: input.name,
      code: input.code,
      parentId: input.parentId ?? null,
      costCentre: input.costCentre ?? null,
    });

    await this.audit.record({
      action: 'erp.department.created',
      entityType: 'Department',
      entityId: created.id,
      organizationId,
      after: { name: created.name, code: created.code, parentId: created.parentId },
    });

    return created;
  }

  async updateDepartment(
    id: string,
    changes: {
      name?: string;
      parentId?: string;
      costCentre?: string;
    },
    organizationId: string,
  ): Promise<DepartmentRow> {
    const existing = await this.departments.findById(id, organizationId);

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

    const updated = await this.departments.update(id, changes);

    await this.audit.recordChange({
      action: 'erp.department.updated',
      entityType: 'Department',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- employees ---------------------------------------------------

  listEmployees(): Promise<EmployeeRow[]> {
    return this.employees.list();
  }

  findEmployee(id: string, organizationId: string): Promise<EmployeeRow> {
    return this.employees.findById(id, organizationId);
  }

  async createEmployee(
    input: {
      employeeNumber: string;
      userId?: string;
      departmentId: string;
      fullName: string;
      jobTitle?: string;
      email?: string;
      startedOn: Date;
      status?: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'LEFT';
    },
    organizationId: string,
  ): Promise<EmployeeRow> {
    await this.departments.findById(input.departmentId, organizationId);

    const created = await this.employees.create({
      employeeNumber: input.employeeNumber,
      userId: input.userId ?? null,
      departmentId: input.departmentId,
      fullName: input.fullName,
      jobTitle: input.jobTitle ?? null,
      email: input.email ?? null,
      startedOn: input.startedOn,
      status: input.status,
    });

    await this.audit.record({
      action: 'erp.employee.created',
      entityType: 'Employee',
      entityId: created.id,
      organizationId,
      after: {
        employeeNumber: created.employeeNumber,
        userId: created.userId,
        departmentId: created.departmentId,
      },
    });

    return created;
  }

  async updateEmployee(
    id: string,
    changes: {
      userId?: string;
      departmentId?: string;
      fullName?: string;
      jobTitle?: string;
      email?: string;
      startedOn?: Date;
      status?: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'LEFT';
    },
    organizationId: string,
  ): Promise<EmployeeRow> {
    const existing = await this.employees.findById(id, organizationId);

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

    const updated = await this.employees.update(id, changes);

    await this.audit.recordChange({
      action: 'erp.employee.updated',
      entityType: 'Employee',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- projects ----------------------------------------------------

  listProjects(): Promise<ProjectRow[]> {
    return this.projects.list();
  }

  findProject(id: string, organizationId: string): Promise<ProjectRow> {
    return this.projects.findById(id, organizationId);
  }

  async createProject(
    input: {
      code: string;
      name: string;
      departmentId: string;
      managerEmployeeId?: string;
      budget: string;
      currency: string;
      startsOn?: Date;
      endsOn?: Date;
      status?: 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<ProjectRow> {
    await this.departments.findById(input.departmentId, organizationId);
    if (input.managerEmployeeId !== undefined) {
      await this.employees.findById(input.managerEmployeeId, organizationId);
    }

    const created = await this.projects.create({
      code: input.code,
      name: input.name,
      departmentId: input.departmentId,
      managerEmployeeId: input.managerEmployeeId ?? null,
      budget: input.budget,
      currency: input.currency,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      status: input.status,
    });

    await this.audit.record({
      action: 'erp.project.created',
      entityType: 'Project',
      entityId: created.id,
      organizationId,
      after: { code: created.code, name: created.name, departmentId: created.departmentId },
    });

    return created;
  }

  async updateProject(
    id: string,
    changes: {
      name?: string;
      departmentId?: string;
      managerEmployeeId?: string;
      budget?: string;
      currency?: string;
      startsOn?: Date;
      endsOn?: Date;
      status?: 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
    },
    organizationId: string,
  ): Promise<ProjectRow> {
    const existing = await this.projects.findById(id, organizationId);

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

    const updated = await this.projects.update(id, changes);

    await this.audit.recordChange({
      action: 'erp.project.updated',
      entityType: 'Project',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- inventory ---------------------------------------------------

  listInventoryItems(): Promise<InventoryItemRow[]> {
    return this.inventoryItems.list();
  }

  findInventoryItem(id: string, organizationId: string): Promise<InventoryItemRow> {
    return this.inventoryItems.findById(id, organizationId);
  }

  async createInventoryItem(
    input: {
      sku: string;
      name: string;
      unit: string;
      quantityOnHand?: number;
      reorderLevel?: number;
      location?: string;
      unitCost: string;
      currency: string;
    },
    organizationId: string,
  ): Promise<InventoryItemRow> {
    const created = await this.inventoryItems.create({
      sku: input.sku,
      name: input.name,
      unit: input.unit,
      quantityOnHand: input.quantityOnHand,
      reorderLevel: input.reorderLevel,
      location: input.location ?? null,
      unitCost: input.unitCost,
      currency: input.currency,
    });

    await this.audit.record({
      action: 'erp.inventory-item.created',
      entityType: 'InventoryItem',
      entityId: created.id,
      organizationId,
      after: { sku: created.sku, name: created.name, unit: created.unit },
    });

    return created;
  }

  async updateInventoryItem(
    id: string,
    changes: {
      name?: string;
      unit?: string;
      quantityOnHand?: number;
      reorderLevel?: number;
      location?: string;
      unitCost?: string;
      currency?: string;
    },
    organizationId: string,
  ): Promise<InventoryItemRow> {
    const existing = await this.inventoryItems.findById(id, organizationId);

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

    const updated = await this.inventoryItems.update(id, changes);

    await this.audit.recordChange({
      action: 'erp.inventory-item.updated',
      entityType: 'InventoryItem',
      entityId: id,
      organizationId,
      before: pick(existing, Object.keys(changes)),
      after: pick(updated, Object.keys(changes)),
    });

    return updated;
  }

  // --- purchase requests -------------------------------------------

  listPurchaseRequests(): Promise<PurchaseRequestRow[]> {
    return this.purchaseRequests.list();
  }

  findPurchaseRequest(id: string, organizationId: string): Promise<PurchaseRequestRow> {
    return this.purchaseRequests.findById(id, organizationId);
  }

  async createPurchaseRequest(
    input: {
      reference: string;
      departmentId: string;
      requestedByEmployeeId: string;
      projectId?: string;
      description: string;
      estimatedAmount: string;
      currency: string;
      workflowInstanceId?: string;
      status?:
        'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'ORDERED' | 'RECEIVED' | 'CANCELLED';
      neededBy?: Date;
    },
    organizationId: string,
  ): Promise<PurchaseRequestRow> {
    await this.departments.findById(input.departmentId, organizationId);
    await this.employees.findById(input.requestedByEmployeeId, organizationId);
    if (input.projectId !== undefined) {
      await this.projects.findById(input.projectId, organizationId);
    }

    const created = await this.purchaseRequests.create({
      reference: input.reference,
      departmentId: input.departmentId,
      requestedByEmployeeId: input.requestedByEmployeeId,
      projectId: input.projectId ?? null,
      description: input.description,
      estimatedAmount: input.estimatedAmount,
      currency: input.currency,
      workflowInstanceId: input.workflowInstanceId ?? null,
      status: input.status,
      neededBy: input.neededBy ?? null,
    });

    await this.audit.record({
      action: 'erp.purchase-request.created',
      entityType: 'PurchaseRequest',
      entityId: created.id,
      organizationId,
      after: {
        reference: created.reference,
        departmentId: created.departmentId,
        requestedByEmployeeId: created.requestedByEmployeeId,
      },
    });

    return created;
  }

  async updatePurchaseRequest(
    id: string,
    changes: {
      departmentId?: string;
      requestedByEmployeeId?: string;
      projectId?: string;
      description?: string;
      estimatedAmount?: string;
      currency?: string;
      workflowInstanceId?: string;
      status?:
        'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'ORDERED' | 'RECEIVED' | 'CANCELLED';
      neededBy?: Date;
    },
    organizationId: string,
  ): Promise<PurchaseRequestRow> {
    const existing = await this.purchaseRequests.findById(id, organizationId);

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

    const updated = await this.purchaseRequests.update(id, changes);

    await this.audit.recordChange({
      action: 'erp.purchase-request.updated',
      entityType: 'PurchaseRequest',
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

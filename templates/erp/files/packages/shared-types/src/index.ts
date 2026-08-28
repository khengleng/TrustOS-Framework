/**
 * Shared types — TrustOS ERP.
 *
 * The shapes the API returns and the admin consumes. One definition, imported by both, so a
 * renamed field is a compile error rather than an empty column.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull a server-only
 * module into a browser bundle. The admin application imports this package directly, so anything
 * reachable from here reaches the client.
 */

/** ISO-8601 timestamp as it crosses the API boundary. */
export type IsoDateTime = string;

/** Fields every tenant-owned entity exposes. */
export interface TenantOwnedSummary {
  id: string;
  organizationId: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** An organizational unit. Nests via `parentId`. */
export interface Department {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  costCentre: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A person working for the organization. `userId` links to the framework identity; authorization */
/** is RBAC, never a job title. */
export interface Employee {
  id: string;
  employeeNumber: string;
  userId: string | null;
  departmentId: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  startedOn: Date;
  status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'LEFT';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A piece of work with a budget and an owner. */
export interface Project {
  id: string;
  code: string;
  name: string;
  departmentId: string;
  managerEmployeeId: string | null;
  budget: string;
  currency: string;
  startsOn: Date | null;
  endsOn: Date | null;
  status: 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** What is held, where. An *interface* to whatever system actually owns stock — see the migration */
/** note before treating this as a warehouse system. */
export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  reorderLevel: number;
  location: string | null;
  unitCost: string;
  currency: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A request to buy something, approved through the framework workflow. The decision is in the */
/** workflow instance; this row holds what was asked for. */
export interface PurchaseRequest {
  id: string;
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
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

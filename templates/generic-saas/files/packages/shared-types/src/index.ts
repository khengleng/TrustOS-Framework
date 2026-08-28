/**
 * Types shared between the API and the admin application.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull
 * a server-only module into a browser bundle.
 */

export type WorkspaceItemStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface WorkspaceItemSummary {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  status: WorkspaceItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceItemRequest {
  name: string;
  description?: string;
  status?: WorkspaceItemStatus;
}

export interface UpdateWorkspaceItemRequest {
  name?: string;
  description?: string;
  status?: WorkspaceItemStatus;
}

/**
 * Types shared between the API and the admin application.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull
 * a server-only module into a browser bundle.
 */

export type MerchantStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';
export type StoreStatus = 'ACTIVE' | 'CLOSED';

export interface MerchantSummary {
  id: string;
  organizationId: string;
  name: string;
  legalName: string | null;
  code: string;
  status: MerchantStatus;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreSummary {
  id: string;
  organizationId: string;
  merchantId: string;
  name: string;
  code: string;
  status: StoreStatus;
  timezone: string;
  createdAt: string;
}

export interface BranchSummary {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  code: string;
  addressLine: string | null;
  city: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface MerchantMemberSummary {
  id: string;
  organizationId: string;
  merchantId: string;
  userId: string;
  position: string | null;
  isPrimary: boolean;
  createdAt: string;
}

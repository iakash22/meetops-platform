import type { Role } from '../modules/organizations/domain/membership.js';

/**
 * Built from the authenticated session + membership, never from request input.
 * Tenant-scoped repositories take this as their first argument so a future
 * withOrgContext(organizationId, fn) RLS transaction wrapper can be applied in one place.
 */
export interface TenantContext {
  organizationId: string;
  userId: string;
  role: Role;
}

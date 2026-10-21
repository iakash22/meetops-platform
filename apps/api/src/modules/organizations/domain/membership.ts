import type { Role } from '../../../shared/contracts/index.js';

export type { Role };
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const satisfies readonly Role[];

export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt: Date;
  deletedAt: Date | null;
}

/** Roles a given role may grant via invitation. Owners are only created at org creation. */
export function canGrantRole(actor: Role, target: Role): boolean {
  if (target === 'owner') return false;
  if (actor === 'owner') return true;
  if (actor === 'admin') return target !== 'admin';
  return false;
}

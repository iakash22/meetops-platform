import type { Role } from '@meetops/contracts';

export type { Role };
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const satisfies readonly Role[];

export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt: Date | null;
}

/**
 * Role change / removal rules (auth-session-spec AU-29..31). Pure: the last-owner check is
 * enforced atomically by the repository.
 * - Only owners and admins manage members; nobody changes their own role except an owner demoting self.
 * - Admins cannot touch owners or other admins, and cannot grant admin/owner.
 * - Owners can do anything to anyone (last-owner protection still applies).
 */
export function canChangeMemberRole(
  actor: { userId: string; role: Role },
  target: { userId: string; role: Role },
  to: Role,
): boolean {
  if (actor.role === 'owner') return true;
  if (actor.role !== 'admin') return false;
  if (actor.userId === target.userId) return false;
  if (target.role === 'owner' || target.role === 'admin') return false;
  return to === 'member' || to === 'viewer';
}

export function canRemoveMember(
  actor: { userId: string; role: Role },
  target: { userId: string; role: Role },
): boolean {
  // Anyone may leave; the last-owner rule still applies.
  if (actor.userId === target.userId) return true;
  if (actor.role === 'owner') return true;
  if (actor.role !== 'admin') return false;
  return target.role === 'member' || target.role === 'viewer';
}

/** Roles a given role may grant via invitation. Owners are only created at org creation. */
export function canGrantRole(actor: Role, target: Role): boolean {
  if (target === 'owner') return false;
  if (actor === 'owner') return true;
  if (actor === 'admin') return target !== 'admin';
  return false;
}

import type { Role } from '@meetops/contracts';
import type { InvitableRole } from '@/lib/api/client';

/**
 * Client-side mirror of the API's membership rules (apps/api organizations
 * domain/abilities.ts CASL rules + domain/membership.ts). Used only to decide what
 * to show; the API enforces them and its 403/409 is always handled.
 */
export const ROLE_ORDER: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

type Actor = { userId: string; role: Role };
type Target = { userId: string; role: Role };

/** CASL: owner manages all; admin may create/update/delete Membership and Invitation. */
export function canManageMembers(role: Role | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** canGrantRole: owners invite any non-owner role; admins invite member/viewer. */
export function invitableRoles(actor: Role | null | undefined): InvitableRole[] {
  if (actor === 'owner') return ['admin', 'member', 'viewer'];
  if (actor === 'admin') return ['member', 'viewer'];
  return [];
}

/** canChangeMemberRole: roles `actor` may set on `target` (empty: no change allowed). */
export function assignableRoles(actor: Actor, target: Target): Role[] {
  if (actor.role === 'owner') return [...ROLE_ORDER];
  if (actor.role !== 'admin' || actor.userId === target.userId) return [];
  if (target.role === 'owner' || target.role === 'admin') return [];
  return ['member', 'viewer'];
}

/** canRemoveMember (self-leave is not offered on this screen). */
export function canRemove(actor: Actor, target: Target): boolean {
  if (actor.userId === target.userId) return false;
  if (actor.role === 'owner') return true;
  return actor.role === 'admin' && (target.role === 'member' || target.role === 'viewer');
}

import { DomainError } from '../../../shared/domain-error.js';
import type { Role } from './membership.js';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  /** SHA-256 of the invitation token. */
  tokenHash: string;
  invitedById: string;
  status: InvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  acceptedById: string | null;
  revokedAt: Date | null;
  deletedAt: Date | null;
}

/** Invitation tokens are opaque (no organizationId); lookup is global by token hash. */
export class InvitationError extends DomainError {}

export const invitationErrors = {
  notFound: () => new InvitationError('NOT_FOUND', 'Invitation not found', 404),
  expired: () => new InvitationError('CONFLICT', 'Invitation has expired', 409, 'INVITATION_EXPIRED'),
  revoked: () => new InvitationError('CONFLICT', 'Invitation was revoked', 409, 'INVITATION_REVOKED'),
  accepted: () => new InvitationError('CONFLICT', 'Invitation was already accepted', 409, 'INVITATION_ALREADY_ACCEPTED'),
  emailMismatch: () =>
    new InvitationError('FORBIDDEN', 'Invitation was issued to a different email', 403)
};

export function isExpired(inv: Invitation, now: Date): boolean {
  return inv.expiresAt.getTime() <= now.getTime();
}

/** Pure rule: returns the accepted invitation or throws. */
export function acceptInvitation(inv: Invitation, by: { userId: string; email: string }, now: Date): Invitation {
  if (inv.status === 'revoked') throw invitationErrors.revoked();
  if (inv.status === 'accepted') throw invitationErrors.accepted();
  if (isExpired(inv, now)) throw invitationErrors.expired();
  if (inv.email !== by.email) throw invitationErrors.emailMismatch();
  return { ...inv, status: 'accepted', acceptedAt: now, acceptedById: by.userId };
}

/** Pure rule: only pending invitations can be revoked. */
export function revokeInvitation(inv: Invitation, now: Date): Invitation {
  if (inv.status === 'accepted') throw invitationErrors.accepted();
  if (inv.status === 'revoked') throw invitationErrors.revoked();
  return { ...inv, status: 'revoked', revokedAt: now };
}

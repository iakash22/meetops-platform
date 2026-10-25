import { ApiError } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-messages';

export type MemberAction = 'invite' | 'revoke' | 'role' | 'remove';

/** Fixed text per action and status; server messages are never shown. */
export function memberActionMessage(action: MemberAction, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      if (err.reason === 'LAST_OWNER') return 'An organization must keep at least one owner.';
      if (action === 'invite') return 'That person is already a member of this organization.';
      if (action === 'revoke') return 'Only pending invitations can be revoked.';
    }
    if (err.status === 403 && err.code === 'FORBIDDEN') {
      if (action === 'invite') return "You can't invite people with that role.";
      if (action === 'role') return "You can't change this member's role.";
      if (action === 'remove') return "You can't remove this member.";
    }
    if (err.status === 404) {
      if (action === 'revoke') return 'That invitation no longer exists.';
      if (action === 'role' || action === 'remove') return 'That person is no longer a member.';
    }
    if (err.status === 400 && action === 'invite') return 'Enter a valid email address.';
  }
  return describeError(err).message;
}

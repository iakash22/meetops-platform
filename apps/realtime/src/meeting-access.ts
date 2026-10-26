import { withOrganizationContext, getPrismaClient, type DatabaseClient } from '@meetops/database';
import { MEETING_ID_PATTERN, type MeetingAccessInput } from './events.js';

/**
 * ADR-011 section 4.1: the meeting exists, is not deleted and belongs to the socket's organization, read under
 * withOrganizationContext so forced RLS hides every other org's rows even if the where clause were wrong.
 * No row (missing, deleted or other org) -> false; the caller acks all three identically. DB errors propagate so the
 * caller fails closed. Team or project scoping is added on top of this later, never instead of it (4.3).
 */
export function createPrismaMeetingAccess(
  client?: DatabaseClient,
): (input: MeetingAccessInput) => Promise<boolean> {
  const db = () => client ?? getPrismaClient();
  return async ({ organizationId, userId, meetingId }) => {
    if (!MEETING_ID_PATTERN.test(meetingId) || !MEETING_ID_PATTERN.test(organizationId))
      return false;
    const row = await withOrganizationContext(
      organizationId,
      (tx) =>
        tx.meeting.findFirst({
          where: { id: meetingId, organizationId, deletedAt: null },
          select: { id: true },
        }),
      { client: db(), userId },
    );
    return row !== null;
  };
}

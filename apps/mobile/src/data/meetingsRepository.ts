import type { Meeting } from '@meetops/contracts';

/**
 * Read side of meetings for the Meetings tab. The API has no list-meetings route yet
 * (Backend), so only a placeholder implementation exists. Screens depend on this interface only.
 */
export interface MeetingsRepository {
  /** Meetings of one organization, newest first. Never mixes organizations. */
  list: (organizationId: string) => Promise<Meeting[]>;
}

const T = '2026-10-20T09:00:00.000Z';

function placeholder(
  organizationId: string,
  n: number,
  title: string,
  status: Meeting['status'],
): Meeting {
  return {
    id: `00000000-0000-4000-9000-${organizationId.slice(-4)}0000000${n}`,
    organizationId,
    title,
    source: 'upload',
    status,
    createdById: null,
    createdAt: T,
    updatedAt: T,
  };
}

export function createPlaceholderMeetingsRepository(latencyMs = 0): MeetingsRepository {
  return {
    async list(organizationId) {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return [
        placeholder(organizationId, 1, 'Weekly sync', 'completed'),
        placeholder(organizationId, 2, 'Design review', 'recording'),
        placeholder(organizationId, 3, 'Customer call', 'processing'),
        placeholder(organizationId, 4, 'Quarterly planning', 'scheduled'),
      ];
    },
  };
}

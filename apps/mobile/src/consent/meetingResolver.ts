import type { ResolveMeetingRequest, ResolveMeetingResponse } from '@meetops/contracts';

/**
 * Server meeting id for a mobile recording (Low from review: no more local ids in the consent attestation).
 * Live mode calls `POST /orgs/:organizationId/meetings/resolve` (contracts `ResolveMeetingRequest`) with
 * source `mobile` and a fresh per-recording `externalMeetingId`, so every
 * recording gets its own server meeting. Failure means no recording starts.
 */
export interface MeetingResolver {
  resolve(organizationId: string, startedAt: string): Promise<string>;
}

type Request = <T>(method: 'POST', path: string, body?: unknown, expect?: number) => Promise<T>;

const randomHex = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');

export function newExternalMeetingId(): string {
  return `mobile:${Date.now().toString(36)}-${randomHex(16)}`;
}

export function createHttpMeetingResolver(request: Request): MeetingResolver {
  return {
    async resolve(organizationId, startedAt) {
      const body: ResolveMeetingRequest = {
        source: 'mobile',
        externalMeetingId: newExternalMeetingId(),
        title: 'Mobile recording',
        startedAt,
      };
      const res = await request<ResolveMeetingResponse>(
        'POST',
        `/orgs/${encodeURIComponent(organizationId)}/meetings/resolve`,
        body,
      );
      return res.meetingId;
    },
  };
}

/** Demo mode: a UUID-shaped id, nothing leaves the device. */
export function createDemoMeetingResolver(): MeetingResolver {
  return {
    resolve: () =>
      Promise.resolve(
        `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-8${randomHex(3)}-${randomHex(12)}`,
      ),
  };
}

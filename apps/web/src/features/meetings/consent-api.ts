import type {
  Id,
  MeetingConsentEvent,
  MeetingConsentStatus,
  RecordMeetingConsentRequest,
  RevokeMeetingConsentRequest,
  Role,
} from '@meetops/contracts';
import { fillPath } from '@/features/uploads/types';

export type {
  MeetingConsentEvent,
  MeetingConsentStatus,
  RecordMeetingConsentRequest,
  RevokeMeetingConsentRequest,
};

/**
 * Mirrors contracts MEETING_CONSENT_PATHS (#334). That constant lives in the TypeBox entry, so it is copied here to
 * keep TypeBox out of the web bundle; test/contract-paths.test.ts asserts parity.
 */
export const MEETING_CONSENT_PATHS = {
  consent: '/orgs/:organizationId/meetings/:meetingId/consent',
  revoke: '/orgs/:organizationId/meetings/:meetingId/consent/revoke',
} as const;

/** Roles the API lets record or revoke (owner/admin/member). Viewers get 403. UI hint only. */
export const MEETING_CONSENT_WRITE_ROLES: readonly Role[] = ['owner', 'admin', 'member'];
/** contracts MAX_CONSENT_REVOCATION_REASON_LENGTH. */
export const MAX_REVOCATION_REASON_LENGTH = 500;

export const meetingConsentQueryKey = (organizationId: Id, meetingId: Id) =>
  ['orgs', organizationId, 'meetings', meetingId, 'consent'] as const;

export type MeetingConsentApi = {
  /** GET .../consent: status + history (newest first). Every role. */
  status: (organizationId: Id, meetingId: Id) => Promise<MeetingConsentStatus>;
  /** POST .../consent (201). Owner/admin/member; 422 CONSENT_* when missing/invalid. */
  record: (
    organizationId: Id,
    meetingId: Id,
    body: RecordMeetingConsentRequest,
  ) => Promise<MeetingConsentEvent>;
  /** POST .../consent/revoke (201). Owner/admin/member. Append-only: earlier grants stay. */
  revoke: (
    organizationId: Id,
    meetingId: Id,
    body: RevokeMeetingConsentRequest,
  ) => Promise<MeetingConsentEvent>;
};

type Req = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<T>;

export function meetingConsentPath(template: string, organizationId: Id, meetingId: Id): string {
  return fillPath(template, { organizationId, meetingId });
}

export function createHttpMeetingConsentApi(request: Req): MeetingConsentApi {
  return {
    status: (o, m) => request('GET', meetingConsentPath(MEETING_CONSENT_PATHS.consent, o, m)),
    record: (o, m, body) =>
      request('POST', meetingConsentPath(MEETING_CONSENT_PATHS.consent, o, m), body),
    revoke: (o, m, body) =>
      request('POST', meetingConsentPath(MEETING_CONSENT_PATHS.revoke, o, m), body),
  };
}

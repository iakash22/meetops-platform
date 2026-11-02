import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { ConsentMethod, ConsentVersion } from './consent.js';

/**
 * Unreleased: meeting-level recording consent ledger (Consent API). Append-only: a grant and a revocation are both
 * events; nothing is updated or deleted. `organizationId` and `actorUserId` always come from the authenticated session,
 * never from the request; a meeting of another organization is 404 NOT_FOUND.
 *
 * This complements the per-subject `ConsentAttestationInput` (G11) carried by upload / recording-session init. With
 * the API's CONSENT_ENFORCEMENT_ENABLED flag on, init and complete additionally require the meeting's latest consent
 * event to be a `granted` event for CURRENT_CONSENT_VERSION (422 VALIDATION_FAILED + `CONSENT_REQUIRED` otherwise).
 */

/** Kinds of consent events. A revocation supersedes every earlier grant for the meeting. */
export const MEETING_CONSENT_EVENT_TYPES = ['granted', 'revoked'] as const;
export const MeetingConsentEventType = Type.Union(
  MEETING_CONSENT_EVENT_TYPES.map((t) => Type.Literal(t)),
);
export type MeetingConsentEventType = (typeof MEETING_CONSENT_EVENT_TYPES)[number];

/** Derived consent state of a meeting: `none` (no event yet), else the type of the latest event. */
export const MEETING_CONSENT_STATES = ['none', 'granted', 'revoked'] as const;
export const MeetingConsentState = Type.Union(MEETING_CONSENT_STATES.map((t) => Type.Literal(t)));
export type MeetingConsentState = (typeof MEETING_CONSENT_STATES)[number];

/** Max length of a free-text revocation reason. */
export const MAX_CONSENT_REVOCATION_REASON_LENGTH = 500;
/** Max events returned by the status route (newest first). */
export const MAX_MEETING_CONSENT_EVENTS = 100;

/**
 * Route templates. Org-scoped: `:organizationId` must be the caller's active organization (else NOT_FOUND).
 * - `consent`: GET -> `MeetingConsentStatus` (every role); POST `RecordMeetingConsentRequest` -> 201 `MeetingConsentEvent`
 *   (owner/admin/member; CSRF).
 * - `revoke`: POST `RevokeMeetingConsentRequest` -> 201 `MeetingConsentEvent` (owner/admin/member; CSRF).
 */
export const MEETING_CONSENT_PATHS = {
  consent: '/orgs/:organizationId/meetings/:meetingId/consent',
  revoke: '/orgs/:organizationId/meetings/:meetingId/consent/revoke',
} as const;

/** Strict: no org, user or meeting id in the body (they come from the session and the path). */
export const RecordMeetingConsentRequest = Type.Object(
  {
    consentVersion: ConsentVersion,
    /** Client clock; rejected (CONSENT_INVALID) if more than CONSENT_ATTESTATION_MAX_SKEW_SECONDS ahead. */
    attestedAt: IsoDateTime,
    method: ConsentMethod,
  },
  { additionalProperties: false },
);
export type RecordMeetingConsentRequest = Static<typeof RecordMeetingConsentRequest>;

export const RevokeMeetingConsentRequest = Type.Object(
  {
    reason: Type.Optional(
      Type.String({ minLength: 1, maxLength: MAX_CONSENT_REVOCATION_REASON_LENGTH }),
    ),
  },
  { additionalProperties: false },
);
export type RevokeMeetingConsentRequest = Static<typeof RevokeMeetingConsentRequest>;

/** One stored event (DB `meeting_consent_events`). Grant fields are null on a revocation and vice versa. */
export const MeetingConsentEvent = Type.Object(
  {
    id: Id,
    meetingId: Id,
    eventType: MeetingConsentEventType,
    consentVersion: Type.Union([ConsentVersion, Type.Null()]),
    method: Type.Union([ConsentMethod, Type.Null()]),
    reason: Type.Union([
      Type.String({ maxLength: MAX_CONSENT_REVOCATION_REASON_LENGTH }),
      Type.Null(),
    ]),
    /** Server-filled from the authenticated session. */
    actorUserId: Id,
    /** Client attestation time for a grant; server time for a revocation. */
    occurredAt: IsoDateTime,
    /** Server receive time. */
    recordedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type MeetingConsentEvent = Static<typeof MeetingConsentEvent>;

export const MeetingConsentStatus = Type.Object(
  {
    meetingId: Id,
    state: MeetingConsentState,
    /** True only when `state` is `granted` and the grant is for CURRENT_CONSENT_VERSION. */
    valid: Type.Boolean(),
    latest: Type.Union([MeetingConsentEvent, Type.Null()]),
    /** Newest first, at most MAX_MEETING_CONSENT_EVENTS. */
    events: Type.Array(MeetingConsentEvent, { maxItems: MAX_MEETING_CONSENT_EVENTS }),
  },
  { additionalProperties: false },
);
export type MeetingConsentStatus = Static<typeof MeetingConsentStatus>;

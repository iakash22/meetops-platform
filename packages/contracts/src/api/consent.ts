import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import {
  CONSENT_ERROR_REASONS,
  CONSENT_METHODS,
  CONSENT_SUBJECT_TYPES,
  CONSENT_VERSION_PATTERN,
} from '../constants.js';

/**
 * v0.4.1 (G11): server-side consent attestation. Upload init (`InitUploadRequest`) and recording-session init
 * (`InitRecordingSessionRequest`) MUST carry a `consent` object. The API rejects a request without one with 422
 * `VALIDATION_FAILED` + `reason: 'CONSENT_REQUIRED'`, persists every accepted attestation (DB-3 `consent_attestations`,
 * append-only), and the media pipeline MUST NOT process a recording or upload that has no stored attestation.
 */
export {
  CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS,
  CONSENT_ATTESTATION_MAX_SKEW_SECONDS,
  CONSENT_ERROR_REASONS,
  CONSENT_HTTP_STATUS,
  CONSENT_METHODS,
  CONSENT_SUBJECT_TYPES,
  CONSENT_VERSION_PATTERN,
  CURRENT_CONSENT_VERSION,
} from '../constants.js';

/** How consent was obtained. See CONSENT_METHODS. */
export const ConsentMethod = Type.Union(CONSENT_METHODS.map((m) => Type.Literal(m)));
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** Version of the consent notice the user attested to (CURRENT_CONSENT_VERSION today). */
export const ConsentVersion = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: CONSENT_VERSION_PATTERN,
});
export type ConsentVersion = Static<typeof ConsentVersion>;

/** What an attestation is attached to. See CONSENT_SUBJECT_TYPES. */
export const ConsentSubjectType = Type.Union(CONSENT_SUBJECT_TYPES.map((t) => Type.Literal(t)));
export type ConsentSubjectType = (typeof CONSENT_SUBJECT_TYPES)[number];

/** Named reason for a consent rejection (422). See CONSENT_ERROR_REASONS. */
export const ConsentErrorReason = Type.Union(CONSENT_ERROR_REASONS.map((r) => Type.Literal(r)));
export type ConsentErrorReason = (typeof CONSENT_ERROR_REASONS)[number];

/**
 * The attestation a client sends. Strict: a client cannot send `attestedByUserId`, `organizationId` or a subject id.
 * The server fills those from the authenticated session and the created resource (UP-18), so an attestation cannot be
 * made on behalf of another user or organization.
 */
export const ConsentAttestationInput = Type.Object(
  {
    consentVersion: ConsentVersion,
    /** When the user attested, by the client's clock. Rejected if more than CONSENT_ATTESTATION_MAX_SKEW_SECONDS ahead
     * or CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS behind. */
    attestedAt: IsoDateTime,
    method: ConsentMethod,
  },
  { additionalProperties: false },
);
export type ConsentAttestationInput = Static<typeof ConsentAttestationInput>;

/**
 * INTERNAL (api/worker, DB-3 `consent_attestations` row). A stored attestation. `attestedByUserId` and
 * `organizationId` are server-filled from the session; `recordedAt` is the server's receive time.
 */
export const ConsentAttestation = Type.Object(
  {
    id: Id,
    organizationId: Id,
    subjectType: ConsentSubjectType,
    /** FileObject id for `upload`, recording session id for `recording_session`. */
    subjectId: Id,
    consentVersion: ConsentVersion,
    method: ConsentMethod,
    /** Server-filled from the authenticated session; never taken from the request. */
    attestedByUserId: Id,
    attestedAt: IsoDateTime,
    recordedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type ConsentAttestation = Static<typeof ConsentAttestation>;

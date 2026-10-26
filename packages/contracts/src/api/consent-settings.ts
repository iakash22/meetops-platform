import { Type, type Static } from '@sinclair/typebox';
import { IsoDateTime } from '../common.js';
import {
  CONSENT_SETTINGS_MODES,
  MAX_CONSENT_NOTICE_TEXT_LENGTH,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from '../constants.js';
import { ConsentVersion } from './consent.js';

/**
 * v0.5.0 PROPOSAL (Architecture review): organization consent / retention settings.
 *   GET   /orgs/:organizationId/settings/consent                          -> ConsentSettings (all roles)
 *   PATCH /orgs/:organizationId/settings/consent  UpdateConsentSettingsRequest -> ConsentSettings (owner/admin only; 403 otherwise)
 * See CONSENT_UPLOAD_PATHS.consentSettings and CONSENT_SETTINGS_WRITE_ROLES.
 */
export {
  CONSENT_SETTINGS_MODES,
  CONSENT_SETTINGS_WRITE_ROLES,
  CONSENT_UPLOAD_PATHS,
  MAX_CONSENT_NOTICE_TEXT_LENGTH,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from '../constants.js';

export const ConsentSettingsMode = Type.Union(CONSENT_SETTINGS_MODES.map((m) => Type.Literal(m)));
export type ConsentSettingsMode = (typeof CONSENT_SETTINGS_MODES)[number];

const noticeText = Type.String({ minLength: 1, maxLength: MAX_CONSENT_NOTICE_TEXT_LENGTH });
const retentionDays = Type.Integer({ minimum: MIN_RETENTION_DAYS, maximum: MAX_RETENTION_DAYS });

/** Response of GET and PATCH. `currentConsentVersion` and `updatedAt` are server-owned (read-only). */
export const ConsentSettings = Type.Object(
  {
    mode: ConsentSettingsMode,
    noticeText,
    skipExternalParticipants: Type.Boolean(),
    retentionDays,
    currentConsentVersion: ConsentVersion,
    updatedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type ConsentSettings = Static<typeof ConsentSettings>;

/**
 * PATCH body: partial update of the writable fields; at least one field. Strict: `currentConsentVersion` and
 * `updatedAt` cannot be set by a client (422 VALIDATION_FAILED).
 */
export const UpdateConsentSettingsRequest = Type.Object(
  {
    mode: Type.Optional(ConsentSettingsMode),
    noticeText: Type.Optional(noticeText),
    skipExternalParticipants: Type.Optional(Type.Boolean()),
    retentionDays: Type.Optional(retentionDays),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateConsentSettingsRequest = Static<typeof UpdateConsentSettingsRequest>;

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
 * v0.5.0: organization consent / retention settings.
 *   GET   /orgs/:organizationId/settings/consent                          -> ConsentSettings (all roles)
 *   PATCH /orgs/:organizationId/settings/consent  UpdateConsentSettingsRequest -> ConsentSettings (owner/admin only; 403 otherwise)
 * See CONSENT_UPLOAD_PATHS.consentSettings and CONSENT_SETTINGS_WRITE_ROLES.
 * ADR-019/020: modes are all_parties_notified | all_parties_consented (no one_party); retention 7–365
 * (default 90); default mode is all_parties_consented for every org. Changing noticeText bumps
 * currentConsentVersion via nextConsentVersion (server-owned).
 */
export {
  CONSENT_SETTINGS_MODES,
  CONSENT_SETTINGS_WRITE_ROLES,
  CONSENT_UPLOAD_PATHS,
  DEFAULT_CONSENT_NOTICE_TEXT,
  DEFAULT_CONSENT_SETTINGS_MODE,
  DEFAULT_RETENTION_DAYS,
  MAX_CONSENT_NOTICE_TEXT_LENGTH,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  nextConsentVersion,
} from '../constants.js';

export const ConsentSettingsMode = Type.Union(CONSENT_SETTINGS_MODES.map((m) => Type.Literal(m)));
export type ConsentSettingsMode = (typeof CONSENT_SETTINGS_MODES)[number];

/**
 * Characters a notice may not start or end with, and may not consist of only: ECMAScript `\s` (whitespace incl. VT,
 * NBSP, U+1680, U+2000-U+200A, U+2028/2029, U+202F, U+205F, U+3000, U+FEFF) plus ZWSP U+200B and NEL U+0085. The DB
 * CHECK organization_consent_settings_notice_text_not_blank_check rejects a notice made only of the same set.
 */
const CONSENT_NOTICE_BLANK_CHARS = '\\s\\u200b\\u0085';
/** Notice body. Clients MUST trim before sending; blank (only CONSENT_NOTICE_BLANK_CHARS) or untrimmed is invalid. */
const noticeText = Type.String({
  minLength: 1,
  maxLength: MAX_CONSENT_NOTICE_TEXT_LENGTH,
  pattern: `^[^${CONSENT_NOTICE_BLANK_CHARS}](?:[\\s\\S]*[^${CONSENT_NOTICE_BLANK_CHARS}])?$`,
});
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
 * `updatedAt` cannot be set by a client: a schema failure is 400
 * `VALIDATION_FAILED` (like every other route; only CONSENT_ERROR_REASONS use CONSENT_HTTP_STATUS 422).
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

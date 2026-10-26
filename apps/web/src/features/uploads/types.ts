import type { Id, PublicFileObject } from '@meetops/contracts';
import type { FILE_OBJECT_SCAN_STATUSES } from '@meetops/contracts/types';

/*
 * TODO(contracts): local mirrors of the v0.5.0 proposal in contracts PR #168
 * (feat/contracts-consent-settings-uploads @ 8dd9b0c). Replace with the
 * `@meetops/contracts` exports (ConsentSettings, UpdateConsentSettingsRequest,
 * CompleteUploadResponse, DownloadUrlResponse, CONSENT_SETTINGS_MODES,
 * CONSENT_SETTINGS_WRITE_ROLES, MIN/MAX_RETENTION_DAYS,
 * MAX_CONSENT_NOTICE_TEXT_LENGTH, CONSENT_UPLOAD_PATHS) once #168 merges.
 */

export type FileObjectScanStatus = (typeof FILE_OBJECT_SCAN_STATUSES)[number];

/** TODO(contracts): CONSENT_SETTINGS_MODES. */
export const CONSENT_SETTINGS_MODES = ['all_party', 'one_party'] as const;
export type ConsentSettingsMode = (typeof CONSENT_SETTINGS_MODES)[number];
/** TODO(contracts): CONSENT_SETTINGS_WRITE_ROLES. */
export const CONSENT_SETTINGS_WRITE_ROLES = ['owner', 'admin'] as const;
/** TODO(contracts): MAX_CONSENT_NOTICE_TEXT_LENGTH. */
export const MAX_CONSENT_NOTICE_TEXT_LENGTH = 4000;
/** TODO(contracts): MIN_RETENTION_DAYS / MAX_RETENTION_DAYS. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

/** TODO(contracts): ConsentSettings. */
export type ConsentSettings = {
  mode: ConsentSettingsMode;
  noticeText: string;
  skipExternalParticipants: boolean;
  retentionDays: number;
  currentConsentVersion: string;
  updatedAt: string;
};
/** TODO(contracts): UpdateConsentSettingsRequest (at least one field). */
export type UpdateConsentSettingsRequest = Partial<
  Pick<ConsentSettings, 'mode' | 'noticeText' | 'skipExternalParticipants' | 'retentionDays'>
>;

/** TODO(contracts): CompleteUploadResponse. */
export type CompleteUploadResponse = {
  fileObject: PublicFileObject;
  scanStatus: FileObjectScanStatus;
};

/** TODO(contracts): DownloadUrlResponse (expiresIn <= MAX_PRESIGNED_GET_TTL_SECONDS = 300). */
export type DownloadUrlResponse = {
  url: string;
  method: 'GET';
  expiresIn: number;
  expiresAt: string;
};

/** TODO(contracts): CONSENT_UPLOAD_PATHS, resolved. */
export const uploadPaths = {
  consentSettings: (org: string) => `${org}/settings/consent`,
  uploads: (org: string) => `${org}/uploads`,
  complete: (org: string, id: Id) => `${org}/uploads/${encodeURIComponent(id)}/complete`,
  downloadUrl: (org: string, id: Id) => `${org}/uploads/${encodeURIComponent(id)}/download-url`,
};

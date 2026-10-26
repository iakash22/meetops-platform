import type { Id } from '@meetops/contracts';
import { CONSENT_UPLOAD_PATHS } from '@meetops/contracts/types';

/*
 * Consent settings and upload lifecycle types come from `@meetops/contracts` (0.5.0+, merged in #168).
 * This module re-exports them so feature code keeps one import site.
 */
export type {
  CompleteUploadResponse,
  ConsentSettings,
  ConsentSettingsMode,
  DownloadUrlResponse,
  FileObjectScanStatus,
  UpdateConsentSettingsRequest,
} from '@meetops/contracts';
export {
  CONSENT_SETTINGS_MODES,
  CONSENT_SETTINGS_WRITE_ROLES,
  MAX_CONSENT_NOTICE_TEXT_LENGTH,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
} from '@meetops/contracts/types';

/** Fill an org-scoped contracts route template. Every segment value is URI-encoded. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (whole, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`Missing path param ${key}`);
    return encodeURIComponent(v);
  });
}

/** CONSENT_UPLOAD_PATHS (contracts), resolved for one organization. */
export const uploadPaths = {
  consentSettings: (organizationId: Id) =>
    fillPath(CONSENT_UPLOAD_PATHS.consentSettings, { organizationId }),
  uploads: (organizationId: Id) => fillPath(CONSENT_UPLOAD_PATHS.uploads, { organizationId }),
  complete: (organizationId: Id, fileObjectId: Id) =>
    fillPath(CONSENT_UPLOAD_PATHS.uploadComplete, { organizationId, fileObjectId }),
  downloadUrl: (organizationId: Id, fileObjectId: Id) =>
    fillPath(CONSENT_UPLOAD_PATHS.uploadDownloadUrl, { organizationId, fileObjectId }),
};

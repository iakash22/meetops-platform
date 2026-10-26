import { Type, type Static } from '@sinclair/typebox';
import {
  FileObjectScanStatus,
  Id,
  InitUploadRequest,
  IsoDateTime,
  MAX_PRESIGNED_GET_TTL_SECONDS,
  PresignedUrlString,
  PublicFileObject,
} from '@meetops/contracts';

/**
 * LOCAL TYPES: exact mirrors of PR #168 (feat/contracts-consent-settings-uploads @ 8dd9b0c, contracts v0.5.0 proposal).
 * TODO(#168): replace with @meetops/contracts imports once #168 merges, then delete these copies.
 */
/** TODO(#168): mirrors `CONSENT_UPLOAD_PATHS` in PR #168 exactly; import from @meetops/contracts once it merges. */
export const CONSENT_UPLOAD_PATHS = {
  consentSettings: '/orgs/:organizationId/settings/consent',
  uploads: '/orgs/:organizationId/uploads',
  uploadComplete: '/orgs/:organizationId/uploads/:fileObjectId/complete',
  uploadDownloadUrl: '/orgs/:organizationId/uploads/:fileObjectId/download-url',
} as const;

export const OrgParams = Type.Object({ organizationId: Id }, { additionalProperties: false });
export type OrgParams = Static<typeof OrgParams>;
export const UploadParams = Type.Object(
  { organizationId: Id, fileObjectId: Id },
  { additionalProperties: false },
);
export type UploadParams = Static<typeof UploadParams>;

/**
 * Route body: InitUploadRequest with `consent` loosened to unknown so a missing/invalid consent reaches the handler and
 * gets the contract's 422 CONSENT_* instead of the generic 400 schema error. The handler then checks
 * ConsentAttestationInput itself.
 */
export const InitUploadRouteBody = Type.Object(
  {
    ...Type.Omit(InitUploadRequest, ['consent']).properties,
    consent: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** TODO(#168): mirrors `CompleteUploadRequest` in PR #168 exactly; import from @meetops/contracts once it merges. */
export const CompleteUploadRequest = Type.Object({}, { additionalProperties: false });
export type CompleteUploadRequest = Static<typeof CompleteUploadRequest>;

/** TODO(#168): mirrors `CompleteUploadResponse` in PR #168 exactly (200). Replace with the contracts import. */
export const CompleteUploadResponse = Type.Object(
  { fileObject: PublicFileObject, scanStatus: FileObjectScanStatus },
  { additionalProperties: false },
);
export type CompleteUploadResponse = Static<typeof CompleteUploadResponse>;

/** TODO(#168): mirrors `DownloadUrlResponse` in PR #168 exactly. Replace with the contracts import. */
export const DownloadUrlResponse = Type.Object(
  {
    url: PresignedUrlString,
    method: Type.Literal('GET'),
    expiresIn: Type.Integer({ minimum: 1, maximum: MAX_PRESIGNED_GET_TTL_SECONDS }),
    expiresAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type DownloadUrlResponse = Static<typeof DownloadUrlResponse>;

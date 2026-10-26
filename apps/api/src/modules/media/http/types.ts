import { Type, type Static } from '@sinclair/typebox';
import { Id, InitUploadRequest, IsoDateTime, PresignedUrlString } from '@meetops/contracts';

/**
 * LOCAL TYPES (contract gap): @meetops/contracts 0.4.1 defines InitUploadRequest/Response but no upload-complete or
 * download-URL shapes and no UPLOAD_PATHS. These mirror what the routes return; move them into contracts via an
 * Architecture PR and delete this file.
 */
export const UPLOAD_PATHS = {
  init: '/orgs/:organizationId/uploads',
  complete: '/orgs/:organizationId/uploads/:fileObjectId/complete',
  downloadUrl: '/orgs/:organizationId/uploads/:fileObjectId/download-url',
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

/** POST .../uploads/:fileObjectId/complete -> 202. Empty body. */
export const CompleteUploadResponse = Type.Object(
  { fileObjectId: Id, status: Type.Literal('processing') },
  { additionalProperties: false },
);
export type CompleteUploadResponse = Static<typeof CompleteUploadResponse>;

/** GET .../uploads/:fileObjectId/download-url -> 200. `download.expiresAt` is at most 300 s out. */
export const DownloadUrlResponse = Type.Object(
  {
    fileObjectId: Id,
    download: Type.Object(
      { url: PresignedUrlString, method: Type.Literal('GET'), expiresAt: IsoDateTime },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type DownloadUrlResponse = Static<typeof DownloadUrlResponse>;

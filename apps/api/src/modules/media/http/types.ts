import { Type, type Static } from '@sinclair/typebox';
import { Id, InitUploadRequest } from '@meetops/contracts';

export {
  CONSENT_UPLOAD_PATHS,
  CompleteUploadRequest,
  CompleteUploadResponse,
  DownloadUrlResponse,
} from '@meetops/contracts';

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

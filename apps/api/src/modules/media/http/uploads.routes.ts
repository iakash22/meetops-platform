import type { FastifyInstance } from 'fastify';
import { InitUploadResponse } from '@meetops/contracts';
import type { FileObjectRecord } from '../domain/ports.js';
import { ErrorBody } from '../../auth/http/schemas.js';
import { directoryErrors, iso, type ResolveCaller } from '../../directory/http/route-kit.js';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  type InitUploadInput,
  type UploadService,
} from '../application/upload.service.js';
import {
  CONSENT_UPLOAD_PATHS,
  CompleteUploadRequest,
  CompleteUploadResponse,
  DownloadUrlResponse,
  InitUploadRouteBody,
  OrgParams,
  UploadParams,
} from './types.js';
import type { MediaRateLimit } from './rate-limit.js';

const tags = ['uploads'];
const errors = { ...directoryErrors, 409: ErrorBody, 422: ErrorBody, 503: ErrorBody } as const;

export async function uploadRoutes(
  app: FastifyInstance,
  opts: {
    uploads: UploadService;
    caller: ResolveCaller;
    /** Caller for init/complete (cookie or ADR-005 extension bearer); defaults to `caller`. */
    writeCaller?: ResolveCaller;
    /** Per user + IP limits on init/complete (429 + Retry-After). */
    rateLimit?: MediaRateLimit;
  },
) {
  const { uploads, caller, rateLimit } = opts;
  const writeCaller = opts.writeCaller ?? caller;

  app.post<{ Params: OrgParams; Body: InitUploadInput }>(
    CONSENT_UPLOAD_PATHS.uploads,
    {
      schema: {
        tags,
        summary: 'Start a direct upload',
        description:
          'InitUploadRequest. `consent` is required: missing/invalid -> 422 VALIDATION_FAILED + reason CONSENT_*; nothing is created. 1.4 GB cap. Returns a presigned PUT.',
        params: OrgParams,
        body: InitUploadRouteBody,
        response: { 201: InitUploadResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await writeCaller(request, request.params.organizationId);
      await rateLimit?.control(c);
      const { file, upload } = await uploads.init(c, request.body);
      return reply.code(201).send({
        fileObjectId: file.id,
        upload: {
          url: upload.url,
          method: 'PUT',
          headers: upload.headers,
          expiresAt: iso(upload.expiresAt),
        },
      });
    },
  );

  app.post<{ Params: UploadParams }>(
    CONSENT_UPLOAD_PATHS.uploadComplete,
    {
      schema: {
        tags,
        summary: 'Finish a direct upload and queue processing',
        description:
          'Queues processing only if a stored consent attestation exists; else 422 CONSENT_* and no job. 409 when not uploaded or already completed.',
        params: UploadParams,
        body: CompleteUploadRequest,
        response: { 200: CompleteUploadResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await writeCaller(request, request.params.organizationId);
      await rateLimit?.control(c);
      const f = await uploads.complete(c, request.params.fileObjectId);
      return reply.code(200).send({ fileObject: toPublicFileObject(f), scanStatus: 'pending' });
    },
  );

  app.get<{ Params: UploadParams }>(
    CONSENT_UPLOAD_PATHS.uploadDownloadUrl,
    {
      schema: {
        tags,
        summary: 'Short-lived download URL',
        description:
          'Presigned GET; expiresIn <= 300 s. 404 for other-org ids or a FileObject whose scanStatus is not `clean`.',
        params: UploadParams,
        response: { 200: DownloadUrlResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const d = await uploads.downloadUrl(c, request.params.fileObjectId);
      void reply.header('cache-control', 'no-store');
      return {
        url: d.url,
        method: 'GET',
        expiresIn: DOWNLOAD_URL_TTL_SECONDS,
        expiresAt: iso(d.expiresAt),
      };
    },
  );
}

const toPublicFileObject = (f: FileObjectRecord) => ({
  id: f.id,
  organizationId: f.organizationId,
  mimeType: f.mimeType,
  sizeBytes: f.sizeBytes,
  createdAt: iso(f.createdAt),
});

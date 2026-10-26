import type { FastifyInstance } from 'fastify';
import { InitUploadResponse } from '@meetops/contracts';
import { ErrorBody } from '../../auth/http/schemas.js';
import { directoryErrors, iso, type ResolveCaller } from '../../directory/http/route-kit.js';
import type { InitUploadInput, UploadService } from '../application/upload.service.js';
import {
  CompleteUploadResponse,
  DownloadUrlResponse,
  InitUploadRouteBody,
  OrgParams,
  UPLOAD_PATHS,
  UploadParams,
} from './types.js';

const tags = ['uploads'];
const errors = { ...directoryErrors, 409: ErrorBody, 422: ErrorBody } as const;

export async function uploadRoutes(
  app: FastifyInstance,
  opts: { uploads: UploadService; caller: ResolveCaller },
) {
  const { uploads, caller } = opts;

  app.post<{ Params: OrgParams; Body: InitUploadInput }>(
    UPLOAD_PATHS.init,
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
      const c = await caller(request, request.params.organizationId);
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
    UPLOAD_PATHS.complete,
    {
      schema: {
        tags,
        summary: 'Finish a direct upload and queue processing',
        description:
          'Queues processing only if a stored consent attestation exists; else 422 CONSENT_* and no job. 409 when not uploaded or already completed.',
        params: UploadParams,
        response: { 202: CompleteUploadResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const f = await uploads.complete(c, request.params.fileObjectId);
      return reply.code(202).send({ fileObjectId: f.id, status: 'processing' });
    },
  );

  app.get<{ Params: UploadParams }>(
    UPLOAD_PATHS.downloadUrl,
    {
      schema: {
        tags,
        summary: 'Short-lived download URL',
        description: 'Presigned GET, expires in at most 300 s.',
        params: UploadParams,
        response: { 200: DownloadUrlResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const d = await uploads.downloadUrl(c, request.params.fileObjectId);
      void reply.header('cache-control', 'no-store');
      return {
        fileObjectId: request.params.fileObjectId,
        download: { url: d.url, method: 'GET', expiresAt: iso(d.expiresAt) },
      };
    },
  );
}

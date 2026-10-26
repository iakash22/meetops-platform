import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AbortRecordingSessionRequest,
  ChunkUploadUrlRequest,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionRequest,
  CompleteRecordingSessionResponse,
  InitRecordingSessionResponse,
} from '@meetops/contracts';
import { ErrorBody } from '../../auth/http/schemas.js';
import type { DirectoryCaller } from '../../directory/access.js';
import { directoryErrors, iso, type ResolveCaller } from '../../directory/http/route-kit.js';
import type {
  InitRecordingSessionInput,
  RecordingSessionService,
} from '../application/recording-session.service.js';
import { OrgParams } from './types.js';
import {
  InitRecordingSessionRouteBody,
  RECORDING_SESSION_PATHS,
  SessionParams,
} from './recording-session.types.js';

const tags = ['recording-sessions'];
const errors = { ...directoryErrors, 409: ErrorBody, 422: ErrorBody } as const;

export async function recordingSessionRoutes(
  app: FastifyInstance,
  opts: {
    sessions: RecordingSessionService;
    caller: ResolveCaller;
    activeCaller: (request: FastifyRequest) => Promise<DirectoryCaller>;
  },
) {
  const { sessions, caller, activeCaller } = opts;

  app.post<{ Params: OrgParams; Body: InitRecordingSessionInput }>(
    RECORDING_SESSION_PATHS.init,
    {
      schema: {
        tags,
        summary: 'Start a chunked tab recording',
        description:
          'InitRecordingSessionRequest. Missing/invalid consent -> 422 VALIDATION_FAILED + CONSENT_*; nothing is created.',
        params: OrgParams,
        body: InitRecordingSessionRouteBody,
        response: { 201: InitRecordingSessionResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const s = await sessions.init(c, request.body);
      return reply.code(201).send({ sessionId: s.id });
    },
  );

  app.post<{ Params: SessionParams; Body: ChunkUploadUrlRequest }>(
    RECORDING_SESSION_PATHS.chunks,
    {
      schema: {
        tags,
        summary: 'Presign one chunk PUT',
        description:
          'Running total across all signed chunks is capped at MAX_RECORDING_SESSION_BYTES (1.4 GB): over -> 409. Re-signing a seq replaces it. URL lives CHUNK_UPLOAD_URL_TTL_SECONDS.',
        params: SessionParams,
        body: ChunkUploadUrlRequest,
        response: { 200: ChunkUploadUrlResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await activeCaller(request);
      const u = await sessions.chunkUrl(c, request.params.sessionId, request.body);
      return reply.header('cache-control', 'no-store').send({
        seq: request.body.seq,
        upload: { url: u.url, method: 'PUT', headers: u.headers, expiresAt: iso(u.expiresAt) },
      });
    },
  );

  app.post<{ Params: SessionParams; Body: CompleteRecordingSessionRequest }>(
    RECORDING_SESSION_PATHS.complete,
    {
      schema: {
        tags,
        summary: 'Finish a recording and queue processing',
        description:
          'durationMs <= MAX_DURATION_MS (4 h). Needs chunks 0..chunkCount-1 signed and stored. Without a valid stored consent -> 422 CONSENT_* and no job.',
        params: SessionParams,
        body: CompleteRecordingSessionRequest,
        response: { 202: CompleteRecordingSessionResponse, ...errors },
      },
    },
    async (request, reply) => {
      const c = await activeCaller(request);
      await sessions.complete(c, request.params.sessionId, request.body);
      return reply.code(202).send({ status: 'processing' });
    },
  );

  app.post<{ Params: SessionParams; Body: AbortRecordingSessionRequest }>(
    RECORDING_SESSION_PATHS.abort,
    {
      schema: {
        tags,
        summary: 'Abort a recording',
        params: SessionParams,
        body: AbortRecordingSessionRequest,
        response: { 204: { type: 'null' }, ...errors },
      },
    },
    async (request, reply) => {
      const c = await activeCaller(request);
      await sessions.abort(c, request.params.sessionId, request.body.reason);
      return reply.code(204).send();
    },
  );
}

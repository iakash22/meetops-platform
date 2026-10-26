import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { DirectoryAccess } from '../directory/access.js';
import type { ResolveCaller } from '../directory/http/route-kit.js';
import type { ModuleDeps } from '../index.js';
import { UploadService } from './application/upload.service.js';
import { uploadRoutes } from './http/uploads.routes.js';
import { RecordingSessionService } from './application/recording-session.service.js';
import { recordingSessionRoutes } from './http/recording-sessions.routes.js';
import { RecordingSessionNotFoundError } from './domain/recording-session.js';

export interface MediaPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
  deps: ModuleDeps;
}

/**
 * Media module: direct uploads (and, on feat/api-recording-sessions, chunked recording sessions). Registered only
 * when `deps.media` is set: dev/test get in-memory adapters; production has no storage/queue/consent adapters wired
 * yet, so the routes are absent there rather than half-working.
 */
export default async function mediaModule(app: FastifyInstance, opts: MediaPluginOptions) {
  const { auth, organizations, deps } = opts;
  const media = deps.media;
  if (!media) return;
  registerDomainErrorHandler(app);
  const g = makeGuards(auth, deps.security);
  app.addHook('onRequest', g.mutationGuard);
  const access = new DirectoryAccess(organizations, deps.audit);
  const caller: ResolveCaller = async (request, organizationId) =>
    access.caller(await g.requireSession(request), organizationId, requestMeta(request));
  const mediaDeps = { ...media, meetings: deps.meetings, now: () => deps.clock.now() };
  await app.register(uploadRoutes, { uploads: new UploadService(mediaDeps), caller });
  // Session routes have no org in the path: resolve it from the session's active organization.
  const activeCaller = async (request: FastifyRequest) => {
    const ctx = await g.requireSession(request);
    const org = ctx.session.activeOrganizationId;
    if (!org) throw new RecordingSessionNotFoundError();
    return access.caller(ctx, org, requestMeta(request));
  };
  await app.register(recordingSessionRoutes, {
    sessions: new RecordingSessionService(mediaDeps),
    caller,
    activeCaller,
  });
}

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
import { mediaRateLimit } from './http/rate-limit.js';
import { MeetingConsentService } from './application/meeting-consent.service.js';
import { meetingConsentRoutes } from './http/meeting-consent.routes.js';
import { RecordingSessionNotFoundError } from './domain/recording-session.js';
import type { SessionVerifier } from '../auth/application/session-verifier.js';
import { UnauthenticatedError } from '../auth/domain/errors.js';
import {
  bearerAwareMutationGuard,
  dualActiveCaller,
  dualCaller,
  type ExtensionBearerGuard,
} from '../extension-auth/http/dual-caller.js';

export interface MediaPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
  deps: ModuleDeps;
  /** ADR-005 bearer guard; when set, recording-session and upload init/complete accept `recordings:write` tokens. */
  extensionBearer?: ExtensionBearerGuard;
  /** Needed with extensionBearer to read a bearer's org on session-scoped routes (no org in the path). */
  sessionVerifier?: SessionVerifier;
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
  const access = new DirectoryAccess(organizations, deps.audit);
  const caller: ResolveCaller = async (request, organizationId) =>
    access.caller(await g.requireSession(request), organizationId, requestMeta(request));
  const mediaDeps = {
    ...media,
    meetings: deps.meetings,
    now: () => deps.clock.now(),
    consentEnforcement: deps.consentEnforcementEnabled === true,
  };
  const { extensionBearer, sessionVerifier } = opts;
  const bearer = extensionBearer && sessionVerifier ? extensionBearer : undefined;
  app.addHook(
    'onRequest',
    bearerAwareMutationGuard(g.mutationGuard, {
      cookieName: deps.security.cookieName,
      bearerEnabled: bearer !== undefined,
    }),
  );
  const rateLimit = mediaRateLimit(deps.rateLimiter, deps.mediaRateLimits);
  const writeCaller = dualCaller(caller, bearer, organizations, 'recordings:write');
  if (media.meetingConsents) {
    await app.register(meetingConsentRoutes, {
      consents: new MeetingConsentService({
        meetingConsents: media.meetingConsents,
        meetings: deps.meetings,
        now: mediaDeps.now,
      }),
      caller,
      writeCaller,
    });
  }
  await app.register(uploadRoutes, {
    uploads: new UploadService(mediaDeps),
    caller,
    writeCaller,
    rateLimit,
  });
  // Session routes have no org in the path: resolve it from the session's active organization.
  const activeCaller = async (request: FastifyRequest) => {
    const ctx = await g.requireSession(request);
    const org = ctx.session.activeOrganizationId;
    if (!org) throw new RecordingSessionNotFoundError();
    return access.caller(ctx, org, requestMeta(request));
  };
  // A bearer's org is the token's org; the guard then re-checks cookie absence and scope.
  const bearerOrg = async (request: FastifyRequest) => {
    const token = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(request.headers.authorization ?? '')?.[1];
    const v = token ? await sessionVerifier?.verifyBearer(token) : null;
    if (!v) throw new UnauthenticatedError();
    return v.organizationId;
  };
  await app.register(recordingSessionRoutes, {
    sessions: new RecordingSessionService(mediaDeps),
    caller: writeCaller,
    activeCaller: dualActiveCaller(activeCaller, bearer, bearerOrg, writeCaller),
    rateLimit,
  });
}

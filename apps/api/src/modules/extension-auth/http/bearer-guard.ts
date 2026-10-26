import type { FastifyRequest } from 'fastify';
import type { ExtensionScope } from '@meetops/contracts';
import { DomainError } from '../../../shared/domain-error.js';
import { UnauthenticatedError } from '../../auth/domain/errors.js';
import type { SessionVerifier, VerifiedSession } from '../../auth/application/session-verifier.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]{32,512})$/;

/**
 * ADR-005 A1.3.1 guard for bearer-only extension routes (meetings/resolve, recording sessions and chunks).
 * Order: a session cookie -> 401; missing/invalid bearer -> 401; path org != token org -> 404 (ADR-004);
 * missing scope -> 403. Tokens are read only from the Authorization header, never the query string.
 */
export function makeExtensionBearerGuard(verifier: SessionVerifier, cookieName: string) {
  return async (
    request: FastifyRequest,
    scope: ExtensionScope,
    organizationId: string,
  ): Promise<VerifiedSession> => {
    if (request.cookies[cookieName]) throw new UnauthenticatedError();
    const m = BEARER.exec(request.headers.authorization ?? '');
    if (!m) throw new UnauthenticatedError();
    const v = await verifier.verifyBearer(m[1]);
    if (!v || v.credential !== 'extension') throw new UnauthenticatedError();
    if (v.organizationId !== organizationId) throw new DomainError('NOT_FOUND', 'Not found', 404);
    if (!v.scopes?.includes(scope)) throw new DomainError('FORBIDDEN', 'Missing scope', 403);
    return v;
  };
}

import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { CursorPage } from './pagination.js';

const strict = { additionalProperties: false } as const;

/**
 * One of the caller's active sessions (devices), for `GET /auth/sessions`. `current` marks the session making the request.
 * **Never carries token material**: no session token, token hash, CSRF token or refresh token. The schema is strict, so
 * a serializer that adds such a field fails validation.
 */
export const SessionSummary = Type.Object(
  {
    id: Id,
    current: Type.Boolean(),
    createdAt: IsoDateTime,
    lastSeenAt: IsoDateTime,
    expiresAt: IsoDateTime,
    ip: Type.Union([Type.String({ maxLength: 45 }), Type.Null()]),
    userAgent: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
  },
  strict,
);
export type SessionSummary = Static<typeof SessionSummary>;

/** GET /auth/sessions: cursor page of SessionSummary (`nextCursor` is null on the last page). */
export const ListSessionsResponse = Type.Object(CursorPage(SessionSummary).properties, strict);
export type ListSessionsResponse = Static<typeof ListSessionsResponse>;

/** DELETE /auth/sessions/:sessionId path params. */
export const SessionIdParams = Type.Object({ sessionId: Id }, strict);
export type SessionIdParams = Static<typeof SessionIdParams>;

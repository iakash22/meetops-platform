/**
 * Plain runtime constants with **no TypeBox import**. Re-exported by the main barrel and by the light
 * `@meetops/contracts/types` entry. Keep this file free of runtime imports (a test guards it).
 */

/** All task statuses, in display order. */
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
/** Membership roles. */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
/** STT router ids (`SttProviderId`). */
export const STT_PROVIDER_IDS = ['assemblyai', 'faster-whisper', 'deepgram'] as const;
/** `TranscriptProviderId`: STT ids plus `'unknown'` (legacy backfilled transcripts only). */
export const TRANSCRIPT_PROVIDER_IDS = [...STT_PROVIDER_IDS, 'unknown'] as const;
/** All `ApiErrorCode` values (kept equal to the schema by a type test). */
export const API_ERROR_CODES = [
  'BAD_REQUEST', 'VALIDATION_FAILED', 'UNAUTHENTICATED', 'AUTH_FAILED', 'CSRF_INVALID', 'FORBIDDEN', 'NOT_FOUND',
  'CONFLICT', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'INTERNAL',
] as const;

/** ADR-005: extension tokens. TTL of the access token in seconds (15 min). */
export const EXTENSION_TOKEN_TTL_SECONDS = 900;
/** ADR-005 amendment 1: absolute maximum lifetime of a refresh family (30 days), counted from pairing. Not extended by rotation. */
export const EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const EXTENSION_TOKEN_AUDIENCE = 'extension' as const;
export const EXTENSION_TOKEN_TYPE = 'Bearer' as const;
export const EXTENSION_SCOPES = ['meetings:resolve', 'recordings:write'] as const;

/** Endpoint paths for the extension pairing and token lifecycle (ADR-005 amendment 1). All are POST. */
export const EXTENSION_AUTH_PATHS = {
  /** Web session (`__Host-` cookie + `x-csrf-token`) only. Issues a single-use pairing code bound to the nonce. */
  pair: '/auth/extension/pair',
  /** No cookie. Exchanges the pairing code + nonce for the first token pair. */
  token: '/auth/extension-token',
  /** No cookie. Rotates the refresh token. */
  refresh: '/auth/extension/refresh',
  /** Bearer (aud=extension) or refresh token. Revokes the device's refresh family. */
  revoke: '/auth/extension/revoke',
} as const;

/**
 * Keys whose values must be redacted (replaced, never truncated) by every logger, error reporter and request/response
 * serializer (ADR-005 amendment 1). Matching is case-insensitive on the key name, at any depth.
 */
export const REDACT_KEYS = [
  'accessToken', 'refreshToken', 'pairingCode', 'authorization', 'cookie', 'set-cookie', 'password', 'csrfToken',
] as const;

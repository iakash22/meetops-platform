import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

/** ADR-005: extension tokens. TTL of the access token in seconds (15 min). */
export const EXTENSION_TOKEN_TTL_SECONDS = 900;
export const EXTENSION_TOKEN_AUDIENCE = 'extension' as const;
export const EXTENSION_SCOPES = ['meetings:resolve', 'recordings:write'] as const;
export const ExtensionScope = Type.Union(EXTENSION_SCOPES.map((s) => Type.Literal(s)));
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

/** Chrome extension id: 32 characters in a-p. The server checks it against an allowlist. */
const ExtensionId = Type.String({ pattern: '^[a-p]{32}$' });

/**
 * POST /auth/extension-token: handoff from a logged-in web session. Requires the `__Host-` session cookie and a valid
 * `x-csrf-token`, and `extensionId` must be allowlisted. The token is scoped to the session's active organization.
 */
export const ExtensionTokenRequest = Type.Object(
  { extensionId: ExtensionId, deviceLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) },
  { additionalProperties: false },
);
export type ExtensionTokenRequest = Static<typeof ExtensionTokenRequest>;

/**
 * **The only response body in the API that carries tokens** (ADR-005).
 * - `accessToken` is a bearer token: audience `extension`, scopes ⊆ EXTENSION_SCOPES, TTL 15 min, org-scoped.
 * - `refreshToken` rotates on each use, is bound to the extension id and device, and can be revoked per device.
 * The extension stores both in `chrome.storage.session` only, never in localStorage. Never log them.
 */
export const ExtensionTokenResponse = Type.Object({
  accessToken: Type.String({ minLength: 32, maxLength: 4096 }),
  expiresAt: IsoDateTime,
  refreshToken: Type.String({ minLength: 32, maxLength: 512 }),
  scopes: Type.Array(ExtensionScope, { minItems: 1, uniqueItems: true }),
  organizationId: Id,
});
export type ExtensionTokenResponse = Static<typeof ExtensionTokenResponse>;

# ADR-005: Browser extension authentication

- Status: Accepted
- Date: 2026-10-22
- Owner: Architecture Agent (ARCH), with the Security (SEC), Backend (BE) and Native (NATIVE) Agents
- Related: [ADR-003 Contracts ownership](./ADR-003-contracts-ownership.md), [ADR-004](./ADR-004-db-contract-mapping.md)

## Context

The web app authenticates with a `__Host-` prefixed, HttpOnly, Secure, SameSite session cookie plus a CSRF token
(`AuthSession.csrfToken`). The Chrome extension (`apps/extension`) runs on a `chrome-extension://` origin and calls
the API cross-site. SameSite cookies are not reliably sent to it, CSRF double-submit semantics don't apply, and
widening CORS or SameSite for cookies would weaken the web app. The extension needs only a narrow set of
capabilities: resolving the meeting it is recording, and uploading recording chunks.

## Decision

1. **The extension uses a short-lived, scoped bearer token, not the session cookie.** API routes used by the
   extension accept `Authorization: Bearer <token>` with audience `extension`. Cookie auth is never accepted on
   those routes from an extension origin.
2. **Issuance by handoff.** A logged-in web session calls `POST /auth/extension-token` with the `__Host-` cookie
   and a valid `x-csrf-token`. The body is `ExtensionTokenRequest { extensionId, deviceLabel? }`. `extensionId` must be in
   a server-side allowlist (the published extension id, plus a dev id in non-production). The extension
   receives the response through `chrome.runtime` external messaging from the web origin, which must be listed in
   the manifest's `externally_connectable`.
3. **Token properties.**
   - The audience is `extension`. Scopes are a subset of `meetings:resolve` and `recordings:write` (`EXTENSION_SCOPES`). There are no
     read scopes for tasks, reports or transcripts.
   - Each token is org-scoped to the session's active organization (`organizationId` in the response), so
     switching orgs requires a new handoff.
   - The access token TTL is **15 minutes** (`EXTENSION_TOKEN_TTL_SECONDS`).
   - A **rotating refresh token** is bound to `(extensionId, device, userId, organizationId)`. Each refresh issues a new pair
     and invalidates the old one. Reusing an old refresh token revokes the whole device family.
4. **Storage.** The extension keeps both tokens in `chrome.storage.session`, which is in memory and cleared when the
   browser closes. It **never** uses `localStorage`, `chrome.storage.local` or `chrome.storage.sync`, and never writes them to logs or errors.
5. **Revocation.** Tokens can be revoked per device (listed in account settings by `deviceLabel`), per org,
   and on logout or a password change. The server stores only hashes of refresh tokens.
6. **Contracts.** `ExtensionTokenResponse { accessToken, expiresAt, refreshToken, scopes, organizationId }` is the
   **only** API response body that carries tokens. Every other auth response (`AuthSession`, `GetAuthSessionResponse`,
   `CsrfResponse`) is token-free, and a contracts test guards this. Changes follow ADR-003.

## Consequences

- The extension can't use the web session directly, and a user must be logged into the web app to pair it.
- Leaked extension tokens have a small blast radius: two scopes, one org, and 15 minutes.
- BE must implement bearer validation for audience and scope, the refresh-family store and the device list. SEC reviews it.
- NATIVE replaces any cookie or credentials-based fetches in `apps/extension` with the bearer flow.

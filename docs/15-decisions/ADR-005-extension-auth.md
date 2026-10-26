# ADR-005: Browser extension authentication

- Status: Accepted; amended 2026-10-22 (Amendment 1: pairing proof and token hardening, supersedes points 2, 3, 5 and 6 where they conflict)
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

## Amendment 1 (2026-10-22): pairing proof and token hardening

Raised by SEC on PR #50. The key words MUST, MUST NOT and SHOULD are as in RFC 2119. Where this amendment conflicts with
the Decision above, the amendment wins. Schemas and constants: `packages/contracts/src/api/extension-auth.ts`.

### A1.1 Pairing flow

1. Pairing MUST start from a user gesture in the extension (a click in the popup or options page), never automatically.
2. On that gesture the extension MUST generate a single-use nonce (`ExtensionNonce`: 32–128 base64url characters, at least
   256 bits from `crypto.getRandomValues`) and a per-install `deviceId` (UUID). It MUST keep the nonce only in
   `chrome.storage.session`, MUST delete it after one use or after 5 minutes, and then opens the web pairing page.
3. The web pairing page MUST show a confirmation naming the organization (`organizationName`) and the device label
   before calling `POST /auth/extension/pair` (`ExtensionPairRequest`) with the `__Host-` cookie and `x-csrf-token`.
   The server MUST check `extensionId` against the allowlist and return `ExtensionPairResponse`, a single-use
   `pairingCode` bound to `(nonce, extensionId, deviceId, userId, organizationId)` that expires within 60 seconds. It carries no tokens.
4. The page hands `{ type: 'MEETOPS_PAIRING_CODE', pairingCode, nonce }` to the extension with
   `chrome.runtime.sendMessage(extensionId, …)`. The message schema is `PairingCodeMessage` (strict; the type literal is
   `PAIRING_CODE_MESSAGE_TYPE`, both in `@meetops/contracts`). The extension's `chrome.runtime.onMessageExternal` handler
   MUST check `sender.origin` for an exact string match against the production web origin, MUST validate the message
   against `PairingCodeMessage`, and MUST reject a nonce that differs from the stored one. Anything else is dropped silently.
5. `externally_connectable.matches` MUST list only the exact production web origin. Dev origins such as
   `http://localhost:*` MUST appear only in dev builds and MUST NOT ship in a store build.
6. The extension then calls `POST /auth/extension-token` (`ExtensionTokenRequest`, without a cookie). The server MUST
   consume the pairing code atomically and require the same nonce, extension id and device id. The extension MUST
   reject an `ExtensionTokenResponse` whose `nonce` doesn't match the stored nonce, and then delete the nonce.

### A1.2 Token model

1. Access and refresh tokens MUST be opaque random values (≥256 bits, base64url), not JWTs. The server MUST store only
   their SHA-256 hashes and MUST NOT persist or log plaintext. Lookups go by hash.
2. The access token TTL stays at 15 minutes (`EXTENSION_TOKEN_TTL_SECONDS = 900`). `tokenType` is `'Bearer'` and `audience` is `'extension'`.
3. Refresh (`POST /auth/extension/refresh`) MUST rotate: each use consumes the presented refresh token and issues a new
   pair in the same family. Presenting an already-consumed refresh token is reuse, and it MUST revoke the whole family
   and every access token issued from it.
4. A refresh family MUST NOT outlive `EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS` (30 days) from pairing, and rotation does
   not extend it. `refreshExpiresAt` reports that bound, and after it the user must pair again.
5. `ExtensionTokenResponse` and `ExtensionRefreshResponse` are strict, and they are the only API bodies carrying tokens.
6. Tokens are stored only in `chrome.storage.session`. Its access level MUST remain the default `TRUSTED_CONTEXTS`, and the
   extension MUST NOT call `chrome.storage.session.setAccessLevel` to expose it to content scripts.

### A1.3 Bearer versus cookie

#### A1.3.1 Route authentication

1. Bearer-authenticated extension routes (`meetings/resolve`, recording-session and chunk routes) MUST accept only
   `Authorization: Bearer` with `aud=extension`, and MUST reject a request that carries a session cookie
   (401 `UNAUTHENTICATED`). The token lifecycle routes are different:
   - `pair` is a web route and is cookie-only (`__Host-` session cookie + `x-csrf-token`).
   - `extension-token` is authenticated by the pairing code + nonce in the body, bound to `extensionId` and `deviceId`.
   - `refresh` is NOT Bearer-authenticated. It runs when the access token has expired and is authenticated only by the
     `refreshToken` in the body, bound to `extensionId` and `deviceId`.
   - `revoke` is NOT Bearer-authenticated. It is authenticated only by the required `refreshToken` in the body, bound to
     `extensionId` and `deviceId`, so it also works after the access token has expired.
     These three MUST ignore any `Authorization` header and MUST reject a request that carries a session cookie (401 `UNAUTHENTICATED`).
2. Every other route MUST reject bearer tokens, so the cookie path is the only one for web routes.
3. Tokens MUST NOT be accepted in the query string or URL fragment, on any route.
4. The `:organizationId` in the path MUST equal the token's organization, otherwise the response is `NOT_FOUND` (per ADR-004 tenancy).
5. Scopes MUST be enforced per route: `meetings:resolve` for resolve, `recordings:write` for recording sessions and chunks.
6. CORS MUST be enabled only on extension routes, MUST allow only the allowlisted `chrome-extension://<id>` origins, and
   MUST NOT set `Access-Control-Allow-Credentials`.

### A1.4 Rate limits (suggested starting values; DevOps tunes them)

- `pair`: 5/min and 20/hour per user, plus 10/min per IP.
- `extension-token` exchange: 10/min per IP. A failed nonce or code check counts double.
- `refresh`: 10/min per family, plus 60/min per IP. A refresh more often than every 60 s per family SHOULD be logged.
- `revoke`: 10/min per family, plus 60/min per IP (it is authenticated by the refresh token, not a user session).
  Exceeding a limit returns 429 `RATE_LIMITED`.

### A1.5 Redaction

`accessToken` and `refreshToken` (and every key in the exported `REDACT_KEYS`, including `pairingCode`, `authorization` and `cookie`)
MUST be redacted by every logger, error reporter (Sentry `beforeSend`), and request/response serializer, both API-side and
in the extension. `REDACT_KEYS` is new in contracts 0.3.0, and API and worker logger configs MUST import it rather than copy it.

### A1.6 Revocation

The server MUST revoke the affected refresh families, and with them their access tokens, on: logout (the user's families),
password change or reset (all the user's families), removal of the user from an org (families for that org),
an org switch in the extension (the old family; a new pairing is required), and explicit `POST /auth/extension/revoke` per device.

### A1.7 Meeting resolve

`POST /orgs/:organizationId/meetings/resolve` MUST derive the external meeting id by parsing `externalMeetingUrl` against
per-provider host and path rules (Meet, Zoom, Teams). The server MUST NOT fetch, resolve or follow the URL (no SSRF surface).
An unparseable URL returns `VALIDATION_FAILED`.

### A1.8 Owner dependencies

- **Backend (BE):** pair, token, refresh and revoke routes with atomic single-use pairing codes; hashed token store;
  family rotation with reuse detection and a 30-day cap; bearer-only and cookie-only route guards; org match returning
  NOT_FOUND; per-route scopes; extension-only CORS without credentials; the revocation triggers in A1.6; URL-parsing resolve;
  logger redaction from `REDACT_KEYS`.
- **Native (`apps/extension`):** a user-gesture pairing UI; nonce and deviceId generation; `chrome.storage.session` only, left
  at TRUSTED_CONTEXTS; an `onMessageExternal` handler with an exact `sender.origin` check, schema validation and the nonce
  check; nonce echo verification; refresh before expiry; a production-only `externally_connectable` origin; dev
  origins gated to dev builds; redaction. Imports: the background service worker MAY import the main
  `@meetops/contracts` entry for runtime schema validation (for example `PairingCodeMessage` in the `onMessageExternal`
  handler, and token responses). UI bundles (popup, options, offscreen documents, content scripts) MUST import only
  `@meetops/contracts/types`, which has no TypeBox. Upload limits (`CHUNK_UPLOAD_URL_TTL_SECONDS`, `MAX_CHUNK_BYTES`,
  `MAX_RECORDING_CHUNKS`, `MAX_CHUNKS`, `MAX_DURATION_MS`) come from `/types`, not from local mirrors.
- **Web (`apps/web`):** the pairing page showing an org and device confirmation; the pair call with CSRF; the
  `sendMessage` handoff; a device list with revoke in account settings.
- **DevOps:** rate-limit config (A1.4); production versus dev manifest build gating; log pipeline and Sentry scrubbing
  using `REDACT_KEYS`; alerts on refresh-reuse revocations.
- **SEC:** reviews each of the above before release.

## Amendment 2 (2026-10-25): realtime handshake

Proposed in [ADR-011](./ADR-011-realtime-auth.md) section 1, pending Architecture and Security sign-off there. The Socket.IO
handshake to `apps/realtime` becomes a bearer surface: the extension sends its access token in `auth.token` (never the query
string), with `aud=extension` and scope `recordings:write`, from an allowlisted `chrome-extension://<id>` origin, and MUST
NOT send a session cookie. Bearer sockets join only meeting rooms they pass the access check for, never the org-wide room.
Revoking a token family (A1.6) also publishes to `meetops:auth:revocations` so open sockets are disconnected.

## Amendment 3 (2026-10-26, Proposed): mobile header tokens

- Status: **Proposed - needs Architecture and Security sign-off** (see [Amendment 3 sign-off](#amendment-3-sign-off)).
  No route code may ship against it until both sign.
- Related: PR #170 (mobile `httpAuthClient`, whose shapes this amendment adopts unchanged),
  [ADR-011](./ADR-011-realtime-auth.md) Decision 1 item 4 (mobile audience), [ADR-006](./ADR-006-login-lockout-one-time-tokens.md)
  (login lockout), [ADR-012](./ADR-012-desktop-auth.md) (desktop tokens, same family design).

### A3.1 Context

The React Native app (`apps/mobile`) can't use the web cookie: there is no browser cookie jar it can protect with
`__Host-` and `SameSite`, and ADR-011 Decision 1 item 4 defers a mobile audience to "a later ADR". PR #170 already
builds against the routes below. This amendment defines audience **`mobile`** with the A1.2 token model (opaque hashed
tokens, rotating refresh, bounded family, reuse revokes the family).

### A3.2 Routes and exact shapes (all TypeBox objects `additionalProperties: false`)

| Route                       | Authenticated by                                     | Request              | Success                                                                                    |
| --------------------------- | ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `POST /auth/mobile/token`   | `LoginRequest` credentials in the body               | `LoginRequest`       | 200 `MobileTokenResponse`                                                                  |
| `POST /auth/mobile/refresh` | `refreshToken` in the body (not Bearer)              | `{ refreshToken }`   | 200 `MobileAuthTokens`                                                                     |
| `POST /auth/mobile/logout`  | `refreshToken` in the body (not Bearer)              | `{ refreshToken }`   | 204, idempotent                                                                            |
| `GET /auth/session`         | cookie **or** `Authorization: Bearer` (`aud=mobile`) | none                 | 200 `GetAuthSessionResponse`                                                               |
| `POST /orgs/switch`         | cookie **or** `Authorization: Bearer` (`aud=mobile`) | `{ organizationId }` | 200 `OrganizationWithRole & { tokens: MobileAuthTokens }` for Bearer; unchanged for cookie |

```ts
MobileAuthTokens = {
  tokenType: 'Bearer',
  accessToken: AccessToken, // opaque, ≥256 bits, base64url
  expiresAt: IsoDateTime, // access expiry
  refreshToken: RefreshToken, // opaque, ≥256 bits, base64url
  refreshExpiresAt: IsoDateTime, // family hard cap, not extended by rotation
  organizationId: Id,
};
MobileTokenResponse = { tokens: MobileAuthTokens, session: GetAuthSessionResponse }; // session is token-free
MobileRefreshRequest = { refreshToken: RefreshToken };
MobileLogoutRequest = { refreshToken: RefreshToken };
```

- `MobileAuthTokens` is a strict subset of the extension `tokenPair` and of `DesktopTokenResponse` (ADR-012 A1), so a
  shared client helper reads all three. `audience` and `scopes` are omitted to match PR #170; the server still records
  both on the token row and enforces them.
- `POST /auth/mobile/token` runs the full ADR-006 login path (lockout, constant-time failure, generic
  `UNAUTHENTICATED`), and issues tokens for the user's default (most recently active) org. A user with no org gets 403
  `FORBIDDEN` with no tokens. It MUST NOT set a cookie.
- `POST /orgs/switch` with a Bearer checks a live membership in the target org (not a member is `NOT_FOUND`, ADR-004),
  revokes the presented token's family, and issues a new family for the target org whose `refreshExpiresAt` is
  `min(old cap, now + 30 days)`. The cookie behaviour of `/orgs/switch` is unchanged.
- `logout` returns 204 for an unknown, expired or already-revoked token, so the client can wipe locally and never learn
  whether the token was valid. (PR #170 also tolerates 401/404 for compatibility.)
- Tokens travel only in the `Authorization` header or a JSON body; never in a URL, query string or deep link.

### A3.3 Bearer versus cookie

1. A request carrying **both** a session cookie and `Authorization: Bearer` is 401 `UNAUTHENTICATED` on every route.
2. `refresh` and `logout` ignore `Authorization`, reject a cookie, and are authenticated only by the body token.
3. Mobile bearer is accepted on `GET /auth/session`, `POST /orgs/switch` and the resource routes covered by its scopes.
   Every other route MUST reject a mobile bearer (A1.3.1 item 2).
4. Path `:organizationId` MUST equal the token's org, otherwise `NOT_FOUND`.
5. **Scopes** (`MOBILE_SCOPES`): `meetings:read`, `tasks:read`, `recordings:write`. Read-only for tasks, like desktop;
   task write or approve from mobile needs a further amendment. Enforced server-side in each route's auth hook.
6. No CORS headers on mobile routes: a native client sends no `Origin`, and a browser must not be able to call them
   cross-site.

### A3.4 CSRF exemption reasoning

The web cookie routes need `x-csrf-token` because the browser attaches the cookie automatically to a cross-site
request. The mobile routes carry **no ambient credential**: the access token is added explicitly by app code to the
`Authorization` header, and `refresh`/`logout` read a token from the JSON body. A malicious site can't make the
browser add either one, so CSRF does not apply and the mobile routes are exempt from the CSRF check. This holds only
while A3.3 item 1 (cookie + bearer together is rejected) holds, so a cookie can never be what authenticates a
mobile-exempt request. `POST /auth/mobile/token` is a credential exchange like `/auth/login` and needs no CSRF token
either, but it is rate limited and lockout-protected.

### A3.5 Lifetimes, rotation and reuse detection

1. Access TTL **15 minutes** (`MOBILE_TOKEN_TTL_SECONDS = 900`).
2. Refresh family max lifetime **30 days** from login (`MOBILE_REFRESH_FAMILY_MAX_LIFETIME_SECONDS = 2592000`), not
   extended by rotation; after it the user logs in again.
3. Every refresh consumes the presented token atomically and issues a new pair in the same family.
4. Presenting a consumed refresh token is reuse: revoke the whole family and its access tokens, return 401, publish
   `{ kind: 'session', sessionId: <familyId>, reason: 'mobile_revoked' }` on `meetops:auth:revocations`, and write an
   audit event. The app MUST serialise refreshes (one in flight) so normal use never trips this.

### A3.6 Revocation

The server MUST revoke mobile families on: `POST /auth/mobile/logout` (that family); logout-all and password change or
reset (all the user's families, `kind: 'user'`); removal from an org (that org's families, `kind: 'membership'`); org
switch (old family, `reason: 'org_switch'`); refresh reuse; and per-device revoke from web account settings. Each
revocation publishes to `meetops:auth:revocations` so open sockets drop (ADR-011 Decision 3).

### A3.7 Storage guidance (client)

- Refresh token: OS secure storage only. iOS Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (no iCloud sync, not
  restored to another device); Android Keystore-backed storage (`expo-secure-store`, or EncryptedSharedPreferences).
  Access token: in memory only.
- Never AsyncStorage, MMKV without encryption, files, logs, crash reports, analytics or deep links.
- Android: exclude the secure store from Auto Backup (`android:allowBackup` rules). iOS: no shared keychain group.
- On logout, reuse 401 or `session:revoked`, wipe both tokens and any cached org data.

### A3.8 Rate limits (DevOps tunes; 429 `RATE_LIMITED`)

- `token`: the `/auth/login` limits plus ADR-006 lockout; 10/min per IP, failures count double.
- `refresh`: 10/min per family, 60/min per IP; more often than every 60 s per family SHOULD be logged.
- `logout`: 10/min per family, 60/min per IP.
- Bearer `/orgs/switch`: 10/min per user.

### A3.9 Redaction and audit

`REDACT_KEYS` already covers `accessToken`, `refreshToken` and `authorization`; the mobile client logger MUST import the
same list. Audit events (no token values): `mobile.login`, `mobile.refresh_reuse`, `mobile.logout`, `mobile.revoked`
(with reason), `mobile.org_switched`.

### A3.10 Threat model

| Threat                                      | Mitigation                                                                                        | Residual                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Token theft from a lost or rooted device    | Keychain/Keystore `THIS_DEVICE_ONLY`; 15-min access; 30-day cap; per-device revoke from web       | A rooted, unlocked device can read the store until revoked |
| Stolen refresh token replayed elsewhere     | Rotation; reuse revokes the family and publishes revocation                                       | Window until the victim's next refresh (≤ 15 min)          |
| Credential stuffing on `/auth/mobile/token` | ADR-006 lockout, per-IP limits, generic errors                                                    | Same as web login                                          |
| CSRF                                        | No ambient credential; cookie + bearer rejected                                                   | None known                                                 |
| Token leaks via logs, URLs, deep links      | Header/body only; `REDACT_KEYS`; no query tokens                                                  | None known                                                 |
| Stale org access after removal              | Org-scoped tokens; verifier checks live membership; revocation fan-out                            | ≤ 5 min without Redis (ADR-011 ceiling)                    |
| Phishing app collecting passwords           | Store-signed app; future SSO/MFA via system browser (open question)                               | In-app password entry remains (see A3.11)                  |
| Cross-audience misuse                       | `aud=mobile` checked per route; mobile tokens rejected on extension/desktop routes and vice versa | None known                                                 |

### A3.11 Cross-amendments and open points

- **ADR-011 Decision 1 item 4** becomes, on acceptance: "`aud=mobile` bearers are verified with the same rules as
  `extension`, with scope `meetings:read` to connect, no `Origin` required, no org-room auto-join." Until then the
  verifier keeps returning `null` for `mobile`.
- **A1.2.5** gains `MobileTokenResponse`, `MobileAuthTokens` and the Bearer `/orgs/switch` response as token-bearing
  bodies; the contracts guard test is updated to match.
- In-app password login differs from ADR-012, which rejects it for desktop under RFC 8252. It is accepted here for M2
  because native UI (not an embedded web view) collects it and ADR-006 lockout applies; moving mobile to system-browser
  - PKCE when SSO/MFA ships is left open.

### Amendment 3 sign-off

| Role                      | Signer  | Date | Notes |
| ------------------------- | ------- | ---- | ----- |
| Architecture Agent (ARCH) | pending |      |       |
| Security Agent (SEC)      | pending |      |       |

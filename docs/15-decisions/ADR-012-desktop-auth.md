# ADR-012: Desktop (Tauri) sign-in, token storage and revocation

- Status: **Proposed - needs Architecture and Security sign-off** (see [Sign-off](#sign-off))
- Date: 2026-10-25
- Owners: Architecture Agent (ARCH) and Security Agent (SEC), co-owners; Native/Desktop, Backend (BE) and Web implement
- Related: [ADR-005](./ADR-005-extension-auth.md) (extension bearer tokens and pairing),
  [ADR-008](./ADR-008-oauth-pkce-token-encryption.md) (PKCE S256, redirect allowlists),
  [ADR-011](./ADR-011-realtime-auth.md) (shared verifier, `meetops:auth:revocations`, revalidation),
  [ADR-004](./ADR-004-db-contract-mapping.md) (other-org ids are NOT_FOUND), RFC 8252 (OAuth for native apps),
  RFC 7636 (PKCE), RFC 8628 (device authorization grant)
- Amends (proposed): ADR-011 Decision 1, items 3-4 (adds a `desktop` bearer audience) and ADR-005 A1.2.5 (token-bearing bodies)

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## Context

`apps/desktop` (Tauri 2, desktop scaffold PR #138) has a **mocked** sign-in. Its auth seam is:

- `features/auth/auth-client.ts`: `AuthClient { signIn(request: LoginRequest): Promise<DesktopSession>; signOut(): Promise<void> }`,
  with `DesktopSession = GetAuthSessionResponse`, the token-free contracts session shape. The comment there defers the
  real flow and "tokens in the OS keychain via the Rust side" to an Architecture decision.
- `features/auth/session.tsx`: `SessionProvider` holds the session in React state only, and nothing goes to
  `localStorage` or disk.
- `features/auth/sign-in-screen.tsx`: an email and password form (`TODO(desktop-auth)` in `mock-auth.ts`).
- `src-tauri/src/lib.rs`: one read-only command (`app_info`) called through `lib/native.ts` (`invoke`, with a browser
  fallback). `capabilities/default.json` grants `core:default` only. The CSP `connect-src` allows only `'self'` and IPC.
- The bundle identifier is still the placeholder `ai.meetops.desktop.todo-owner`.

The desktop app records meetings offline and uploads later (Phase 8), so it needs a credential that outlives one app
launch. The web cookie (`__Host-meetops_sid`) is the wrong fit: the Tauri webview runs on its own origin
(`tauri://localhost` / `http://tauri.localhost`), so it is a cross-site client like the extension (ADR-005 Context).
The `chrome.runtime` handoff that ADR-005 pairing relies on does not exist on the desktop. ADR-011 Decision 1 (items 3-4)
rejects every non-`extension` bearer audience until an ADR defines one.

## Options considered

### Option A: system-browser sign-in, authorization code + PKCE, loopback redirect (RECOMMENDED)

The app opens the user's default browser at the MeetOps web app. The user signs in there with the normal cookie flow
(password, and later SSO or MFA, unchanged), confirms the device, and the browser is redirected to
`http://127.0.0.1:<ephemeral-port>/callback` with a one-time code. The app exchanges the code plus its PKCE verifier
for desktop tokens. This is the RFC 8252 pattern for desktop apps.

- **For:** the password never enters the app or its webview. It reuses the web session, login lockout (ADR-006) and
  future SSO or MFA. PKCE makes a stolen code useless, and there's nothing for the user to type. There's no polling. The
  browser and the app are bound by `state` and the PKCE pair.
- **Against:** the app needs a short-lived local HTTP listener in Rust. Locked-down hosts may block loopback (rare, and
  it fails closed with a clear error). It needs a web route and page.

### Option A2: the same flow with a deep-link redirect (`meetops://callback` or a claimed https link)

- A **private-use scheme** can be registered by any app on Windows and Linux, so another app can take the redirect.
  PKCE stops that app from redeeming the code, but it can still show a fake "signed in" screen. Registration also varies
  by OS and installer.
- A **claimed https link** (universal link / app link) is the strongest redirect, but it needs the owned domain and the
  final bundle identifier, which are both TODO-owner today.
- **Not chosen for M2.** It MAY be added later by amending this ADR, keeping the same PKCE exchange. A deep link MAY be
  used only to bring the app to the front, never to carry the code.

### Option B: device pairing like ADR-005 (code shown in the app, approved on the web)

The app asks the API for a pairing code and shows it (or a QR code). The user approves it on a signed-in web page, and
the app polls until it gets tokens (RFC 8628-style, since there's no `chrome.runtime` channel).

- **For:** no local listener. It works where a browser can't be opened on the same machine.
- **Against:**
  - The user code is **phishable**: an attacker starts a pairing and persuades the victim to approve it ("device code
    phishing"). ADR-005 avoids this only because the nonce never leaves the extension.
  - The user has to type the code, and the app has to poll.
  - Nothing ties the approving browser to the requesting machine.
  - The API gains a polling endpoint and its rate limits.
- **Not chosen.** It stays the documented fallback for headless or kiosk installs, and needs its own amendment with
  phishing mitigations (a confirmation naming the device and the app's IP or location, a short TTL, one-time use).

### Option C: in-app email and password form (the M1 mock)

**Rejected.** The password goes through the webview. It defeats future SSO or MFA, and RFC 8252 section 8.12 says
embedded user agents must not collect credentials. `sign-in-screen.tsx` is replaced by a "Sign in with your browser"
button in M2.

## Decision

### 1. Flow (Option A)

1. Sign-in MUST start from a user gesture in the app. The Rust side generates:
   - `state`: 256-bit random, base64url
   - a PKCE S256 pair (32-byte verifier, per ADR-008 "State and PKCE" item 3)
   - a per-install `deviceId` (UUID, kept in the keychain item's metadata, not secret)
2. Rust binds a listener to **`127.0.0.1` only** (never `0.0.0.0` or `localhost` name resolution) on an OS-assigned
   ephemeral port. The listener:
   - accepts **one** `GET /callback` request
   - times out after **5 minutes**
   - answers with a static "You can close this tab" page that carries no script
   - then closes
3. Rust opens the system browser (Tauri opener plugin, scoped to the configured web origin only) at
   `<WEB_ORIGIN>/desktop/authorize?state=…&code_challenge=…&code_challenge_method=S256&redirect_uri=http://127.0.0.1:<port>/callback&device_id=…&device_label=…`.
4. The web page requires a signed-in web session. It MUST show a confirmation naming the user, the organization
   (`organizationName`) and the device label (as in ADR-005 A1.1 step 3) before calling `POST /auth/desktop/authorize`
   with the `__Host-` cookie and `x-csrf-token`.
5. The server validates `redirect_uri` exactly: scheme `http`, host `127.0.0.1`, any port (RFC 8252 section 7.3),
   path `/callback`, and no query, fragment or userinfo. This is a separate desktop allowlist; ADR-008 item 4 keeps
   loopback for dev only for integrations. The server then returns a single-use **authorization code** that:
   - is opaque and has 256 bits of entropy
   - is stored as a SHA-256 hash only
   - expires within 60 s
   - is bound to `(code_challenge, redirect_uri, deviceId, userId, organizationId)`
6. The page redirects to `redirect_uri?code=…&state=…`.
7. Rust MUST reject a callback whose `state` doesn't match (constant-time compare) and drops the listener either way.
   It then calls `POST /auth/desktop/token { code, codeVerifier, redirectUri, deviceId }`, without a cookie. The server
   MUST consume the code atomically (consumed on any mismatch, like ADR-008 "State and PKCE" item 2), check every binding and
   `S256(codeVerifier) == code_challenge`, and return `DesktopTokenResponse`.

### 2. Token model (mirrors ADR-005 A1.2)

1. Access and refresh tokens are opaque random values (≥256 bits, base64url), not JWTs, and are stored server-side as
   SHA-256 hashes only (the `@meetops/session-verifier` `hashToken`).
2. The audience is **`desktop`**. Scopes are a fixed subset: `meetings:read`, `meetings:resolve` and
   `recordings:write`. There's no admin, member-management or integration scope. Tokens are org-scoped to the org
   confirmed in step 1.4.
3. Access TTL: **15 minutes**. The refresh token rotates on every use, within a family bound to
   `(deviceId, userId, organizationId)`. Reusing a consumed refresh token revokes the whole family and its access
   tokens. Family max lifetime: **30 days** from sign-in, not extended by rotation.
4. Token-lifecycle routes (`/auth/desktop/token`, `/refresh`, `/revoke`, `/switch-org`) are authenticated by the code
   or refresh token in the body, bound to `deviceId`. They MUST ignore `Authorization` and reject a session cookie
   (401). Resource routes accept the desktop bearer only on the routes its scopes cover, the path `:organizationId`
   MUST equal the token's org (otherwise `NOT_FOUND`), and tokens are never accepted in the query string or URL.
5. `REDACT_KEYS` gains `code`, `codeVerifier`, `code_verifier` and `state` (in addition to `accessToken`, `refreshToken`
   and `authorization`). Every logger, Sentry `beforeSend` and the Rust side's logs MUST redact them.

### 3. Storage: OS keychain only, tokens never in the webview

1. The **refresh token** is persisted only in the OS credential store via the Rust `keyring` crate: macOS Keychain,
   Windows Credential Manager, or the Linux Secret Service (libsecret). The service is `<bundle identifier>.auth`, with
   one item per (user, org) family. The **access token** lives only in Rust process memory.
2. Tokens MUST NOT be written in plaintext anywhere on disk: no files, no `localStorage` / IndexedDB, no Tauri store
   plugin, no logs, no crash dumps the app writes. If no keychain backend is available (for example, Linux without a
   Secret Service), the app MUST **fail closed to memory-only**. It signs in for the session and asks again on next
   launch, and never falls back to a file.
3. Tokens MUST NOT cross the Tauri IPC boundary to the webview. The webview calls narrow Rust commands such as
   `auth_sign_in`, `auth_sign_out`, `auth_session` and `api_request`. Rust attaches the bearer and allows only the
   configured API origin and the scoped routes. Webview JS (and any XSS in it) can therefore never read a token. The
   CSP `connect-src` stays as in PR #138 (no API origin), and the capability file grants only these commands plus the
   scoped opener.
4. The PR #138 seam changes like this:
   - `AuthClient.signIn` takes no `LoginRequest`: `signIn(): Promise<DesktopSession>` starts the browser flow.
   - `signOut()` is unchanged.
   - `DesktopSession` stays the token-free `GetAuthSessionResponse`, and `SessionProvider` keeps it in memory only.
   - `mock-auth.ts` stays for tests and `vite dev` (`isTauri() === false`), as `native.ts` does today.
5. Offline recordings (Phase 8) are encrypted with a per-device key that is a separate keychain item, never derived
   from a token. Each queued item records `userId` and `organizationId`. Upload MUST use a token for that same user and
   org; otherwise the item waits and the user is asked to sign in to that org.

### 4. Refresh, sign-out and revocation

1. Rust refreshes about 60 s before the access token expires, and on any 401. One refresh runs at a time (a mutex), so
   parallel requests can't trigger reuse detection. If refresh fails with 401, the family is gone: Rust deletes the
   keychain item, clears memory, and the UI returns to the sign-in screen.
2. Sign-out calls `POST /auth/desktop/revoke { refreshToken, deviceId }`, then deletes the keychain item, even if the
   call fails offline. The server-side family then expires within 30 days at most. A pending revoke SHOULD be retried
   on the next launch.
3. The server MUST revoke desktop families on:
   - logout-all and password change or reset (all the user's families)
   - removal from an org (that org's families)
   - per-device revoke from web account settings (the sessions list, which shows `deviceLabel` and last use)
   - refresh-token reuse
4. Each revocation publishes `AuthRevocationMessage` on `meetops:auth:revocations` (ADR-011 Decision 3), with
   `kind: 'session'` (the family id as `sessionId`) or `kind: 'user'` / `'membership'`. Contracts adds a
   `desktop_revoked` reason next to `extension_revoked`.

### 5. Org switch and revalidation (consistent with ADR-011)

1. A desktop token is bound to one org. Switching org calls `POST /auth/desktop/switch-org { refreshToken, deviceId, organizationId }`.
   - The server checks a live membership in the target org under `runWithOrganizationContext`.
   - On success it revokes the old family, publishes `kind: 'session', reason: 'org_switch'` for it, and issues a new
     family for the new org.
   - An org the user isn't a member of returns `NOT_FOUND`, like every other other-org id (ADR-004).
   - No browser round trip is needed, because the user already proved identity at sign-in.
2. ADR-011 Decision 1 (items 3-4) is amended: `@meetops/session-verifier` accepts `aud=desktop` bearers with the same rules as
   `extension` (hash lookup, family not revoked or expired, live membership, the earliest `expiresAt`).
   - The realtime socket runs in Rust (a Socket.IO client in the core process), because the token never reaches the
     webview, and Rust forwards events to the UI over IPC. It sends `auth.token` in the handshake, never a cookie or a
     query parameter (ADR-011 Decision 1, item 2).
   - A native client has no meaningful `Origin`. The `desktop` rule therefore MUST NOT rely on an Origin allowlist; it
     MUST reject a handshake that carries a browser `Origin` other than the Tauri webview origins, and rely on the
     token, the audience and the scopes instead.
   - Like the extension, desktop sockets MUST NOT auto-join `organizations:{organizationId}` in M2. They may only
     `meeting:join` meetings in the token's org that pass `canAccessMeeting`. Widening this needs an amendment.
   - Sockets are re-verified at least every `REALTIME_REAUTH_INTERVAL_MS` (≤ 300 s) and on every join (ADR-011
     Decision 5).
   - On `auth:reauth-required` or `session:revoked`, the app refreshes (or signs out if that fails) and reconnects with
     the new token. On `org:access-changed` it reloads `auth_session` before showing org data again.
3. On every launch and after each refresh, the app MUST reload `GET /auth/session`-equivalent data (the desktop
   `auth_session` command) before showing org data, so a role change or removal shows within one access-token lifetime.

## Threat notes

| Threat                                                          | Mitigation                                                                                                                      | Residual                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Code interception (another local app on the port or scheme)     | PKCE S256, verifier only in Rust; 60 s single-use code; `127.0.0.1` bind with an OS-assigned port; no private-use scheme        | Local malware running as the user can read process memory; out of scope for an app-level control |
| Login CSRF / session mix-up (attacker's code into victim's app) | `state` checked in constant time; the code is bound to `redirect_uri` and `deviceId`; the web confirmation names the org        | None known                                                                                       |
| Open redirect or code exfiltration through `redirect_uri`       | Exact rule: `http://127.0.0.1:<port>/callback` only, with no query, fragment or userinfo                                        | None known                                                                                       |
| Phishing approval of an attacker's device                       | The flow starts in the user's own app and browser (no typed user code); the confirmation names the device; Option B is rejected | A user can still approve a fake app's request; signing and notarization (M5) reduce fake apps    |
| XSS in the webview steals tokens                                | Tokens never cross IPC; `api_request` is limited to the API origin and scoped routes; the PR #138 CSP stays strict              | XSS can still make scoped API calls while the app runs (same as any in-app action)               |
| Token theft from disk or backups                                | Keychain only; memory-only fallback; offline data is encrypted with a separate keychain key                                     | On Windows and Linux other processes of the same user may read the item; mitigated by short TTLs |
| Stolen refresh token used elsewhere                             | Rotation with reuse detection revokes the family; 30-day cap; per-device revoke; all revocations publish to realtime            | The window until the victim's next refresh (≤ 15 min)                                            |
| Stale org access after removal or role change                   | Org-scoped tokens; the verifier checks the live membership; realtime revalidation ≤ 300 s; revocation fan-out                   | Up to 5 min without Redis (ADR-011 accepted ceiling)                                             |
| Credentials in logs or crash reports                            | `REDACT_KEYS` extended (code, verifier, state); the Rust logger has the same denylist; no query-string tokens                   | None known                                                                                       |
| Loopback blocked or listener port in use                        | Ephemeral port picked by the OS; a 5-minute timeout; a clear error with retry; no fallback to a weaker flow                     | Users on such hosts wait for the Option B amendment                                              |

## Consequences

- The desktop gets real sign-in without handling passwords, and reuses web login, lockout and future SSO or MFA.
- New API surface (BE): `/auth/desktop/{authorize,token,refresh,revoke,switch-org}`, a desktop code and family store
  (hash only), the `desktop` audience in `@meetops/session-verifier`, the revocation triggers, and rate limits like
  ADR-005 A1.4.
- New web surface: `/desktop/authorize` with a confirmation, plus desktop devices in the account sessions list.
- Contracts (ARC, ADR-003):
  - `DESKTOP_TOKEN_AUDIENCE`, `DESKTOP_SCOPES` and the `Desktop{Authorize,Token,Refresh,Revoke,SwitchOrg}` request and
    response schemas, all strict.
  - A `desktop_revoked` revocation reason and the `REDACT_KEYS` additions.
  - The ADR-005 rule that only extension token responses carry tokens becomes "only extension and desktop token
    responses", and the contracts guard test is updated.
- Desktop (Rust): `keyring`, a loopback listener, a Rust Socket.IO client, the opener plugin scoped to the web origin, and IPC commands instead
  of direct webview fetches. The final bundle identifier MUST be set before the keychain service name ships, because
  changing it orphans stored items.
- Mobile stays out of scope. It needs its own audience in a later ADR (ADR-011 Decision 1, item 4).

### Owner dependencies

- **Desktop (M2):** the Rust auth module (PKCE, state, loopback, keychain, refresh mutex, IPC commands), the new
  `AuthClient.signIn()` seam, the sign-in screen as a browser button, and memory-only fallback. Tests: state
  mismatch, port timeout, refresh reuse handling, and no token in any IPC payload.
- **BE:** the routes and stores above, the verifier audience, revocation publishing and rate limits. Tests: a code
  replay, a wrong verifier, a bad `redirect_uri`, refresh reuse revoking the family, and org switch publishing.
- **Web:** the authorize page and confirmation, and the device list with revoke.
- **ARC:** contracts additions; amend ADR-005 A1.2.5 and ADR-011 Decision 1 when this is Accepted.
- **DevOps:** rate-limit config; Sentry and log scrubbing for the new keys; code signing and notarization (M5).
- **SEC:** reviews the above; SEC-2 adds the desktop rows to the RBAC matrix and threat model.

## Sign-off

Both signatures are required before Status moves to Accepted. Sign by replacing `pending` with the agent, date and PR.

| Role                      | Signer  | Date | Notes |
| ------------------------- | ------- | ---- | ----- |
| Architecture Agent (ARCH) | pending |      |       |
| Security Agent (SEC)      | pending |      |       |

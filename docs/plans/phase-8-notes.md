# Phase 8 backend notes (desktop and mobile offline recording)

Defaults chosen while filling the Phase 8 backend gaps from `docs/PHASE_STATUS.md`. Each one is a placeholder for a
decision by Shubham (or the ADR owners); change it here and in code together.

## Scope found

PHASE_STATUS lists Phase 8 as desktop (`apps/desktop`, mock sign-in, ADR-012 Proposed) and mobile (`apps/mobile`,
demo mode). Meetings list, tasks list, recording sessions and `RecordingSource` `desktop`/`mobile` already exist on
integration. The backend gap is native sign-in: ADR-012 desktop tokens, and the bearer accepted by the routes the
desktop scopes cover. Mobile tokens need their own ADR (ADR-012 "Mobile stays out of scope") and are not built.

## Defaults

| #   | Decision                           | Default                                                                             | Why                                                                                          |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D1  | Build ADR-012 while it is Proposed | Yes, schemas and routes, with the API routes off unless `DESKTOP_AUTH_ENABLED=true` | Lets desktop M2 integrate; nothing is served by default before sign-off                      |
| D2  | Token body field for the code      | `authorizationCode` (ADR says `code`)                                               | `code` is the error-body key; adding it to `REDACT_KEYS` would hide every error code in logs |
| D3  | Redact `state` server-side         | Not added to `REDACT_KEYS`                                                          | `state` stays inside the app (never sent to the API); the Rust logger still redacts it       |
| D4  | Loopback port range                | 1024-65535                                                                          | OS-assigned ephemeral ports are never privileged                                             |
| D5  | Mobile audience                    | Not built                                                                           | Needs an ADR-005/ADR-012-style amendment (token type, refresh, org switch)                   |

## Approval status

ADR-012's amendment (PR #192) is still awaiting sign-off. Until it is approved, all desktop auth code stays
off by default: the session-verifier accepts `desktop` bearers only when a caller passes
`bearerAudiences: ['extension', 'desktop']`, and the API desktop routes register only when
`DESKTOP_AUTH_ENABLED=true`.

- **D6 (session-verifier):** `bearerAudiences` defaults to `['extension']`; unknown audiences throw at
  construction. A `desktop` token verifies as `credential: 'desktop'`, keeping its scopes. apps/realtime
  rejects `desktop` credentials on both web and extension handshakes (no desktop socket class yet).

## PR3 — API desktop auth (behind `DESKTOP_AUTH_ENABLED`, default off)

Still gated on the ADR-012 amendment (PR #192) being signed off. Until then `DESKTOP_AUTH_ENABLED` stays unset, so none of this runs.

- **D7** With the flag off, the `/auth/desktop/*` routes aren't registered at all and return 404. The API verifier only accepts the `desktop` bearer audience when the flag is on.
- **D8** Desktop tokens live in their own store. That's Redis under the `meetops:desktop:` prefix, or in-memory when Redis isn't configured. Each family is checked against `clientId = meetops-desktop`, so extension and desktop tokens can't be swapped for each other. Durable Postgres persistence is left for later.
- **D9** Authorization codes reuse `PairingRecord`, with the code challenge in `nonce` and the redirect URI in `extensionId`. Only the hash is stored, each code works once and expires after 60 s, and any failed exchange burns the code.
- **D10** switch-org checks the refresh token without consuming it, so an org that isn't a membership gets a 404 and the token still works. The new family keeps the old absolute expiry, so the 30-day cap can't be extended.
- **D11** Desktop rate limits copy the extension ones, under a `desk:` key prefix.
- **D12** `bearerGuard` takes an `accept` list that defaults to `['extension']`, so existing routes never accept desktop tokens without an explicit opt-in.
- **D13** Desktop app routes refuse session cookies and send no CORS headers. Authorize is the only cookie-authenticated route, and it's behind the mutation guard.
- **D14** Logout, logout-all, password change and member removal also revoke desktop families, with reason `desktop_revoked`.

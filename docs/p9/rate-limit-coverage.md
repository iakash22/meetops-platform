# Rate-limit coverage review (P9 item #9)

Coverage only: which routes are rate-limited with the existing `RateLimiter` port (Redis fixed windows in
production, in-memory in tests). This is not a vulnerability review; that belongs to Tester & Security (#391).
Reviewed 2026-11-03 against `integration/phase-1` `d037a1cf`.

| Area                                    | Route(s)                                                                | Auth                   | Limited              | Keys                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------- | ---------------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| Auth                                    | signup, login, forgot/reset password, verify email, resend verification | public                 | yes                  | per IP + per email (`AUTH_LIMITS`), login lockout                                          |
| Auth                                    | new-location sign-in alerts                                             | session                | yes                  | per user + per location                                                                    |
| Auth                                    | `GET /auth/csrf`, `/auth/session`, logout, sessions                     | public / session       | no                   | cheap reads or session-bound; no change                                                    |
| Org invitations                         | send, accept                                                            | session / public token | yes                  | per org, per address, accept per IP (`INVITE_LIMITS`)                                      |
| Extension auth                          | pair, token, refresh, revoke                                            | session / bearer       | yes                  | per user, per IP, per family (`EXTENSION_LIMITS`)                                          |
| Desktop auth                            | authorize, token, refresh, revoke, switch-org                           | session / bearer       | yes                  | per user, per IP, per family (`DESKTOP_LIMITS`)                                            |
| Meetings                                | resolve                                                                 | session                | yes                  | per user + per org (`RESOLVE_LIMITS`)                                                      |
| Search                                  | both search routes                                                      | session                | yes                  | per org + user (`SEARCH_RATE_LIMIT`)                                                       |
| **Integration webhooks**                | `POST /webhooks/github`, `POST /webhooks/:provider/:integrationId`      | **public (HMAC)**      | **added in this PR** | per IP (600/min) + per target (300/min), checked before the HMAC                           |
| Integration / calendar OAuth callbacks  | `GET .../callback`                                                      | session + signed state | no                   | needs a session and a one-time state; low value                                            |
| Media uploads, recording-session chunks | presign, complete, chunk URLs                                           | session + org RBAC     | no                   | bounded by body/size limits and per-session state; follow-up candidate (needs Media owner) |
| `/health`, `/ready`, `/metrics`         |                                                                         | public / token         | no                   | infra probes; keep behind the network edge                                                 |

Follow-ups (not in this PR): per-user limits on upload presign and recording-session chunk URLs (Media stream),
and an edge (proxy/CDN) limit for `/metrics` if it is ever exposed publicly.

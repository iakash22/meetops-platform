# Phase 6 backend notes (defaults for open decisions)

Working notes for the Phase 6 (extension) backend PRs. Each entry records a default chosen where the ADRs leave a
decision open, so reviewers can overturn it explicitly.

## Extension bearer on API routes (feat/api-extension-bearer-routes)

Wires the existing ADR-005 A1.3.1 guard (`makeExtensionBearerGuard`) into the routes the extension calls.

| Decision                                                                    | Default chosen                                                                                                               | Why                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bearer-only vs dual auth on `meetings/resolve` and recording-session routes | **Dual**: a request with `Authorization: Bearer` takes the bearer path; without it, the cookie path is unchanged             | Web (`apps/web/src/features/recording`) and mobile already use these routes with the session; bearer-only would break them. A1.3.1's "reject a cookie" is kept on the bearer path: bearer + cookie -> 401 |
| Scopes                                                                      | `meetings:resolve` for resolve; `recordings:write` for recording-session init/chunks/complete/abort and upload init/complete | A1.3.1.5; uploads are the extension direct-upload path (`WXT_FEATURE_DIRECT_UPLOAD`)                                                                                                                      |
| Direct upload routes                                                        | Bearer allowed on `POST /orgs/:org/uploads` and `.../complete` only; `download-url` stays cookie-only                        | The extension only uploads; reading media stays a web action (A1.3.1.2)                                                                                                                                   |
| Session-scoped routes (no org in path)                                      | Bearer callers use the token's organization                                                                                  | Cookie callers use the session's active org; same 404 for an unknown or other-org session                                                                                                                 |
| CSRF on bearer requests                                                     | Skipped for requests that carry a Bearer header (in the meetings and media modules only)                                     | CSRF protects ambient cookies; the bearer path rejects any cookie, so there is nothing to forge                                                                                                           |
| Other routes                                                                | Unchanged; a bearer is never accepted (no cookie -> 401)                                                                     | A1.3.1.2                                                                                                                                                                                                  |
| CORS for `chrome-extension://` origins                                      | Not changed in this PR                                                                                                       | A1.3.1.6 is separate infra work; follow-up                                                                                                                                                                |

## Extension CORS on bearer routes (feat/api-extension-bearer-cors)

| Decision    | Default chosen                                                                                                           | Why                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Allowlist   | `chrome-extension://<id>` for each `EXTENSION_IDS` entry (same source as the auth lifecycle routes)                      | One config, A1.3.6                                                |
| Credentials | Never sent (`Access-Control-Allow-Credentials` absent)                                                                   | A1.3.6                                                            |
| Preflight   | 204 with `POST`, `authorization, content-type`, max-age 600; a disallowed extension origin gets 204 with no CORS headers | Mirrors the lifecycle routes; adds `authorization` for the bearer |
| Web CORS    | Skipped for any `chrome-extension://` origin on these routes; unchanged for web origins                                  | Credentialed CORS must never answer an extension origin           |
| Scope       | Only the 7 bearer route templates (`bearer-cors.ts`); other routes give extension origins no CORS                        | A1.3.1.2                                                          |

## Not started (blocked on decisions)

- **Standalone consent route `POST /extension/consent`**: ADR-005 Amendment 3 is still _Proposed_
  (branch `docs/adr-005-extension-consent-route`), and says nothing ships before ARCH/SEC/Contracts sign-off. Inline
  `consent` on upload and recording-session init remains the consent path.

## PHASE_STATUS refresh (P6)

- Updated the P6 row, the extension paragraph, gap 3 and the ADR-005 row to match integration: the extension-auth routes are served and revocation is enforced (#216).
- Bearer routes and CORS are recorded as "in review" until `feat/api-extension-bearer-routes` and `feat/api-extension-bearer-cors` merge. The percentage columns are unchanged.
- Desktop PKCE is still recorded as not served.

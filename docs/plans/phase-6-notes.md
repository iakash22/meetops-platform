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

## A1.4 frequent-refresh logging (feat/api-extension-refresh-frequency-log)

- ADR-005 A1.4: "A refresh more often than every 60 s per family SHOULD be logged." A refresh that arrives less than
  60 s after the previous accepted-for-processing refresh of the same family logs one `warn` line,
  `event: 'extension.token.refresh_frequent'`, with familyId, organizationId, userId, extensionId, deviceId, ip and
  `windowSeconds: 60`. It never contains tokens, codes or hashes.
- Defaults: log only, never reject (the 10/min per-family limit still rejects). The marker is the shared rate limiter
  (`ext:refresh:freq:<familyId>`, 1 per 60 s), so it is Redis-backed and works across API instances; no schema change.
  It runs after the reuse, binding and per-family limit checks, so replays and 429s are not double-reported. It is best
  effort: a limiter error never fails the refresh. No audit row (it is a signal, not a state change).
- Logger: `ModuleDeps.extensionAuthLog`, defaulting to the API's redacting `app.log`.

## PHASE_STATUS refresh (P6)

- Updated the P6 row, the extension paragraph, gap 3 and the ADR-005 row to match integration: the extension-auth routes are served and revocation is enforced (#216).
- Bearer routes and CORS are recorded as "in review" until `feat/api-extension-bearer-routes` and `feat/api-extension-bearer-cors` merge. The percentage columns are unchanged.
- Desktop PKCE is still recorded as not served.

## A1.5 log redaction at any depth (feat/redact-keys-any-depth)

- pino `redact.paths` (fast-redact) cannot do arbitrary depth: `*` matches one level, so `*.token` misses `a.b.token`
  (pinned by a test in packages/logger). `@meetops/logger` now runs a key walker (`redactDeep`) from
  `formatters.log`, and on child bindings (pino skips `formatters.bindings` for children, so `child()` is wrapped).
- Defaults: keys matched case-insensitively; value replaced with `***redacted***`; maxDepth 10 and 2000 nodes per log
  call (beyond either: `[Truncated]`); cycles become `[Circular]`. Walks plain objects, arrays and Errors only; other
  class instances (Fastify req/reply, Dates, Buffers) are left to pino serializers, and the fast-redact header paths
  stay as the backstop for serialized headers.
- `@meetops/logger` does not depend on contracts (that would change the lockfile). Its `DEFAULT_REDACT_KEYS` is a
  superset of contracts `REDACT_KEYS` (asserted in apps/api/test/log-redaction.test.ts), and api, worker and realtime
  pass `REDACT_KEYS` via the new `redactKeys` option. Realtime's Fastify now uses the redacting logger
  (`loggerInstance`) instead of `logger: true`; the worker uses `apps/worker/src/logger.ts`.

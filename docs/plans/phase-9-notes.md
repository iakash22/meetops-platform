# Phase 9 notes (hardening, release)

Source: `docs/PHASE_STATUS.md` (P9 row and "Phase 9 — Pending"). There is no separate Phase 9 plan doc yet.

## Scope taken (backend)

| Item                                                                                               | Status                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 medium security fixes (token revocation, realtime re-auth + connect rate limit, upload checksum) | Already merged into `integration/phase-1` (`fix/extension-token-revocation-immediate`, `fix/realtime-auth-recheck-ratelimit`, `fix/upload-checksum-verify`) |
| Monitoring: API readiness probes                                                                   | `feat/api-readiness-probes`                                                                                                                                 |
| Monitoring: API request metrics                                                                    | `feat/api-metrics-endpoint`                                                                                                                                 |

## Not taken

- **Dependabot (9 alerts)**: needs dependency and lockfile changes; out of scope for this stream.
- **Billing**: no ADR, plan or product decision exists.
- **Anything resting on Proposed ADRs**: ADR-011 realtime auth, ADR-012 desktop sign-in, ADR-006 lockout/one-time tokens, ADR-007/008 integrations retry + OAuth token encryption, ADR-009 AI routing/SSRF, ADR-010 `organizationId`. Open questions (KMS/secret manager, malware scanning, media retention, consent by jurisdiction, MFA) have no decision.

## Readiness (`GET /ready`)

- `/health` is liveness and never touches dependencies.
- `/ready` probes the clients the API process actually holds: Postgres (`SELECT 1` via Prisma) and Redis (`PING`). Processes with neither keep the old `200 {"status":"ready"}`.
- All OK: `200 {"status":"ready","checks":{"database":"ok","redis":"ok"}}`. Any failure: `503 {"status":"not_ready","checks":{...}}` with `ok | fail | timeout` per check.
- Per-probe timeout `READINESS_TIMEOUT_MS`, default 2000 ms (100..30000; anything else uses the default). Probes run in parallel; concurrent `/ready` calls share one in-flight run so probe floods don't fan out to the DB.
- Response bodies and logs carry check names and outcomes only (no error text, hosts or connection strings). The route logs at `warn` so probe traffic doesn't flood request logs.

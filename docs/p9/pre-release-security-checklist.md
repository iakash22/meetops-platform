# Phase 9 pre-release security checklist

Draft 3 Nov 2026 (IST) against `integration/phase-1` @ `78d8968b`. Every item needs evidence (link to CI run, PR, test name
or command output) and a sign-off before the first production release. Status: `[ ]` open, `[x]` done, `[~]` accepted risk (with owner + expiry).

Sign-off roles: **Owner** = Shubham (Akash, `iakash22`); **Sec** = security reviewer agent; **Dev** = implementing engineer (Techy);
**Coord** = Project Plan & Coordinator.

## Known open items from Phase 1 integration (must be closed or accepted)

| #   | Item                                                                                                                         | Source           | Needed                                                                 | Owner              |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- | ------------------ |
| K1  | Web bundle-size gate fails: Bootstrap CSS from main `336baccc` is ~39 kB gzip vs 11 kB budget                                | #374 sync        | Owner decision: drop/trim Bootstrap, or raise budget with rationale    | Owner              |
| K2  | Flaky `apps/api/test/integrations-runtime-kek.test.ts` (from #375): random "invalid" key is sometimes valid (~25% fail)      | #341/#349 review | Deterministic invalid key; 200× loop green                             | Dev                |
| K3  | ClamAV: read-only root FS never started on a real Docker host; tmpfs `mode=1777` broader than needed                         | #388             | Host smoke test; tmpfs `mode=0700,uid=<clamav>,noexec,nosuid,nodev`    | Dev + Owner (host) |
| K4  | Android device checks for #380 (Keystore) and #381 (FGS) on Android 12/13/14                                                 | #380/#381        | Run the device checklists in those PR reviews; record results          | Owner              |
| K5  | Consent migration orphan rows in dev DBs (rename to `20261031030000` + hardening #387)                                       | #384/#387        | Runbook step to clean/verify dev and staging DBs before prod migrate   | Dev                |
| K6  | Rotated Jira tokens discarded when the refresh lease is lost (new token pair from Jira dropped; connection may need re-auth) | #378/#382        | Persist-or-log path, or documented re-auth; metric + log on lost lease | Dev                |
| K7  | GDPR erasure plan for the consent → users FK (users with consent records can't be hard-deleted)                              | #334             | ADR: pseudonymise user, keep append-only consent with tombstone id     | Owner + Sec        |
| K8  | #386 recheck doesn't confirm same approval + reviewer at write time                                                          | #386             | Follow-up PR                                                           | Dev                |
| K9  | #385 calendar disconnect cascade only tested with mocked DB                                                                  | #385             | Live DB test                                                           | Dev                |
| K10 | Dependabot alerts not readable by agent token; dependency fix list in `dependency-audit.md`                                  | P9               | Token scope + lockfile PR                                              | Owner + Coord      |

## 1. Authentication and authorization

- [ ] Password hashing params (argon2id/bcrypt cost) reviewed; login, reset and verify rate limited and lockout tested.
- [ ] Session absolute + idle timeouts set to the owner-approved values; rotation on login/org switch; revoke-all works.
- [ ] RBAC matrix (`rbac-matrix.md`) enforced server-side on every route; route inventory test fails on a route without a guard.
- [ ] Extension (ADR-005) and desktop (ADR-012) pairing tokens: short TTL, refresh rotation with reuse detection, revoke.
- [ ] MFA/SSO decision recorded (open policy question). **Owner**

## 2. Tenant isolation / RLS

- [ ] Forced RLS on every tenant table; `rls.live` and `tenant-isolation.live` green against real Postgres+pgvector in CI (not skipped).
- [ ] App connects as a non-owner role without `BYPASSRLS`; migrator role used only for migrations.
- [ ] Semantic search (#350) filters by `organizationId` inside the vector query; cross-tenant search test.
- [ ] Workers set tenant context per job; no cross-tenant batch queries.
- [ ] Consent records append-only (grants + triggers) verified live, including `rls.live` audit append-only tests.

## 3. Secrets

- [ ] Secret manager/KMS chosen and wired (`TokenCipher` keys, `CSRF_SECRET`, `METRICS_TOKEN`, provider keys). **Owner**
- [ ] gitleaks in pre-commit and CI; full-history scan clean.
- [ ] No secrets in images, logs, error bodies or client bundles (`dist/` grep for key patterns).
- [ ] Key rotation runbook for KEK/DEK and integration token ciphers, with a tested rotation.

## 4. Dependencies and SBOM

- [ ] `dependency-audit.md` fix list applied or each item accepted with expiry.
- [ ] `scripts/audit-gate.mjs` in CI: no new high/critical.
- [ ] CycloneDX SBOM for npm and cargo attached to each release; licence report reviewed.
- [ ] Container base images pinned by digest and scanned (Trivy/Grype).

## 5. Security headers

- [ ] `security-headers-cors-requirements.md` R1–R6, R19–R25 implemented and tested (API, realtime, web nginx).
- [ ] Staging `curl -sI` evidence for web and API, including HSTS.

## 6. CORS

- [ ] R7–R12: exact allowlist from env, credentials only with echoed origin, `Vary: Origin`, preflight rules, non-browser routes CORS-free.
- [ ] Realtime handshake origin allowlist verified in staging.

## 7. Cookies and CSRF

- [ ] R13–R18: `__Host-` cookies, Secure/HttpOnly/SameSite, CSRF token + Origin check, JSON-only unsafe requests, proxy trust.

## 8. Rate limits and abuse

- [ ] Every unauthenticated or expensive route has a limiter (auth, uploads, recording chunk URLs, search, webhooks, public endpoints).
- [ ] Body size limits per route; upload size/type limits enforced server-side.
- [ ] Redis limiter fails closed for auth (or documented degrade).
- [ ] Webhook replay protection uses `RedisDeliveryStore` (shared across replicas). `InMemoryDeliveryStore` is
      per-process and refuses `NODE_ENV=production`; `selectIntegrationsRuntime` also refuses it at startup. Deliveries
      are claimed with a short-lived `SET NX` pending marker, the target rate-limit bucket is charged, then the marker
      is promoted to the full replay TTL (or deleted by its holder on 429, so the provider's retry is not a replay).

## 9. Logging and PII

- [ ] Pino redaction covers cookie, authorization, x-csrf-token, set-cookie, tokens, email/body fields; test asserts redaction.
- [ ] No transcript/meeting content or audio in logs; AI provider prompts not logged in prod.
- [ ] Log retention and access defined; audit log for admin actions.
- [ ] Embedding/AI provider data sharing documented (what text leaves the system, provider retention).

## 10. Encryption

- [ ] TLS 1.2+ everywhere (web, API, realtime WSS, DB, Redis, object storage); HSTS.
- [ ] At rest: Postgres volume/disk encryption, object storage SSE, integration tokens encrypted with `TokenCipher` (KEK in KMS).
- [ ] Mobile recordings encrypted on device (Keystore key); desktop equivalent documented.

## 11. Backups and DR

- [ ] Postgres PITR enabled; object storage versioning; key backups separated from data. **Owner (hosting)**
- [ ] Restore drill performed and timed; runbook in `docs/16-runbooks`.

## 12. Mobile

- [ ] K4 device checks done (Keystore hardware level, broken/deleted key paths, FGS type microphone on Android 14, no exported stop broadcast, no wakelocks, no plaintext `.aac` left).
- [ ] Software-only Keystore warning in release builds reviewed (ADR-015).
- [ ] Real bundle ids, EAS credentials, store privacy/data-safety forms. **Owner**

## 13. ClamAV / upload pipeline

- [ ] K3 done; clamd on internal network only, no egress except signature updates via a separate updater, non-root.
- [ ] Fail-closed policy: scan errors/timeouts quarantine; worker/clamd timeouts aligned; size-limit hits labelled distinctly from malware.
- [ ] Temp storage capped (no host disk fill); EICAR end-to-end test on staging.

## 14. Integrations OAuth tokens (GitHub App, Jira, Google/Outlook calendar)

- [ ] Tokens encrypted at rest, never logged; refresh lease (#378/#382) live; K6 resolved.
- [ ] OAuth `state`/PKCE verified; redirect URIs exact; scopes minimal.
- [ ] Webhook signatures verified with replay window; SSRF guard on outbound.
- [ ] Disconnect revokes provider tokens and deletes links (#385).

## 15. Consent and GDPR

- [ ] Consent API/UI (#334/#345/#387): backdating limit 24h, ordering safe across clock skew.
- [ ] K7 erasure plan approved and implemented; data export works; retention per jurisdiction decided. **Owner**
- [ ] K5 orphan-row cleanup verified before prod migrate.

## 16. Incident response

- [ ] Contacts and escalation (who is paged, where alerts go). **Owner**
- [ ] Runbooks: credential leak (rotate KEK/CSRF/provider keys), tenant data exposure, malware upload, provider outage.
- [ ] Alert rules for 5xx, latency, queue depth, `/ready` failures, auth failure spikes.
- [ ] Breach-notification timeline (GDPR 72h) documented.

## Sign-off

| Area                                    | Dev | Sec | Owner | Date (IST) |
| --------------------------------------- | --- | --- | ----- | ---------- |
| 1–2 Auth / RBAC / RLS                   |     |     |       |            |
| 3–4 Secrets / deps / SBOM               |     |     |       |            |
| 5–8 Headers / CORS / CSRF / rate limits |     |     |       |            |
| 9–11 Logging / encryption / backups     |     |     |       |            |
| 12 Mobile                               |     |     |       |            |
| 13 Uploads / ClamAV                     |     |     |       |            |
| 14 Integrations                         |     |     |       |            |
| 15 Consent / GDPR                       |     |     |       |            |
| 16 Incident response                    |     |     |       |            |
| K1–K10 known items                      |     |     |       |            |

Release is blocked until every row is signed or an accepted-risk entry names an owner and an expiry date.

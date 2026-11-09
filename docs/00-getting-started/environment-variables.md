## Environment variables

Copy `.env.example` to `.env` for local development. Every `change-me-local-dev` value is a **dev-only placeholder**.

Where each variable is read:

- **`@meetops/config` (Zod-validated):** `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, the base `STORAGE_*` settings (provider, endpoint, region, bucket, keys, path style), email/SMTP, and the AI provider variables.
- **Read elsewhere, with their own validation:**
  - API security (apps/api): `PORT`, `HOST`, `CSRF_SECRET`, `WEB_ORIGINS`.
  - Shared client IP (API + realtime, `@meetops/config`): `TRUST_PROXY`, `BEHIND_CLOUDFLARE` (shared in code; compose wiring differs — see `BEHIND_CLOUDFLARE` bullet).
  - Storage limits and TTLs (storage / media-core).
  - Realtime (apps/realtime): `REALTIME_*` (plus shared `TRUST_PROXY` / `BEHIND_CLOUDFLARE`).
  - Media tools (media-core): `FFMPEG_PATH`, `FFPROBE_PATH`.
  - Prisma: `MIGRATION_DATABASE_URL`.
  - Compose: `POSTGRES_*`, `MEETOPS_*_DB_PASSWORD`, `REDIS_PASSWORD`, `MINIO_*_PORT`, `WEB_ORIGIN`, `*_PORT`.

### Core

- `NODE_ENV`: `development` | `test` | `production`. Only `development` and `test` relax API security: they drop the `__Host-` cookie prefix, relax the CSRF/Origin requirements, and allow the localhost `WEB_ORIGINS` default. Anything else is strict.

### API (apps/api)

- `PORT` / `HOST`: the listen address (default `3000` / `0.0.0.0`). `API_PORT` is only the compose **host** port mapped to the container's `PORT=3000`.
- `CSRF_SECRET`: HMAC key for CSRF tokens. **Required in production**, at least 32 bytes (`openssl rand -base64 48`). In dev it's random per process when empty.
- `WEB_ORIGINS`: comma-separated allowlist for browser CORS (`Access-Control-Allow-Origin` + credentials) and for the API Origin/Referer check on mutations. **Required in production**; the dev default is `http://localhost:5173,http://localhost:3000`. This is not `WEB_ORIGIN` (below).
- `WEB_BASE_URL`: browser origin used in emailed links and as the page Google sign-in returns to. Its origin must be listed in `WEB_ORIGINS`. Dev: `http://localhost:5173`.
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`: web sign-in (authorization code + PKCE). Set all three or leave all three unset. Unset hides "Continue with Google". The redirect URI is the URL the browser hits and must match Google Cloud exactly; with the Vite `/api` proxy that is `http://localhost:5173/api/auth/google/callback`, not the API port. Production requires `https`. This client is separate from `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET`.
- `TRUST_PROXY`: **shared with realtime** (parser in `packages/config/src/client-ip.ts`). Comma list of proxy IPs/CIDRs (allowlist). Empty/`false` means no proxy (socket peer); `true` and `/0` are rejected. A hop count (`1`) is accepted in dev/test only and **fails startup in production** (ADR-014: it trusts a forged X-Forwarded-For). Production realtime behind nginx must allowlist nginx's address (or its CIDR). In compose one value feeds both services, so a broad docker-network CIDR makes the API trust that range too. `REALTIME_TRUST_PROXY_HOPS` was removed (non-zero fails realtime startup).
- `BEHIND_CLOUDFLARE`: `true` to use `CF-Connecting-IP`, only when the peer is in the pinned Cloudflare ranges (`packages/config/src/client-ip.ts`, re-exported by the API). **Same rule in code for API and realtime.** Default off. Raw X-Forwarded-For is never read.
  - **Compose gap:** `infra/compose/compose.app.yml` passes `BEHIND_CLOUDFLARE` only to the **realtime** service. The API `x-api-env` block does **not** include it, so a `.env` value does not reach the API container unless you inject it another way (override file, orchestrator env, or D-5). Non-compose deploys that set the variable for both processes are fine. Without the flag on the API behind Cloudflare, the resolved client IP is the Cloudflare edge (peer after `TRUST_PROXY`), so per-IP rate limits share one bucket per edge (cross-user 429s / lockouts, easy DoS). The flag remains fail-closed for spoofed headers (peer must be a pinned Cloudflare edge). Locking the origin firewall to those pinned Cloudflare ranges is recommended defence-in-depth.
- **IPv4-mapped IPv6 normalisation** (`normalizeIp` in `packages/config/src/client-ip.ts`): `::ffff:a.b.c.d` is treated as `a.b.c.d` (zone ids like `%eth0` are stripped). Effects for operators:
  - **TRUST_PROXY allowlists:** an IPv4 entry (e.g. `10.0.0.9`) matches a peer that appears as `::ffff:10.0.0.9` (`@fastify/proxy-addr` + `normalizeIp`). You do not need a separate mapped form in the list.
  - **Rate-limit / audit keys:** the resolved client IP is normalised before use, so `::ffff:203.0.113.7` and `203.0.113.7` share one bucket instead of splitting limits across two keys.
  - **Cloudflare edge check:** the peer is normalised before the pinned-range lookup, so a mapped Cloudflare edge still qualifies for `CF-Connecting-IP`.
- `GEOIP_PROVIDER`: `dbip` (default when `GEOIP_DB_PATH` is set), `geolite2` or `none`. Local mmdb lookups only; no external API, no paid provider, no fallback.
- `GEOIP_DB_PATH`: path to the DB-IP City Lite (or GeoLite2-City) `.mmdb`. Missing/unreadable: location lookups are off and session geo fields stay empty. See [GeoIP](../12-security/geoip.md).
- `GEOIP_UPDATE_URL` (worker): monthly mmdb updater source, e.g. `https://download.db-ip.com/free/dbip-city-lite-{YYYY}-{MM}.mmdb.gz`. Off unless this and `GEOIP_DB_PATH` are set. https only, exact host allowlist `GEOIP_UPDATE_ALLOWED_HOSTS` (default `download.db-ip.com`), redirects refused, size cap `GEOIP_UPDATE_MAX_BYTES` (default 256 MiB), optional `GEOIP_UPDATE_SHA256_URL`, `GEOIP_UPDATE_TEST_IPS`, `GEOIP_UPDATE_TIMEOUT_MS` (idle), `GEOIP_UPDATE_TOTAL_TIMEOUT_MS` (overall deadline, default 5 min). Default https port only. See [GeoIP](../12-security/geoip.md#getting-the-database-monthly-updater).

### Database

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: bootstrap superuser for the dev container. Required by `compose.dev.yml`, with no fallbacks. `POSTGRES_PORT` is the host port (default 5432, bound to 127.0.0.1).
- `MEETOPS_APP_DB_PASSWORD`, `MEETOPS_MIGRATOR_DB_PASSWORD`: login passwords for the PR #25 roles.
  - #25 creates `meetops_app` / `meetops_migrator` as NOLOGIN and expects LOGIN to be provisioned out of band.
  - The **dev stack instead creates them with LOGIN at first boot** via `infra/compose/postgres/initdb/10-meetops-roles.sh`.
  - That script only runs on an empty volume: **wipe the `postgres-data` volume to re-run it**.
- `DATABASE_URL`: runtime connection as `meetops_app` (NOSUPERUSER, NOBYPASSRLS, so RLS applies).
  - The API and the media worker (`apps/worker`, required since PR #118) use it as the runtime connection. Outside throwaway local setups it must be the `meetops_app` role (`NOBYPASSRLS`, DML only), never `meetops_migrator` or a superuser; see `packages/database/docs/ci-live-db.md`.
- `MIGRATION_DATABASE_URL`: Prisma `directUrl` for migrations and seed, as the schema owner `meetops_migrator`.

### Redis

- `REDIS_PASSWORD`: required; the dev Redis authenticates via an ACL file (`infra/compose/secrets/redis_acl.txt`, generated from `redis_password.txt`, mounted as a compose secret; never on the command line). `REDIS_PORT` is the host port (default 6379, bound to 127.0.0.1).
- `REDIS_URL`: must include the password, e.g. `redis://:<password>@localhost:6379`.

### Storage

**Local dev only:** the compose stack runs the pinned MinIO fork `pgsty/silo`. Production uses R2/S3 via StorageService.

- `MEDIA_STORAGE_ENABLED`: `true` backs the API upload routes with S3/MinIO (`STORAGE_*`) the Prisma `file_objects` / `consent_attestations` / `recording_sessions` tables, and enqueues media jobs on the BullMQ `media` queue the worker consumes; requires `DATABASE_URL` and `REDIS_URL`. Empty/`false` (default) keeps the in-memory adapters in development/test and leaves the media routes off elsewhere.
- `CONSENT_ENFORCEMENT_ENABLED`: `true` makes upload and recording-session init, chunk URLs and complete require the meeting's latest Consent API event (`meeting_consent_events`) to be a grant for the current consent version; anything else fails closed with 422 `VALIDATION_FAILED` + `CONSENT_*`, and uploads without a `meetingId` are refused. Empty/`false` (default) leaves enforcement off so existing clients keep working. Invalid values fail startup.
- `TASK_SYNC_ENABLED`: `true` registers `POST /orgs/:organizationId/tasks/:taskId/sync` (owner/admin, approved tasks only), which records a `task_sync_jobs` row (idempotent per task + integration) and enqueues it on the BullMQ `task-sync` queue; requires `REDIS_URL` and, outside development/test, `DATABASE_URL`. Empty/`false` (default): the route is not registered. The worker consumer (`processTaskSyncJob`) is not started yet: it needs a shared integration token key (ADR-008).
- `STORAGE_PROVIDER`: `minio` | `r2` | `s3`.
- `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`.
- `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`: in dev these are also the MinIO root credentials (dev-only placeholders).
- `STORAGE_FORCE_PATH_STYLE`: `true` | `false`. Empty means true for minio, false otherwise.
- `STORAGE_UPLOAD_TTL_SECONDS`: presigned upload URL TTL (default 600, range 1..600).
- `STORAGE_DOWNLOAD_TTL_SECONDS`: presigned download URL TTL (default 300, range 1..600).
- `STORAGE_MAX_OBJECT_BYTES` (default/max 2 GB), `STORAGE_MAX_PART_BYTES` (default/max 64 MiB), `STORAGE_MAX_PARTS` (default 1000, max 10000).
- `STORAGE_ALLOWED_MIME_TYPES`: comma-separated MIME allowlist override. Empty means the built-in list.
- `WEB_ORIGIN`: the **single** browser origin allowed by MinIO CORS for presigned PUT/POST (default `http://localhost:5173`; ETag is exposed). Never `*`. This is not `WEB_ORIGINS`.
- `MINIO_API_PORT` / `MINIO_CONSOLE_PORT`: host ports (default 9000 / 9001, bound to 127.0.0.1). The dev bucket is private and aborts incomplete multipart uploads after 1 day.

### Realtime gateway (apps/realtime)

- `REALTIME_HOST` (default `0.0.0.0`), `REALTIME_PORT` (default 4001). The compose `127.0.0.1:4001` port mapping is for **local development only**.
- `REALTIME_CORS_ORIGINS`: comma-separated allowed origins (dev: `http://localhost:5173`). Empty or `*` allows any, so set it explicitly.
- `REALTIME_SOCKET_PATH` (default `/socket.io`).
- `TRUST_PROXY` / `BEHIND_CLOUDFLARE` (realtime): the **same variables and rules as the API** (shared parser in `packages/config/src/client-ip.ts`). The per-IP limits key on the socket peer unless that peer is in the `TRUST_PROXY` IP/CIDR allowlist; then `X-Forwarded-For` is walked from the right, skipping trusted hops, and the first untrusted address is the client. Unset means trust nothing (socket address). Hop counts are dev/test only and fail startup in production. `Forwarded` is never read. **Behind nginx, list the nginx address (or its network CIDR).** Compose defaults realtime to the dev-only hop count `1` when `TRUST_PROXY` is unset. The old `REALTIME_TRUST_PROXY_HOPS` was removed; a non-zero value now fails startup so a deploy cannot silently drop proxy trust. IPv4-mapped peers are normalised (see API `TRUST_PROXY` / `BEHIND_CLOUDFLARE` bullets above). **Compose** wires `BEHIND_CLOUDFLARE` into realtime only; see the compose gap note under the API bullet.
- `REALTIME_MAX_SOCKETS_PER_USER` (default 20) and `REALTIME_MAX_SOCKETS_PER_IP` (default 50): concurrent socket caps, shared through Redis when `REDIS_URL` is set.
- `REALTIME_JOIN_LIMIT_PER_SOCKET` (default 30 per minute) and `REALTIME_MAX_ROOMS_PER_SOCKET` (default 50): `meeting:join` limits.
- `REALTIME_CORS_ORIGINS` must be `https://` unless `NODE_ENV=development`. In production `REDIS_URL` is required and must be `rediss://`.
- `REDIS_URL`: when set, enables the Socket.IO Redis adapter.

#### Realtime network exposure (production and self-host)

- Realtime must be reachable **only through nginx**. Production and self-host compose must **not** publish the realtime port (no `ports:` entry for the realtime service); nginx reaches it over the internal compose network.
- The `127.0.0.1:4001` mapping in `infra/compose/compose.app.yml` exists for local development only. Remove it (or use an override without it) for any production or self-host deployment.
- Why: defence in depth. Realtime honours `X-Forwarded-For` only from `TRUST_PROXY`-allowlisted peers, so a direct client's header is ignored, but a client inside an allowlisted CIDR (for example the compose network) could still set it. With the dev-only hop count, any direct client can.

### Media (worker)

- `FFMPEG_PATH`, `FFPROBE_PATH`: leave empty to resolve them from `PATH`, which also works on native Windows. The worker image sets `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`.
- `MEDIA_TMP_DIR`: set only by the worker Dockerfile/compose (`/tmp/work`, tmpfs). It is not in `.env.example`.
- Planned, not read yet: `MEDIA_WORKER_CONCURRENCY`, `MEDIA_CHUNK_SECONDS`.

### Compose host ports / web build

- `API_PORT` (3000), `WEB_PORT` (5173, `vite dev`), `WEB_APP_PORT` (8080, containerised nginx; must differ from `WEB_PORT`).
- `VITE_API_URL`: API base URL baked into the web build. Local Vite: use `/api` (or empty) so requests go through the Vite proxy to `PORT`/`API_PORT` (same-origin). An absolute `http(s)://…` URL skips the proxy and needs API CORS (`WEB_ORIGINS`). Optional `VITE_API_PROXY_TARGET` overrides the proxy upstream.

### Email (dev: SMTP/Gmail via Nodemailer)

- `EMAIL_PROVIDER`: smtp
- `SMTP_HOST`: smtp.gmail.com
- `SMTP_PORT`: 465
- `SMTP_SECURE`: true
- `SMTP_USER`
- `SMTP_PASSWORD`
- `EMAIL_FROM`: e.g. "MeetOps AI <noreply@example.com>"
- `AUTH_MAIL_QUEUE`: `inline` (default) or `bullmq`. `bullmq` (production, ADR-013 / notifications #11) enqueues ids-only auth mail jobs on the BullMQ `auth-mail` queue on `REDIS_URL` (deterministic, PII-free job ids `authmail_<kind>_<sha256>`; 5 attempts, exponential backoff from 2 s) and the worker sends through the provider-independent `EmailService` that `EMAIL_PROVIDER` explicitly selects (`smtp`: Mailpit in dev, Gmail opt-in; `resend`: production). There is never an automatic fallback: a failing provider retries or fails on that same provider. Resend 429/5xx/network errors and SMTP 4xx/connection errors retry; Resend other 4xx and SMTP 5xx fail fast. In strict environments it satisfies the `mailQueue` production dependency.
- `AUTH_MAIL_QUEUE_PREFIX`: optional BullMQ key prefix for that queue (default `bull`; the live test uses `qa:it:`).
- `AUTH_MAIL_WORKER_ENABLED`: `true` (default) runs the auth-mail consumer inside the API process when `AUTH_MAIL_QUEUE=bullmq`; set `false` on API replicas that should only enqueue.
- `AUTH_MAIL_WORKER_CONCURRENCY`: consumer concurrency, 1-50 (default 5).

### AI providers

These keys are owned and parsed by `@meetops/ai-core` (`loadAIEnv` in `packages/ai-core/src/env.ts`). The copies in `@meetops/config` are `@deprecated` and kept only for `AppConfig` shape compatibility; read AI settings from `loadAIEnv`. Boolean keys accept `true|false|1|0|yes|no|on|off`; unset uses the default shown (paid fallback stays off unless `AI_ALLOW_PAID_FALLBACK` is explicitly true).

- `AI_LLM_PROVIDER`: gemini
- `GEMINI_MODEL`: gemini-2.5-flash-lite
- `GEMINI_API_KEY`
- `AI_STT_PROVIDER`: assemblyai
- `ASSEMBLYAI_API_KEY`
- `OLLAMA_ENABLED`: false
- `OLLAMA_BASE_URL`: http://localhost:11434
- `OLLAMA_MODEL`: llama3.2
- `LOCAL_STT_ENABLED`: false
- `LOCAL_STT_URL`: http://localhost:8001 (the compose `local-stt` profile publishes host 127.0.0.1:8001 → container 8000; in-network services use `http://local-stt:8000`)
- `LOCAL_STT_MODEL`: Systran/faster-whisper-small
- `OPENAI_ENABLED`: false
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`: https://api.openai.com/v1
- `OPENAI_MODEL`: gpt-4o-mini
- `DEEPGRAM_ENABLED`: false
- `DEEPGRAM_API_KEY`
- `AI_ALLOW_PAID_FALLBACK`: false
- `AI_STORES` (worker): `durable` (default; Postgres `ai_usage_counters`, `ai_idempotency` and `ai_org_config`, forced RLS). `memory` is for unit tests only and is refused unless `NODE_ENV=test` (staging, production and an unset `NODE_ENV` all refuse it); store errors fail the job, never fall back to memory.
- `AI_REQUIRE_PROVIDER_APPROVAL`: true

### Integrations

GitHub, Jira and other integrations are configured as per-organization integration options (PR #19), **not env vars**.

### Test / CI variables (not in `.env.example`)

- `RLS_TEST_APP_URL` / `RLS_TEST_OWNER_URL`: enable the PR #25 live RLS tests (connect as `meetops_app` / the owner). Skipped when unset.
- `AI_SMOKE_AUDIO_FILE`: optional audio file for the AI provider smoke test (PR #21).
- CI audit gate: `scripts/audit-gate.mjs` (fail-closed, high/critical block). `AUDIT_GATE_NOW` overrides the date for local tests only (ignored in CI). Exceptions are defined in the script and documented in `docs/12-security/risk-exceptions.md`: RE-01 (braces@3.0.3, issue #54, expires 2026-11-20), RE-03 (node-forge@1.4.0, expires 2026-11-24) and RE-04 (image-size@1.2.1, two GHSAs, expires 2026-11-24).
- `STORAGE_APP_ACCESS_KEY_ID` / `STORAGE_APP_SECRET_ACCESS_KEY`: scoped MinIO user that minio-init creates for api/worker in the compose stack (read/write on `STORAGE_BUCKET` only). The root `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` is used only by minio/minio-init.

## Compose secrets (local dev)

`compose.dev.yml` / `compose.app.yml` pass passwords as compose `secrets:` files instead of plain env vars:

- Run `scripts/gen-dev-secrets.sh` (random values) or `scripts/gen-dev-secrets.sh --from-env` (copy from `.env`).
  This writes `infra/compose/secrets/*.txt`, which is gitignored.
- Postgres uses `POSTGRES_PASSWORD_FILE`. MinIO uses `MINIO_ROOT_PASSWORD_FILE`. The initdb roles script reads
  `/run/secrets/meetops_{app,migrator}_db_password`.
- App containers run `infra/compose/bin/with-secrets.sh`, which builds `DATABASE_URL` (by `DB_ROLE=app|migrator|none`),
  `REDIS_URL` and `STORAGE_SECRET_ACCESS_KEY` from `/run/secrets` at start-up.
- **Backend dependency:** native `*_FILE` support in `@meetops/config` (e.g. `DATABASE_URL_FILE`) would remove the shim.
  Until then the shim is the contract.
- `REALTIME_CORS_ORIGINS` is required by compose (`${REALTIME_CORS_ORIGINS:?}`). Use `http://localhost:5173` in dev, never `*`.
- Production object-storage lifecycle and CORS: see `infra/docs/object-storage-prod.md`.

## Compose `migrate` service

In the compose stack, `migrate` gets `MIGRATION_DATABASE_URL` and `DATABASE_URL`
(both `meetops_migrator`, built from secret files by `with-secrets.sh`). It exits
non-zero with `packages/database db:migrate:deploy missing; requires PR #35` while
the database scripts are missing, and `api`/`worker` depend on it completing
successfully, so the stack does not start until PR #35 merges. See
`infra/compose/README.md`.

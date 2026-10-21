## Environment variables

Copy `.env.example` to `.env` for local development. Every `change-me-local-dev` value is a **dev-only placeholder**.

Where each variable is read:

- **`@meetops/config` (Zod-validated):** `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, the base `STORAGE_*` settings (provider, endpoint, region, bucket, keys, path style), email/SMTP, and the AI provider variables.
- **Read elsewhere, with their own validation:**
  - API security (apps/api): `PORT`, `HOST`, `CSRF_SECRET`, `WEB_ORIGINS`, `TRUST_PROXY`.
  - Storage limits and TTLs (storage / media-core).
  - Realtime (apps/realtime): `REALTIME_*`.
  - Media tools (media-core): `FFMPEG_PATH`, `FFPROBE_PATH`.
  - Prisma: `MIGRATION_DATABASE_URL`.
  - Compose: `POSTGRES_*`, `MEETOPS_*_DB_PASSWORD`, `REDIS_PASSWORD`, `MINIO_*_PORT`, `WEB_ORIGIN`, `*_PORT`.

### Core

- `NODE_ENV`: `development` | `test` | `production`. Only `development` and `test` relax API security: they drop the `__Host-` cookie prefix, relax the CSRF/Origin requirements, and allow the localhost `WEB_ORIGINS` default. Anything else is strict.

### API (apps/api)

- `PORT` / `HOST`: the listen address (default `3000` / `0.0.0.0`). `API_PORT` is only the compose **host** port mapped to the container's `PORT=3000`.
- `CSRF_SECRET`: HMAC key for CSRF tokens. **Required in production**, at least 32 bytes (`openssl rand -base64 48`). In dev it's random per process when empty.
- `WEB_ORIGINS`: comma-separated allowlist for the API Origin/Referer check on mutations. **Required in production**; the dev default is `http://localhost:5173,http://localhost:3000`. This is not `WEB_ORIGIN` (below).
- `TRUST_PROXY`: hop count (`1`) or a comma list of proxy IPs/CIDRs. Empty means no proxy; `true` is rejected.

### Database

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: bootstrap superuser for the dev container. Required by `compose.dev.yml`, with no fallbacks. `POSTGRES_PORT` is the host port (default 5432, bound to 127.0.0.1).
- `MEETOPS_APP_DB_PASSWORD`, `MEETOPS_MIGRATOR_DB_PASSWORD`: login passwords for the PR #25 roles.
  - #25 creates `meetops_app` / `meetops_migrator` as NOLOGIN and expects LOGIN to be provisioned out of band.
  - The **dev stack instead creates them with LOGIN at first boot** via `infra/compose/postgres/initdb/10-meetops-roles.sh`.
  - That script only runs on an empty volume: **wipe the `postgres-data` volume to re-run it**.
- `DATABASE_URL`: runtime connection as `meetops_app` (NOSUPERUSER, NOBYPASSRLS, so RLS applies).
- `MIGRATION_DATABASE_URL`: Prisma `directUrl` for migrations and seed, as the schema owner `meetops_migrator`.

### Redis

- `REDIS_PASSWORD`: required; the dev Redis runs with `requirepass`. `REDIS_PORT` is the host port (default 6379, bound to 127.0.0.1).
- `REDIS_URL`: must include the password, e.g. `redis://:<password>@localhost:6379`.

### Storage

**Local dev only:** the compose stack runs the pinned MinIO fork `pgsty/silo`. Production uses R2/S3 via StorageService.

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

- `REALTIME_HOST` (default `0.0.0.0`), `REALTIME_PORT` (default 4001; compose binds 127.0.0.1:4001).
- `REALTIME_CORS_ORIGINS`: comma-separated allowed origins (dev: `http://localhost:5173`). Empty or `*` allows any, so set it explicitly.
- `REALTIME_SOCKET_PATH` (default `/socket.io`).
- `REDIS_URL`: when set, enables the Socket.IO Redis adapter.

### Media (worker)

- `FFMPEG_PATH`, `FFPROBE_PATH`: leave empty to resolve them from `PATH`, which also works on native Windows. The worker image sets `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`.
- `MEDIA_TMP_DIR`: set only by the worker Dockerfile/compose (`/tmp/work`, tmpfs). It is not in `.env.example`.
- Planned, not read yet: `MEDIA_WORKER_CONCURRENCY`, `MEDIA_CHUNK_SECONDS`.

### Compose host ports / web build

- `API_PORT` (3000), `WEB_PORT` (5173, `vite dev`), `WEB_APP_PORT` (8080, containerised nginx; must differ from `WEB_PORT`).
- `VITE_API_URL`: API base URL baked into the web build.

### Email (dev: SMTP/Gmail via Nodemailer)

- `EMAIL_PROVIDER`: smtp
- `SMTP_HOST`: smtp.gmail.com
- `SMTP_PORT`: 465
- `SMTP_SECURE`: true
- `SMTP_USER`
- `SMTP_PASSWORD`
- `EMAIL_FROM`: e.g. "MeetOps AI <noreply@example.com>"

### AI providers

- `AI_LLM_PROVIDER`: gemini; `GEMINI_MODEL`: gemini-2.5-flash-lite; `GEMINI_API_KEY`
- `AI_STT_PROVIDER`: assemblyai; `ASSEMBLYAI_API_KEY`
- `OLLAMA_ENABLED`: false; `OLLAMA_BASE_URL`: http://localhost:11434; `OLLAMA_MODEL`: llama3.2
- `LOCAL_STT_ENABLED`: false; `LOCAL_STT_URL`: http://localhost:8000 (the compose `local-stt` profile publishes 127.0.0.1:8000); `LOCAL_STT_MODEL`: Systran/faster-whisper-small
- `OPENAI_ENABLED`: false; `OPENAI_API_KEY`; `OPENAI_BASE_URL`: https://api.openai.com/v1; `OPENAI_MODEL`: gpt-4o-mini
- `DEEPGRAM_ENABLED`: false; `DEEPGRAM_API_KEY`
- `AI_ALLOW_PAID_FALLBACK`: false; `AI_REQUIRE_PROVIDER_APPROVAL`: true

### Integrations

GitHub, Jira and other integrations are configured as per-organization integration options (PR #19), **not env vars**.

### Test / CI variables (not in `.env.example`)

- `RLS_TEST_APP_URL` / `RLS_TEST_OWNER_URL`: enable the PR #25 live RLS tests (connect as `meetops_app` / the owner). Skipped when unset.
- `AI_SMOKE_AUDIO_FILE`: optional audio file for the AI provider smoke test (PR #21).
- CI audit gate: `AUDIT_LEVEL` (default `high`) and `AUDIT_TODAY` (override the date) for `scripts/ci/audit-gate.mjs`; exceptions live in `.github/audit-allowlist.json`.

## Environment variables

These variables are validated via `@meetops/config` (Zod) at runtime. Defaults support local development.

### Core

- `NODE_ENV`: development | test | production (default: development)

### Database

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: required by `infra/compose/compose.dev.yml` (no fallbacks; compose fails fast if unset). `POSTGRES_PORT` host port (default 5432, bound to 127.0.0.1)
- `MEETOPS_APP_DB_PASSWORD`, `MEETOPS_MIGRATOR_DB_PASSWORD`: passwords for the `meetops_app` / `meetops_migrator` login roles that `infra/compose/postgres/initdb/10-meetops-roles.sh` creates on first boot (wipe the `postgres-data` volume to re-run). Required.
- `DATABASE_URL`: runtime connection as `meetops_app` (NOSUPERUSER, NOBYPASSRLS, so RLS applies), e.g. postgresql://meetops_app:<password>@localhost:5432/meetops
- `MIGRATION_DATABASE_URL`: migrations and seed as the schema owner `meetops_migrator` (Prisma `directUrl`), e.g. postgresql://meetops_migrator:<password>@localhost:5432/meetops

### Redis

- `REDIS_PASSWORD`: required; compose runs Redis with `requirepass`. `REDIS_PORT` host port (default 6379, 127.0.0.1)
- `REDIS_URL`: redis connection string including the password, e.g. redis://:<password>@localhost:6379

### Storage

- `STORAGE_PROVIDER`: minio | r2 | s3 (default: minio)
- `STORAGE_ENDPOINT`: e.g. http://localhost:9000
- `STORAGE_REGION`: e.g. us-east-1
- `STORAGE_BUCKET`: e.g. meetops-dev
- `STORAGE_ACCESS_KEY_ID`
- `STORAGE_SECRET_ACCESS_KEY`
- `STORAGE_FORCE_PATH_STYLE`: true|false; empty = default (true when `STORAGE_PROVIDER=minio`, else false)
- `STORAGE_UPLOAD_TTL_SECONDS`: presigned upload URL TTL (default 600, max 600)
- `STORAGE_DOWNLOAD_TTL_SECONDS`: presigned download URL TTL (default 300, max 600)
- `STORAGE_MAX_OBJECT_BYTES`: max object size (default/max 2 GB)
- `STORAGE_MAX_PART_BYTES`: max multipart part size (default/max 64 MiB)
- `STORAGE_MAX_PARTS`: max multipart parts (default 1000, max 10000)
- `STORAGE_ALLOWED_MIME_TYPES`: comma-separated MIME allowlist override (empty = built-in list)
- `STORAGE_PRESIGN_EXPIRES_SECONDS`: presigned URL lifetime, 1..604800 (default 900)
- `WEB_ORIGIN`: the single browser origin allowed by MinIO CORS for presigned PUT/POST (default http://localhost:5173; ETag exposed). Never `*`.
- `MINIO_API_PORT` / `MINIO_CONSOLE_PORT` (**local dev only**: the compose stack runs the pinned MinIO fork `pgsty/silo`; production uses R2/S3 via StorageService): host ports for MinIO (default 9000 / 9001, 127.0.0.1). The dev bucket is private (no anonymous access) and aborts incomplete multipart uploads after 1 day.

### Realtime gateway (apps/realtime)

- `REALTIME_HOST`: bind address (default 0.0.0.0)
- `REALTIME_PORT`: listen port (default 4001; compose binds 127.0.0.1:4001)
- `REALTIME_CORS_ORIGINS`: comma-separated allowed origins; empty or `*` allows any (dev only)
- `REALTIME_SOCKET_PATH`: Socket.IO path (default /socket.io)
- `REDIS_URL`: when set, enables the Socket.IO Redis adapter

### Media (worker)

- `FFMPEG_PATH`: default /usr/bin/ffmpeg (worker image)
- `FFPROBE_PATH`: default /usr/bin/ffprobe (worker image)
- `MEDIA_TMP_DIR`: FFmpeg scratch dir (worker image/compose: /tmp/work on tmpfs)
- `MEDIA_WORKER_CONCURRENCY`: media jobs in parallel (default 1, 1..16)
- `MEDIA_CHUNK_SECONDS`: segment length (default 600, 10..3600)

### App ports / URLs

- `API_PORT`: host port for the containerised API (default 3000)
- `WEB_PORT`: Vite dev server (`pnpm dev`, default 5173)
- `WEB_APP_PORT`: containerised nginx web from `infra/compose/compose.app.yml` (default 8080); separate from `WEB_PORT`
- `VITE_API_URL`: API base URL baked into the web build (default http://localhost:3000)

### Email (dev: SMTP/Gmail via Nodemailer)

- `EMAIL_PROVIDER`: smtp
- `SMTP_HOST`: smtp.gmail.com
- `SMTP_PORT`: 465
- `SMTP_SECURE`: true
- `SMTP_USER`
- `SMTP_PASSWORD`
- `EMAIL_FROM`: e.g. "MeetOps AI <noreply@example.com>"

### AI providers (Phase 0 contracts only)

- `AI_LLM_PROVIDER`: gemini
- `GEMINI_MODEL`: gemini-2.5-flash-lite
- `GEMINI_API_KEY`
- `AI_STT_PROVIDER`: assemblyai
- `ASSEMBLYAI_API_KEY`
- `OLLAMA_ENABLED`: false
- `OLLAMA_BASE_URL`: http://localhost:11434
- `OLLAMA_MODEL`: llama3.2
- `LOCAL_STT_ENABLED`: false
- `LOCAL_STT_URL`: http://localhost:8000 (compose `local-stt` profile publishes 127.0.0.1:8000)
- `LOCAL_STT_MODEL`: Systran/faster-whisper-small
- `OPENAI_ENABLED`: false
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`: https://api.openai.com/v1
- `OPENAI_MODEL`: gpt-4o-mini
- `DEEPGRAM_ENABLED`: false
- `DEEPGRAM_API_KEY`
- `AI_ALLOW_PAID_FALLBACK`: false
- `AI_REQUIRE_PROVIDER_APPROVAL`: true

### Integrations (optional; not yet in the `@meetops/config` schema)

- `GITHUB_DEFAULT_REPO`: default `owner/repo` for created issues
- `GITHUB_WEBHOOK_SECRET`: HMAC secret for verifying GitHub webhooks
- `JIRA_BASE_URL`: e.g. https://your-org.atlassian.net
- `JIRA_EMAIL`: Jira account email for API auth
- `JIRA_API_TOKEN`: Jira API token
- `JIRA_PROJECT_KEY`: default Jira project key

## Environment variables

These variables are validated via `@meetops/config` (Zod) at runtime. Defaults support local development.

### Core

- `NODE_ENV`: development | test | production (default: development)

### Database

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`: required by `infra/compose/compose.dev.yml` (no fallbacks; compose fails fast if unset). `POSTGRES_PORT` host port (default 5432, bound to 127.0.0.1)
- `DATABASE_URL`: postgresql connection string; must match the `POSTGRES_*` values (e.g. postgresql://meetops:<password>@localhost:5432/meetops)

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
- `STORAGE_FORCE_PATH_STYLE`: true|false (default: true when `STORAGE_PROVIDER=minio`, else false)
- `STORAGE_PRESIGN_EXPIRES_SECONDS`: presigned URL lifetime, 1..604800 (default 900)
- `STORAGE_CORS_ORIGINS`: comma-separated browser origins allowed to PUT via presigned URLs (minio-init CORS; ETag exposed)
- `MINIO_API_PORT` / `MINIO_CONSOLE_PORT`: host ports for MinIO (default 9000 / 9001, 127.0.0.1). The dev bucket is private (no anonymous access) and aborts incomplete multipart uploads after 1 day.

### Media (worker)

- `FFMPEG_PATH`: default /usr/bin/ffmpeg (worker image)
- `FFPROBE_PATH`: default /usr/bin/ffprobe (worker image)

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
- `LOCAL_STT_ENABLED`: false
- `LOCAL_STT_URL`: http://localhost:8001
- `OPENAI_ENABLED`: false
- `OPENAI_API_KEY`
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

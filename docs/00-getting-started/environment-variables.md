## Environment variables

These variables are validated via `@meetops/config` (Zod) at runtime. Defaults support local development.

### Core

- `NODE_ENV`: development | test | production (default: development)

### Database

- `DATABASE_URL`: postgresql connection string (default: postgres://postgres:postgres@localhost:5432/meetops)
  - The API and the media worker (`apps/worker`, required since PR #118) use it as the runtime connection. Outside throwaway local setups it must be the `meetops_app` role (`NOBYPASSRLS`, DML only), never `meetops_migrator` or a superuser; see `packages/database/docs/ci-live-db.md`.

### Redis

- `REDIS_URL`: redis connection string (default: redis://localhost:6379)

### Storage

- `STORAGE_PROVIDER`: minio | r2 | s3 (default: minio)
- `STORAGE_ENDPOINT`: e.g. http://localhost:9000
- `STORAGE_REGION`: e.g. us-east-1
- `STORAGE_BUCKET`: e.g. meetops-dev
- `STORAGE_ACCESS_KEY_ID`
- `STORAGE_SECRET_ACCESS_KEY`
- `STORAGE_FORCE_PATH_STYLE`: true|false (default: true)

### Email (dev: SMTP/Gmail via Nodemailer)

- `EMAIL_PROVIDER`: smtp
- `SMTP_HOST`: smtp.gmail.com
- `SMTP_PORT`: 465
- `SMTP_SECURE`: true
- `SMTP_USER`
- `SMTP_PASSWORD`
- `EMAIL_FROM`: e.g. "MeetOps AI <noreply@example.com>"

### AI providers (Phase 0 contracts only)

These keys are owned and parsed by `@meetops/ai-core` (`loadAIEnv` in `packages/ai-core/src/env.ts`). The copies in `@meetops/config` are `@deprecated` and kept only for `AppConfig` shape compatibility; read AI settings from `loadAIEnv`. Boolean keys accept `true|false|1|0|yes|no|on|off`; unset uses the default shown (paid fallback stays off unless `AI_ALLOW_PAID_FALLBACK` is explicitly true).

- `AI_LLM_PROVIDER`: gemini
- `GEMINI_MODEL`: gemini-2.5-flash-lite
- `GEMINI_API_KEY`
- `AI_STT_PROVIDER`: assemblyai
- `ASSEMBLYAI_API_KEY`
- `OLLAMA_ENABLED`: false
- `OLLAMA_BASE_URL`: http://localhost:11434
- `LOCAL_STT_ENABLED`: false
- `LOCAL_STT_URL`: http://localhost:8001 (host port; the container listens on 8000)
- `OPENAI_ENABLED`: false
- `OPENAI_API_KEY`
- `DEEPGRAM_ENABLED`: false
- `DEEPGRAM_API_KEY`
- `AI_ALLOW_PAID_FALLBACK`: false
- `AI_REQUIRE_PROVIDER_APPROVAL`: true

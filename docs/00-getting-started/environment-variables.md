## Environment variables

These variables are validated via `@meetops/config` (Zod) at runtime. Defaults support local development.

### Core

- `NODE_ENV`: development | test | production (default: development)

### Database

- `DATABASE_URL`: postgresql connection string (default: postgres://postgres:postgres@localhost:5432/meetops)

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

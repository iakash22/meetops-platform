# Demo setup: flags and keys

How to switch on every backend piece for a full live demo. Everything below is **off by default**; turn flags on
only in your local `.env` (copied from `.env.example`). Never commit real values. There is no provider fallback:
if a selected provider is not configured, that step fails or stays off. It never switches to another provider.

## 1. Flags

| Flag                                 | Where                                   | Default                                                         | Demo value                             | What it does                                                                                                        |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MEDIA_STORAGE_ENABLED`              | API                                     | empty (off)                                                     | `true`                                 | Real upload/recording-session routes (MinIO + Prisma) that enqueue media jobs                                       |
| `TRANSCRIPTION_WORKER_ENABLED`       | worker                                  | `false`                                                         | `true`                                 | Starts the transcription consumer in `apps/worker` main()                                                           |
| `AI_SUMMARY_WORKER_ENABLED`          | worker                                  | `false`                                                         | `true`                                 | Starts the summary consumer (fed by the transcription worker)                                                       |
| `AI_ACTION_ITEMS_ENABLED`            | worker                                  | `true`                                                          | `true`                                 | Action-item extraction inside the summary job (drafts stay `pending_review`)                                        |
| `NOTIFICATIONS_WORKER_ENABLED`       | worker                                  | `false`                                                         | `true`                                 | ADR-013 outbox relay + delivery (needs `DATABASE_RELAY_URL`)                                                        |
| `INTEGRATIONS_TOKEN_REFRESH_ENABLED` | worker                                  | `false`                                                         | `true` if Jira/GitHub are connected    | Token-refresh sweep every `INTEGRATIONS_TOKEN_REFRESH_INTERVAL_MS` (default 300000). Needs `INTEGRATIONS_TOKEN_KEK` |
| `AUTH_MAIL_QUEUE`                    | API                                     | `inline`                                                        | `bullmq` (optional)                    | `bullmq` sends auth mail through the `auth-mail` BullMQ queue (needs `REDIS_URL`)                                   |
| `AUTH_MAIL_WORKER_ENABLED`           | API                                     | `true`                                                          | `true`                                 | With `AUTH_MAIL_QUEUE=bullmq`, the API process runs the `auth-mail` consumer and closes it on shutdown              |
| `DESKTOP_AUTH_ENABLED`               | API                                     | `false`                                                         | `true` only to demo the desktop app    | ADR-012 desktop PKCE sign-in routes (amendment PR #192 awaits sign-off)                                             |
| `WXT_FEATURE_HTTP_UPLOAD`            | extension build (`apps/extension/.env`) | on in development builds; off in production builds and in tests | `true` (or leave unset in a dev build) | Extension uploads recordings to the API instead of the stub client. Set `false`/`0` to force the stub in dev.       |
| `IP_RETENTION_ENABLED`               | worker                                  | on                                                              | leave on                               | ADR-014 daily raw-IP retention                                                                                      |
| `AI_REQUIRE_PROVIDER_APPROVAL`       | API/worker                              | `true`                                                          | keep `true`                            | Must stay true                                                                                                      |
| `AI_ALLOW_PAID_FALLBACK`             | API/worker                              | `false`                                                         | keep `false`                           | No free-to-paid fallback                                                                                            |

The auth-mail BullMQ consumer is started by the **API** process (`apps/api`), not `apps/worker`.

`WXT_FEATURE_HTTP_UPLOAD` is the exception to "off by default": a local `pnpm dev` / development-mode extension
build enables the real HTTP upload client unless you set the flag to `false` or `0`. A production extension
build still defaults to the stub, same as before; set `true` or `1` for a production-mode demo build.

## 2. Keys (leave empty in git; fill locally)

| Purpose                     | Variables                                                                                                                                                   | Notes                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| LLM summaries (Gemini)      | `GEMINI_API_KEY` (`GEMINI_MODEL=gemini-2.5-flash-lite`)                                                                                                     | The free Gemini tier must not process customer data; demo with test meetings only                                            |
| Speech-to-text (AssemblyAI) | `ASSEMBLYAI_API_KEY` (`AI_STT_PROVIDER=assemblyai`)                                                                                                         | Optional webhook mode: `ASSEMBLYAI_WEBHOOK_URL`, `ASSEMBLYAI_WEBHOOK_SECRET`                                                 |
| Google sign-in (web login)  | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`                                                                         | Set all three or none. Dev redirect `http://localhost:5173/api/auth/google/callback`. Separate client from calendar          |
| Google Calendar OAuth       | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`                                                                                                | Redirect `${INTEGRATIONS_API_ORIGIN}/calendar/google/callback`                                                               |
| Jira OAuth                  | `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`                                                                                                                      | Redirect `${INTEGRATIONS_API_ORIGIN}/integrations/jira/callback`                                                             |
| GitHub App                  | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY_FILE`, `GITHUB_APP_WEBHOOK_SECRET`          | See `docs/runbooks/integrations-real-setup.md`                                                                               |
| Integration token KEK       | `INTEGRATIONS_TOKEN_KEK`                                                                                                                                    | `openssl rand -base64 32`; **same value for API and worker**, otherwise the worker cannot decrypt tokens. Dev only (ADR-008) |
| Email                       | `EMAIL_PROVIDER=smtp\|resend\|console`; SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`; Resend: `RESEND_API_KEY`, `EMAIL_FROM` | Mailpit SMTP (`localhost:1025`) needs no key. No fallback between providers                                                  |
| Push (optional)             | `EXPO_ACCESS_TOKEN`                                                                                                                                         | Push channel is skipped until a push token cipher is wired                                                                   |

Infrastructure: `DATABASE_URL`, `DATABASE_RELAY_URL`, `REDIS_URL`, `STORAGE_*` (MinIO via `infra/compose`).

## 3. Not covered here

- Calendar background sync is in `apps/worker` and stays off unless `CALENDAR_SYNC_ENABLED=true`.
  It uses the calendar OAuth client, not `GOOGLE_OAUTH_*`.
- AI usage ledger and idempotency claims are durable in Postgres (`AI_STORES=durable`, the default) and survive worker
  restarts. `AI_STORES=memory` is for tests only and is refused unless `NODE_ENV=test`. The claim TTL must exceed the AI job
  deadline or the worker refuses to start; a billed call whose usage write fails keeps its claim, so a retry cannot
  bill twice.

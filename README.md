# MeetOps AI

Turn every meeting into actionable, assigned, measurable, and synchronized work.

Status: Pre-alpha. This repo is in Phase 0 (architecture and foundation). Features listed below are planned scope, not yet implemented. See `docs/17-agents/implementation-board.md` for live progress.

## Core flow

```text
Meeting → Recording / Transcript import → Transcription → Speaker resolution
→ AI understanding → Decisions & insights → Action extraction → Employee matching
→ Review & approval → Internal task → GitHub / Jira sync → Progress tracking
→ Follow-up intelligence
```

AI-generated tasks always stay drafts until an authorized person approves them, and every AI conclusion links back to transcript evidence.

## Who it's for

Software companies, IT agencies, product and client-delivery teams, project and engineering managers, and distributed teams.

## Tech stack

| Area            | Technology                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Monorepo        | pnpm workspaces, Turborepo, TypeScript (strict), ESLint, Prettier, Husky                                       |
| Web dashboard   | React, Vite, TanStack Router/Query, Tailwind CSS                                                               |
| Marketing site  | TanStack Start (planned next; not yet scaffolded)                                                              |
| API             | Node.js LTS, Fastify, Zod, OpenAPI/Swagger, Pino                                                               |
| Database        | PostgreSQL, Prisma ORM & Migrate, pgvector (semantic search)                                                   |
| Jobs & cache    | Redis, BullMQ                                                                                                  |
| Storage & media | S3-compatible (MinIO in dev), FFmpeg                                                                           |
| AI              | Pluggable STT (AssemblyAI, optional faster-whisper) and LLM providers (Gemini, others)                         |
| Email           | Provider-independent email service; dev uses Gmail SMTP via Nodemailer (smtp.gmail.com:465, TLS, App Password) |
| Testing         | Vitest                                                                                                         |
| DevOps          | Docker, Docker Compose, GitHub Actions                                                                         |

No Next.js, no MongoDB, and no Kubernetes at the start. The backend is a modular monolith with independently scalable workers.

## Architecture

```text
React Web
    │
Fastify Business API ── PostgreSQL ── Outbox
    │                                │
    └──────────── Redis / BullMQ ────┘
                     │
   Media Worker (FFmpeg) · AI Worker (STT + LLM) · Integration Worker
                     │
             Realtime Event Gateway → UI
```

## Repository structure

```text
meetops-ai/
├── apps/
│   ├── web/          # Authenticated React dashboard
│   ├── api/          # Fastify business API
│   └── worker/       # BullMQ background processors
├── packages/         # Shared code: contracts, config, database, ai-core, queue, storage, logger…
├── infra/            # Docker & Compose
├── docs/             # Architecture, guides, ADRs, runbooks
└── .github/          # CI/CD workflows and templates
```

Planned next (not yet in repo): `apps/marketing` (TanStack Start).

## Getting started

Prerequisites: Node.js LTS, pnpm, Docker and Docker Compose, FFmpeg.

```bash
git clone <repo-url> meetops-ai
cd meetops-ai
cp .env.example .env            # fill in local values
pnpm install
./scripts/gen-dev-secrets.sh --from-env   # compose secrets in infra/compose/secrets (gitignored)
docker compose --env-file .env -f infra/compose/compose.dev.yml up -d   # Postgres, Redis, MinIO (+ optional profiles)
pnpm dev
```

Common scripts:

```bash
pnpm build       # build all apps and packages
pnpm lint        # lint
pnpm typecheck   # type-check
pnpm test        # unit tests
```

### Windows local setup (C:\dev)

From PowerShell, with Docker Desktop running:

```powershell
cd C:\dev
git clone https://github.com/iakash22/meetops-platform.git
cd C:\dev\meetops-platform
Copy-Item .env.example .env     # fill in local values; never commit .env
pnpm install
sh scripts/gen-dev-secrets.sh --from-env  # compose secrets from .env (sh from Git for Windows)
pnpm dev:infra:up               # docker compose --env-file .env -f infra/compose/compose.dev.yml up -d
pnpm dev
pnpm dev:infra:down             # stop the infra stack
```

Equivalent raw command: `docker compose --env-file .env -f infra/compose/compose.dev.yml up -d`. Keep `--env-file .env`: Compose otherwise looks for `.env` next to the compose file (`infra/compose/`), not in the repo root, and the required `POSTGRES_*` / `STORAGE_*` values would be missing. `pnpm dev:infra:logs` tails container logs.

Email in development needs `SMTP_PASSWORD` (a Google App Password) in your local `.env`. Only the variable name is documented here; never commit or share its value. See `docs/00-getting-started/environment-variables.md` and `docs/17-agents/credential-requests.md`.

## Roadmap

| Phase | Scope                                                            |
| ----- | ---------------------------------------------------------------- |
| 0     | Monorepo foundation, tooling, Docker Compose, logging, basic CI  |
| 1     | Auth, organizations, employees, teams, projects, RBAC            |
| 2     | Meetings, uploads, browser recording, FFmpeg pipeline            |
| 3     | Transcription, reports, decisions, task drafts with evidence     |
| 4     | Task review, approval, assignment, notifications                 |
| 5     | GitHub and Jira integrations with two-way sync                   |
| 6     | Live transcription and browser extension                         |
| 7     | Calendar, Meet/Zoom/Teams imports, search, automation, analytics |
| 8     | Desktop and mobile apps with offline recording                   |
| 9     | Production hardening, billing, monitoring, release               |

The first milestone is a working end-to-end slice: create organization → add employee → create project → upload audio → transcribe → generate report → extract and approve tasks → create GitHub/Jira issue → sync status.

## Storage

All file storage goes through a provider-independent `StorageService` interface (`packages/storage`), built on the AWS SDK S3 client. Business modules never call a provider directly, so switching providers is a configuration change, not a code change.

- Development: MinIO, an S3-compatible store that runs free in Docker Compose.
- Production: Cloudflare R2 or AWS S3. Both use the same S3 adapter with a different endpoint and credentials.
- Selection: `STORAGE_PROVIDER=minio|r2|s3`, plus `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` and `STORAGE_FORCE_PATH_STYLE`.
- PostgreSQL holds file metadata only (owner, key, size, checksum, status). Media bytes always live in object storage.

## Free development stack

Everything runs locally with no paid services: PostgreSQL, Redis, BullMQ, MinIO and FFmpeg, started through Docker Compose (`infra/compose/compose.dev.yml`). Optional profiles include `ollama` and `local-stt`.

## Email

All email goes through a provider-independent `EmailService` interface (`packages/notification` planned). Business modules only call that interface, so moving to another SMTP server or an API provider later is a configuration change plus a new adapter, not a module rewrite.

- Development provider: Gmail SMTP with Nodemailer: host `smtp.gmail.com`, port `465`, `secure: true`, Gmail address plus a Google App Password.
- Selection: `EMAIL_PROVIDER=smtp` (default). Credentials come from backend env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`.
- Delivery: sent asynchronously through a BullMQ `email` queue with retries and backoff (queue processor to be added).
- Templates: versioned, managed email templates (later).
- Emails covered: email verification, forgot/reset password, employee invitations, task notifications, meeting notifications (later).
- Paid providers (Resend, SES, Postmark) are not integrated during development.

## Security and privacy

Multi-tenant isolation, secure HTTP-only sessions, explicit recording consent, encrypted integration tokens, verified webhooks, and transcripts treated as untrusted input to AI. The design targets UK/EU GDPR but makes no compliance claims without evidence. See `SECURITY.md` to report vulnerabilities.

## Contributing

Work happens on feature branches (`feat/…`, `fix/…`, `chore/…`, `docs/…`) with Conventional Commits and pull requests that must pass CI and review. See `CONTRIBUTING.md`.

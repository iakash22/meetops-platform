# MeetOps AI

Turn every meeting into actionable, assigned, measurable, and synchronized work.

Status: Pre-alpha, Phase 1 integration-branch workflow (`integration/phase-1`); Phases 1–9 in progress in parallel (coordinator estimate **~79%** overall on 3 Nov 2026). Active work: P7 (calendar/search/analytics), P8 (native desktop/mobile) and P9 (hardening/release). Integration → `main` is open as [#384](https://github.com/iakash22/meetops-platform/pull/384); only Akash merges into `main`. See [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md) for per-phase numbers and what is still open.

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
Web (React) · Extension (WXT) · Desktop (Tauri) · Mobile (Expo)
    │
Fastify Business API (apps/api) ── PostgreSQL ── Outbox
    │                                │
    └──────────── Redis / BullMQ ────┘
                     │
   apps/worker: media (FFmpeg, clamd) · AI (STT + LLM, embeddings) · integrations · calendar · notifications
                     │
   Realtime gateway (apps/realtime, Socket.IO) → clients
```

## Repository structure

```text
meetops-ai/
├── apps/
│   ├── web/          # Authenticated React dashboard
│   ├── api/          # Fastify business API
│   ├── worker/       # BullMQ background processors
│   ├── realtime/     # Socket.IO realtime gateway
│   ├── extension/    # WXT (Manifest V3) browser extension
│   ├── desktop/      # Tauri 2 desktop app
│   └── mobile/       # Expo (React Native) mobile app
├── packages/         # Shared code: contracts, config, database, ai-core, integrations, media-core,
│                     # notifications, queue, session-verifier, storage, logger
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
docker compose -f infra/compose/compose.dev.yml up -d   # Postgres, Redis, MinIO (+ optional profiles)
pnpm db:generate                # Prisma client (also runs on install)
pnpm db:roles                   # meetops_app / meetops_migrator roles; needs ADMIN_DATABASE_URL (uncomment it in .env)
pnpm db:migrate                 # prisma migrate deploy (use `pnpm db:migrate:dev` when changing the schema)
pnpm db:seed                    # prisma/seed.ts (idempotent)
pnpm dev
```

The database steps follow the same order as CI (`.github/workflows/ci.yml`): generate, roles, migrate deploy, seed. `db:migrate` and `db:seed` use `MIGRATION_DATABASE_URL` (`meetops_migrator`); the apps use `DATABASE_URL` (`meetops_app`, RLS enforced). See [local setup](docs/00-getting-started/local-setup.md).

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
pnpm db:generate
pnpm db:roles                   # needs ADMIN_DATABASE_URL (uncomment it in .env)
pnpm db:migrate
pnpm db:seed
pnpm dev
pnpm dev:infra:down             # stop the infra stack
```

Equivalent raw command: `docker compose -f infra/compose/compose.dev.yml up -d` (the pnpm scripts also pass `--env-file .env`). `pnpm dev:infra:logs` tails container logs.

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

Current status of each phase (31 Oct 2026 snapshot), including unfinished work, is in [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md).

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

All email goes through a provider-independent `EmailService` interface (`packages/notifications`). Business modules only call that interface, so moving to another SMTP server or an API provider later is a configuration change plus a new adapter, not a module rewrite.

- Development provider: Gmail SMTP with Nodemailer: host `smtp.gmail.com`, port `465`, `secure: true`, Gmail address plus a Google App Password.
- Selection: `EMAIL_PROVIDER=smtp|resend|console` (default `smtp`; `console` is refused in production). Credentials come from backend env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `RESEND_API_KEY`, `EMAIL_FROM`. The API wires the real mailer since #251; see `docs/08-email/delivery.md`.
- Delivery: the API currently sends through an inline queue (not allowed in production); the BullMQ mail queue and its worker consumer are still to be added.
- Templates: versioned, managed email templates (later).
- Emails covered: email verification, forgot/reset password, employee invitations, task notifications, meeting notifications (later).
- Resend is available as a fetch-based provider (#251). SES and Postmark are not integrated.
- Wider notifications (in-app, push, digests, preferences) are planned in [ADR-013](docs/15-decisions/ADR-013-notifications-architecture.md) (Proposed) and [`docs/plans/notifications-architecture.md`](docs/plans/notifications-architecture.md).

## Security and privacy

Multi-tenant isolation, secure HTTP-only sessions, explicit recording consent, encrypted integration tokens, verified webhooks, and transcripts treated as untrusted input to AI. The design targets UK/EU GDPR but makes no compliance claims without evidence. See `SECURITY.md` to report vulnerabilities.

The signed-out web auth pages and the extension popup/options page link to a Privacy Policy when `VITE_PRIVACY_URL` / `WXT_PRIVACY_URL` are set (see `.env.example` and `apps/extension/.env.example`). Production builds warn, but do not fail, if that URL is missing. Terms of Service on the web use `VITE_TERMS_URL` independently.

## Contributing

Work happens on feature branches (`feat/…`, `fix/…`, `chore/…`, `docs/…`) with Conventional Commits and pull requests that must pass CI and review. See `CONTRIBUTING.md`.

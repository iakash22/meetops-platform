# meetops-platform

**Turn every meeting into actionable, assigned, measurable, and synchronized work.**

Meeting Intelligence is a B2B SaaS platform that captures meetings (live or uploaded recordings), produces timestamped transcripts with speaker attribution, generates evidence-backed meeting reports, extracts decisions and action items, matches them to real employees, and, after human review, creates and syncs tasks in tools like GitHub and Jira.

> **Status:** Pre-alpha. The repository is being set up (Phase 0). Features listed below are the planned scope, not yet implemented. See [`docs/17-agents/implementation-board.md`](docs/17-agents/implementation-board.md) for live progress.

---

## Core flow

```text
Meeting → Recording / Transcript import → Transcription → Speaker resolution
→ AI understanding → Decisions & insights → Action extraction → Employee matching
→ Review & approval → Internal task → GitHub / Jira sync → Progress tracking
→ Follow-up intelligence
```

AI-generated tasks always stay **drafts until an authorized person approves them**, and every AI conclusion links back to transcript evidence.

## Who it's for

Software companies, IT agencies, product and client-delivery teams, project and engineering managers, and distributed teams.

## Tech stack

| Area | Technology |
| --- | --- |
| Monorepo | pnpm workspaces, Turborepo, TypeScript (strict), ESLint, Prettier, Husky |
| Web dashboard | React, Vite, TanStack Router/Query/Table, Zustand, Tailwind CSS, shadcn/ui, React Hook Form, Zod |
| Marketing site | React, TanStack Start (selective SSR) |
| API | Node.js LTS, Fastify, TypeBox, Zod, OpenAPI/Swagger, Pino, CASL |
| Database | PostgreSQL, Prisma ORM & Migrate, pgvector (semantic search) |
| Jobs & cache | Redis, BullMQ |
| Storage & media | Cloudflare R2 (S3-compatible), FFmpeg, MediaRecorder, Web Audio API |
| AI | Pluggable STT (AssemblyAI, Deepgram, optional faster-whisper) and LLM providers (OpenAI and others) |
| Realtime | WebSocket audio streaming, Socket.IO events |
| Extension | WXT, Chrome Manifest V3 (Chrome, Edge) |
| Desktop | Tauri (Windows, macOS, Linux) |
| Mobile | React Native, Expo (Android, iOS) |
| Testing | Vitest, React Testing Library, Playwright, Testcontainers, k6 |
| DevOps | Docker, Docker Compose, GitHub Actions, OpenTelemetry, Sentry, Prometheus, Grafana, Loki, Terraform |

No Next.js, no MongoDB, and no Kubernetes at the start. The backend is a **modular monolith** with independently scalable workers.

## Architecture

```text
React Web · Browser Extension · Desktop · Mobile
                    │
             Fastify Business API ── PostgreSQL ── Outbox
                    │                                │
                    └──────────── Redis / BullMQ ────┘
                                     │
          Media Worker (FFmpeg) · AI Worker (STT + LLM) · Integration Worker (GitHub/Jira)
                                     │
                         Realtime Event Gateway → UI
```

## Repository structure

```text
meeting-intelligence/
├── apps/
│   ├── web/          # Authenticated React dashboard
│   ├── marketing/    # Public site (TanStack Start)
│   ├── api/          # Fastify business API
│   ├── worker/       # BullMQ background processors
│   ├── realtime/     # Streaming & socket gateway
│   ├── extension/    # Browser capture extension
│   ├── desktop/      # Tauri desktop app
│   ├── mobile/       # React Native app
│   └── ai-service/   # Optional Python inference service
├── packages/         # Shared code: ui, contracts, database, ai-core, integrations, queue, storage, logger…
├── infra/            # Docker, Compose, Nginx, Terraform, monitoring
├── tests/            # e2e, api, integration, security, performance, ai-evals
├── docs/             # Architecture, guides, ADRs, API reference, runbooks
├── scripts/          # Setup, database, testing, deployment scripts
└── .github/          # CI/CD workflows and templates
```

## Getting started

> These steps will work once Phase 0 lands.

**Prerequisites:** Node.js LTS, pnpm, Docker and Docker Compose, FFmpeg.

```bash
git clone <repo-url> meeting-intelligence
cd meeting-intelligence
cp .env.example .env            # fill in local values
pnpm install
docker compose -f infra/compose/compose.dev.yml up -d   # Postgres, Redis, S3-compatible storage
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Common scripts:

```bash
pnpm build       # build all apps and packages
pnpm lint        # lint
pnpm typecheck   # type-check
pnpm test        # unit and integration tests
pnpm test:e2e    # Playwright end-to-end tests
```

## Roadmap

| Phase | Scope |
| --- | --- |
| 0 | Monorepo foundation, tooling, Docker Compose, logging, basic CI |
| 1 | Auth, organizations, employees, teams, projects, RBAC |
| 2 | Meetings, uploads, browser recording, FFmpeg pipeline |
| 3 | Transcription, reports, decisions, task drafts with evidence |
| 4 | Task review, approval, assignment, notifications |
| 5 | GitHub and Jira integrations with two-way sync |
| 6 | Live transcription and browser extension |
| 7 | Calendar, Meet/Zoom/Teams imports, search, automation, analytics |
| 8 | Desktop and mobile apps with offline recording |
| 9 | Production hardening, billing, monitoring, release |

The first milestone is a working end-to-end slice: create organization → add employee → create project → upload audio → transcribe → generate report → extract and approve tasks → create GitHub/Jira issue → sync status.

## Security and privacy

Multi-tenant isolation, secure HTTP-only sessions, explicit recording consent, encrypted integration tokens, verified webhooks, and transcripts treated as untrusted input to AI. The design targets UK/EU GDPR but makes no compliance claims without evidence. See [`SECURITY.md`](SECURITY.md) to report vulnerabilities.

## Contributing

Work happens on feature branches (`feat/…`, `fix/…`, `chore/…`) with [Conventional Commits](https://www.conventionalcommits.org/) and pull requests that must pass CI and review. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

See [`LICENSE`](LICENSE).

## Architecture overview

MeetOps AI is a modular monolith with clear boundaries between domain logic and infrastructure. Domain code never imports Fastify, Prisma, or Redis. Infrastructure adapters live in app- or infra-scoped layers.

High-level architecture:

```text
React Web
    │
Fastify API ── PostgreSQL (pgvector) ── Outbox
    │                               │
    └────────────── Redis / BullMQ ─┘
                     │
  Media Worker · AI Worker · Integration Worker
                     │
             Realtime Event Gateway
```

Foundations:

- TypeScript strict everywhere, pnpm workspaces, Turborepo
- PostgreSQL + Prisma (types only in Phase 0), Redis + BullMQ
- Storage via S3-compatible interface (MinIO in dev)
- Email via provider-independent interface (Gmail SMTP in dev)
- Pluggable AI contracts for LLM and transcription

Browser extension auth ([ADR-005](../15-decisions/ADR-005-extension-auth.md), Amendment 1):

- The extension never uses the web session cookie. A user gesture starts pairing with a single-use nonce. The web app
  (cookie + CSRF) confirms the org and calls `/auth/extension/pair`, and hands a short-lived pairing code to the
  extension over `externally_connectable` messaging (exact `sender.origin` check). The extension exchanges it for opaque
  bearer tokens (`aud=extension`, 15-minute access, rotating refresh, 30-day family cap, server-side SHA-256 hashes only).
- Extension routes are bearer-only with extension-only CORS (no credentials). All other routes are cookie-only.
- The extension imports `@meetops/contracts/types` (types and constants, no TypeBox runtime).

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

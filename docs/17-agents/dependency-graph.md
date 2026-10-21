# Dependency graph

## Package dependencies (current code)

- apps/api → @meetops/logger, @meetops/config
- apps/web → React, Vite, TanStack Router
- apps/worker → @meetops/queue, @meetops/logger, @meetops/config
- @meetops/queue → bullmq, ioredis, @meetops/config, @meetops/logger
- @meetops/storage → aws sdk s3, @meetops/contracts
- @meetops/ai-core → contracts only (no providers yet)
- @meetops/database → prisma client (schema minimal)

## Phase 1 task graph

Solid edges come from the package graph above or repo docs (ADR-002, README). Dashed edges labelled "assumption" are inferred from the plan and have not been confirmed by the agents.

```mermaid
graph TD
  P0[Phase 0 foundation - merged]
  ARCH[ARCH feat/core-contracts]
  DB[DB feat/database-core-schema]
  BE[BE feat/api-auth-orgs]
  AI[AI feat/ai-provider-registry]
  FE[FE feat/web-shell]
  OPS[OPS chore/devops-containers-ci]
  SEC[SEC docs/security-threat-model]
  QA[QA test/qa-harness]
  INT[INT feat/notifications-email]
  MEDIA[MEDIA feat/storage-and-media-core]
  NATIVE[NATIVE feat/extension-scaffold]
  DOC[DOC docs/*]

  P0 --> ARCH
  P0 --> OPS
  ARCH --> AI
  ARCH --> MEDIA
  ARCH -. assumption .-> DB
  ARCH -. assumption .-> INT
  DB -. assumption .-> BE
  ARCH -. assumption .-> BE
  BE -. assumption .-> FE
  BE -. assumption .-> NATIVE
  SEC -. assumption: review .-> BE
  OPS -. assumption .-> QA
  BE -. assumption .-> QA
  P0 --> DOC
```

- ARCH → AI, ARCH → MEDIA: `@meetops/ai-core` and `@meetops/storage` build on `@meetops/contracts` (ADR-002).
- The rest are assumptions: the API needs the schema and contracts, the UI and extension call the API, email (INT) uses the shared contracts and queue, and QA needs CI and an API to test.

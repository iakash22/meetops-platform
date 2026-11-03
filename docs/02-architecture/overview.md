## Architecture overview

Audience: the Architect role and reviewers. This page is a map; details live in the linked docs and ADRs ([index](../15-decisions/README.md)). Phase numbers and open work: [PHASE_STATUS](../PHASE_STATUS.md), [P9 remaining work](../p9/remaining-work.md).

MeetOps AI is a modular monolith ([ADR-001](../15-decisions/ADR-001-modular-monolith.md)) with every external service behind an adapter ([ADR-002](../15-decisions/ADR-002-provider-interfaces.md)). Domain code never imports Fastify, Prisma, or Redis.

```text
Web (React) · Extension (WXT) · Desktop (Tauri) · Mobile (Expo)
    │  HTTPS (cookie+CSRF; bearer for extension/desktop)      ▲ Socket.IO
Fastify API (apps/api) ── PostgreSQL (forced RLS, pgvector) ── outbox_events
    │  BullMQ (Redis)                                          │
apps/worker: media · AI · embeddings · integrations · calendar · notifications
    │                                                          │
S3-compatible storage (MinIO dev / R2|S3 prod)     apps/realtime → clients
```

### Apps

| App              | Role                                                                                                                                                                                 | Docs                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/api`       | Fastify business API, Prisma, CASL                                                                                                                                                   | [04-api](../04-api/README.md)                                                        |
| `apps/web`       | React/Vite/TanStack/Tailwind/shadcn                                                                                                                                                  | [05-web](../05-web)                                                                  |
| `apps/worker`    | BullMQ consumers: media (FFmpeg, clamd scan), AI (STT, summary, action items), embeddings, integrations (task sync, token refresh), calendar sync, notifications, GeoIP/IP retention | [06-worker](../06-worker/README.md)                                                  |
| `apps/realtime`  | Socket.IO gateway with Redis adapter                                                                                                                                                 | [ADR-011](../15-decisions/ADR-011-realtime-auth.md)                                  |
| `apps/extension` | WXT MV3 capture                                                                                                                                                                      | [ADR-005](../15-decisions/ADR-005-extension-auth.md), [extension](../extension)      |
| `apps/desktop`   | Tauri 2 recorder                                                                                                                                                                     | [ADR-012](../15-decisions/ADR-012-desktop-auth.md)                                   |
| `apps/mobile`    | Expo/RN with native Kotlin/Swift modules                                                                                                                                             | [mobile](../mobile), [ADR-015](../15-decisions/ADR-015-mobile-segment-encryption.md) |

### Packages

`contracts` (TypeBox, [ADR-003](../15-decisions/ADR-003-contracts-ownership.md)/[ADR-004](../15-decisions/ADR-004-db-contract-mapping.md)) · `database` (Prisma schema, roles, RLS; [schema](../10-database/schema.md)) · `ai-core` (provider registry, SSRF guard; [ADR-009](../15-decisions/ADR-009-ai-provider-routing-credentials-ssrf.md)) · `storage` · `queue` ([11-queue](../11-queue/README.md)) · `integrations` (GitHub/Jira/calendar adapters; [ADR-007](../15-decisions/ADR-007-integrations-retry-webhook-replay.md), [ADR-008](../15-decisions/ADR-008-oauth-pkce-token-encryption.md)) · `notifications` ([ADR-013](../15-decisions/ADR-013-notifications-architecture.md)) · `session-verifier` · `media-core` · `logger` · `config`.

### Request path

Client → API route (TypeBox-validated contract) → auth (session cookie + CSRF for web; opaque bearer tokens for extension/desktop) → CASL ability check ([RBAC matrix](../12-security/rbac-matrix.md)) → application service → Prisma as `meetops_app` with the transaction scoped to `organizationId`, so forced RLS applies ([ADR-010](../15-decisions/ADR-010-organization-id-tenant-key.md), [tenant isolation](../12-security/multi-tenant-isolation.md)). Side effects are enqueued on BullMQ or written as outbox rows in the same transaction.

### Media and AI pipeline

Upload or recording segments → object storage → media worker (clamd scan per [ADR-018](../15-decisions/ADR-018-upload-malware-scanning.md), FFmpeg assembly/normalisation) → transcription (AssemblyAI default, local Whisper optional; no automatic STT fallback, failures retry via the queue) → summary and action items (Gemini primary) → task drafts for approval → task sync to Jira/GitHub (`TASK_SYNC_ENABLED`) → embeddings into `meeting_embeddings` for semantic search. Consent gates capture ([ADR-020](../15-decisions/ADR-020-recording-consent.md)); retention per [ADR-019](../15-decisions/ADR-019-media-retention.md). Details: [09-ai](../09-ai/README.md), [transcription](../09-ai/transcription.md), [model routing](../09-ai/model-routing.md), [storage and media](../07-storage/storage-and-media.md).

### Outbox

Domain writes that must notify (summary ready, tasks created, new-location login) insert an `OutboxEvent` in the same transaction. The notifications worker claims rows through the `meetops_relay` `SECURITY DEFINER` functions and fans out over BullMQ / Socket.IO ([ADR-013](../15-decisions/ADR-013-notifications-architecture.md), [schema](../10-database/schema.md)).

### Storage

PostgreSQL 16 + pgvector (roles `meetops_app`, `meetops_migrator`, optional `meetops_relay`); Redis for BullMQ and the Socket.IO adapter; S3-compatible objects (MinIO in dev, R2/S3 in prod) via `packages/storage`. Keys and secrets: [secrets policy](../12-security/secrets-policy.md), KMS still open ([ADR-016](../15-decisions/ADR-016-secret-manager-kms.md)).

### Known gaps

- `TranscriptSegment.embedding` (`vector(1536)`) is redundant: `MeetingEmbedding` (`meeting_embeddings`) already stores one row per transcript segment (and per summary report) and model, which is what search reads. No migration now; it is a candidate for removal later.
- Search quality: `meeting_embeddings` has no ANN index, so similarity queries scan within the org. This is deliberate: [`20261031050000_meeting_embeddings/migration.sql`](../../packages/database/prisma/migrations/20261031050000_meeting_embeddings/migration.sql) avoids a global HNSW/IVFFlat index because an index-ordered scan would rank across all tenants and only then filter by `org_id`. The next step is a tenant-scoped ANN approach, such as per-org partial indexes (`WHERE org_id = …`, per model) for large orgs, not a global index.
- No automatic STT fallback: a failed transcription is retried through the BullMQ queue (retry/backoff), not switched to another provider, and never to a paid one. `packages/ai-core/src/contracts.ts` keeps a `TODO(contracts)` for a dedicated STT fallback type (`FallbackPolicy.sttProviderIds`); job-level LLM fallbacks are ignored for transcription.
- Outbound auth mail still runs through the API's inline queue in places; the production BullMQ mail path is incomplete (see [PHASE_STATUS](../PHASE_STATUS.md)).
- Native Kotlin/Swift/Tauri code has not been compiled or run on devices; bundle ids are placeholders.
- KMS (ADR-016), billing (ADR-017), MFA/SSO (ADR-021) undecided; ADR-006–013 still Proposed.
- Remote CI unavailable; `pnpm local-gates` is the gate ([local gates](../local-gates.md)).

### Browser extension auth ([ADR-005](../15-decisions/ADR-005-extension-auth.md), Amendment 1)

- The extension never uses the web session cookie. A user gesture starts pairing with a single-use nonce. The web app
  (cookie + CSRF) confirms the org and calls `/auth/extension/pair`, and hands a short-lived pairing code to the
  extension over `externally_connectable` messaging (exact `sender.origin` check). The extension exchanges it for opaque
  bearer tokens (`aud=extension`, 15-minute access, rotating refresh, 30-day family cap, server-side SHA-256 hashes only).
- Extension routes are bearer-only with extension-only CORS (no credentials). All other routes are cookie-only.
- The extension imports `@meetops/contracts/types` (types and constants, no TypeBox runtime).

# Phase 7 notes: calendar and meeting search

## Calendar (PR 1)

- **Adapter** (`packages/integrations/src/calendar.ts`): `CalendarProvider` interface (begin/complete authorization,
  refresh, list events). `GoogleCalendarProvider` is the first implementation. Endpoints are compiled-in constants
  (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com/calendar/v3`); no request or setting can
  supply a base URL. Read-only scopes only (`calendar.events.readonly`, `calendar.calendarlist.readonly`).
- **OAuth**: same model as ADR-008: PKCE S256, single-use state bound to org + user + redirect URI, signed by the
  integrations runtime key, redirect URI allowlist, no retries or redirects on token calls, sanitized errors.
- **Storage**: `calendar_connections` (per user per org), forced RLS (ADR-010 setting only), tokens stored only as
  `TokenCipher` envelopes (AAD = org + connection id), soft revoke wipes tokens (CHECK), no DELETE for the app role.
- **API** (`apps/api/src/modules/calendar`): `GET /orgs/:org/calendar/providers`, `POST .../calendar/connect`,
  `GET /calendar/:provider/callback`, `GET .../calendar/events?from&to` (max 62 days, live from the provider,
  `private, no-store`), `DELETE .../calendar/connections/:id`. Self-service: every member can manage only their own
  connection.
- **Config**: dev reads `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` via
  `integrationsRuntimeFromEnv`; production injects `integrationsRuntime.googleCalendar` from the secret manager like
  Jira/GitHub. Without it, connect answers 503 and the providers list shows `configured: false`.
- **Not in this PR**: background sync worker (BullMQ) and linking events to meetings; Outlook/Microsoft adapter.

## Calendar background sync (P7, off by default)

- **Storage** (`20261031020000_calendar_events`): `calendar_events` (per connection, unique provider event id, forced
  RLS ADR-010, composite tenant FK to `calendar_connections`, https-only links, no DELETE for the app role: events
  that vanish are soft-cancelled). `calendar_connections` gains a sync cursor (`synced_from/to`, `last_synced_at`,
  `sync_failures`, `next_sync_at`). The cross-tenant sweep reads ids only through the SECURITY DEFINER
  `calendar_connections_due_for_sync()` (SELECT-only `definer_calendar_sync_select` policy for meetops_migrator).
- **Repository** (`@meetops/database` `createCalendarSyncRepository`): due list, token read/refresh with the same
  per-field AAD as the API repository, atomic `applySync` (upsert + cancel-missing only when the provider list was
  complete + cursor advance), `recordFailure`, `markError`, and the read side (`coverage`, `listEvents`).
- **Worker** (`apps/worker/src/calendar/sync.ts`): `runCalendarSyncSweep` / `startCalendarSyncScheduler`, modelled
  on the token-refresh sweep. Rolling window `[now - 1d, now + 30d)` (capped at 62 days), refresh-before-use,
  permanent auth failures (401/403/invalid_grant) mark the connection `error`, transient ones back off
  exponentially from the interval (cap 6h). Logs ids, counts and error codes only. `loadCalendarSyncEnv` reads
  `CALENDAR_SYNC_*`. Not yet started from `apps/worker/src/index.ts`: like the token-refresh sweep, it needs the
  production token cipher and Google client from the secret manager (ADR-008) injected into the worker.
- **API** read-through: with `CALENDAR_SYNC_ENABLED=true` and a database, `GET .../calendar/events` serves stored
  events for a connection when its last sync fully covers the requested window and is under 30 minutes old;
  otherwise (or on any store error) it reads live from the provider as before.
- **Review fixes (#324)**: backoff is jittered to 80-120% and the healthy cadence to 100-110%; Google 403
  `rateLimitExceeded` / `userRateLimitExceeded` surface as `rate_limited` and back off instead of marking the
  connection `error`; disconnect purges the connection's cached `calendar_events` in the same transaction through the
  SECURITY DEFINER `calendar_events_purge_for_connection()` (org-context checked, revoked connections only).

## Calendar event ↔ meeting links (P7)

- **Storage** (`20261031040000_calendar_event_links`): `calendar_event_links` keyed by (org, connection, provider event
  id), so links work for live-read and worker-synced events alike. Forced RLS (ADR-010), composite tenant FKs to
  `calendar_connections` and `meetings` (a link can't cross organizations), cascade on hard delete. Unlink is a real
  DELETE; disconnecting the calendar drops the connection's links.
- **API**: `PUT|DELETE /orgs/:org/calendar/connections/:connectionId/events/:eventId/link` (body `{ meetingId }`).
  Only the owner of the connection, and only roles that may create meetings (viewers get 403). Unknown, other-org and
  soft-deleted meetings give the same 404; another user's or a revoked connection gives 404. Audited as
  `calendar.link` / `calendar.unlink` (ids only).
- **Auto-match** (read-only, never stored): `GET .../calendar/events` adds `meetingId` for linked events and, for
  unlinked events with a conference URL, `suggestedMeetingId` when exactly one live meeting of the org has the external
  call id that meetings/resolve derives from that URL. No time-window guessing and no automatic writes: a human
  confirms the link. Links to soft-deleted meetings are hidden.
- **Not in this PR**: web UI for link/suggest, linking from the meeting side (list events of a meeting), worker-side
  auto-linking on sync.

## Semantic search (P7, PR 1 of 2, off by default)

- **Flag**: `SEMANTIC_SEARCH_ENABLED=true` registers `GET /orgs/:org/search/semantic`; otherwise the route does not
  exist (404). With the flag on but no query embedder injected, it answers 503. No provider is called in tests.
- **Storage** (`20261031050000_meeting_embeddings`): one `vector(1536)` per transcript segment or summary report and
  model, plus a content hash. No text is copied: search joins back to the source, so deleting the source or meeting
  cascades. Forced RLS (ADR-010), composite tenant FKs.
- **Query** (`apps/api/src/modules/search/semantic.ts`, `SEMANTIC_SEARCH_SQL`): org filter first, inside a
  `MATERIALIZED` CTE (`WHERE e.org_id = $1 AND e.model = $2`, joined to live same-org sources), then ordering by
  cosine distance over those rows only. No HNSW/IVFFlat index on purpose (an ANN index scan ranks across tenants and
  post-filters); exact scan per org is fine at current sizes. All values are bound parameters.
- **PR 2 (follow-up)**: worker embedding pipeline (segments + summaries -> ai-core `Embeddings` capability, hash-based
  skip, batch caps, usage/idempotency through the AI executor) and the API's production `QueryEmbedder` from ai-core.
  Embedding customer text needs an approved, non-free-tier provider (the free Gemini tier must not process customer
  data).

## Semantic search PR 2: embedding pipeline (off by default)

- **ai-core**: new `embeddings` feature (capability `embeddings`). No default provider declares it, so embedding is
  unconfigured until an approved provider is routed for the feature. `embedWithExecutor` caps batches (32 inputs,
  8000 chars each), validates 1536-dim finite vectors and runs through the AIExecutor (policy, quotas, usage,
  idempotency). Results carry `provider/model`, stored with each vector.
- **Worker** (`apps/worker/src/embeddings`): `runMeetingEmbeddings` embeds a meeting's current-revision transcript
  segments and live summaries, skipping sources whose content hash is already stored; idempotency key =
  meeting + batch content hashes. Unconfigured provider: logged once, job completes, nothing stored. Transient errors
  retry through BullMQ. `registerEmbeddingsWorker` (SEMANTIC_EMBEDDINGS_ENABLED, default false) returns the same
  `{ registered, close }` handle as the other workers; it is **not** called from main() yet (#333 rewrites main()).
  `enqueueMeetingEmbeddings` uses a deterministic job id per meeting.
- **API**: `createExecutorQueryEmbedder` (production query embedder over the same executor feature); the search
  module uses it when the host injects `embeddingsExecutor`. Without a configured provider the route stays 503.

## Meeting analytics (P7, read-only)

- **API**: `GET /orgs/:org/analytics/meetings?from&to&bucket` (`ANALYTICS_PATHS.meetings`, contracts
  `MeetingAnalyticsQuery` / `MeetingAnalytics`). Window `[from, to)` on `createdAt`, `to > from`, at most
  `MAX_ANALYTICS_RANGE_DAYS` (366) → else 400 `VALIDATION_FAILED`; `bucket` = `day|week|month` (UTC, ISO weeks),
  default `day`. `private, no-store`.
- **Access**: same tenancy gate as meetings (session 401 → other org 404 → CASL `read Meeting`), so viewers and up.
  No feature flag (the docs do not ask for one).
- **Data**: aggregates only (counts by source, status and period; duration measured/total/average over meetings with
  `durationSec`); no ids, titles or people. Soft-deleted meetings are excluded. One `withOrganizationContext`
  transaction (forced RLS) plus an explicit `org_id` filter; typed Prisma `groupBy`/`aggregate`, and one tagged
  `$queryRaw` (bound parameters) for `date_trunc` periods. No writes, no new tables or views.

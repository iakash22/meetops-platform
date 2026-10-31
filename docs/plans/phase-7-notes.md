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

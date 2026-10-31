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

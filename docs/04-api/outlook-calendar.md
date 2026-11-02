# Outlook Calendar (Microsoft Graph) setup

`OutlookCalendarProvider` (`packages/integrations/src/calendar-outlook.ts`) implements the same
`CalendarProvider` contract as Google. No Microsoft credentials live in the repo; configure via env.

## Azure / Microsoft Entra app registration

1. Entra admin center -> App registrations -> New registration.
   - Supported account types: pick to match `OUTLOOK_CALENDAR_TENANT`
     (`common` = any org + personal accounts, `organizations`, `consumers`, or single-tenant GUID).
   - Redirect URI, platform **Web**: `${INTEGRATIONS_API_ORIGIN}/calendar/outlook/callback`
     (one per environment; must match exactly).
2. Certificates & secrets -> New client secret. Store it in the secret manager as
   `OUTLOOK_CALENDAR_CLIENT_SECRET`; set `OUTLOOK_CALENDAR_CLIENT_ID` to the Application (client) ID.
   Secrets expire (max 24 months): add a rotation reminder.
3. API permissions -> Microsoft Graph -> **Delegated**: `Calendars.Read`, `User.Read`, `offline_access`
   (plus default `openid`/`profile`/`email`). Nothing else: the adapter rejects tokens with extra scopes
   (`excess_scope`). Grant admin consent for org tenants that block user consent.
4. Both API and worker need the same three env vars (worker refreshes tokens during sync).

## Behaviour notes

- PKCE + signed single-use state (`outlook-calendar` binding), like Google.
- Refresh tokens rotate on every refresh; the new one is persisted through the existing fenced lease save.
- `listEvents` uses `/me/calendarView` (recurrences expanded) with `Prefer: outlook.timezone="UTC"`.
- `listEventsDelta` (`/me/calendarView/delta`, deltaLink cursor) exists and is unit-tested but is not
  wired into the sync worker yet; an expired cursor maps to `sync_state_expired`.
- Errors: 429 / `TooManyRequests` / `ApplicationThrottled` -> `rate_limited` (retryable); token-endpoint
  `invalid_grant` and 401/403 -> reconnect needed, same as Google.
- `revoke` is a no-op: Microsoft has no per-token revocation endpoint. Disconnect deletes stored tokens;
  users remove the grant at https://myapps.microsoft.com.

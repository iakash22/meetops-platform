# ADR-013: Notifications architecture (outbox + BullMQ fan-out, multi-channel)

- Status: **Accepted** (2026-10-27, on the project owner's instruction; first implementation: `feat/notifications`)
- Date: 2026-10-27
- Related: ADR-001, ADR-002, ADR-004, ADR-007, ADR-008, ADR-010, ADR-011, ADR-012; plan [`docs/plans/notifications-architecture.md`](../plans/notifications-architecture.md)

## Context

Only email exists (`packages/notifications`), and it is not yet wired. There is no in-app feed, no push, no preferences model. `OutboxEvent`, BullMQ (`packages/queue`) and Socket.IO with a Redis adapter (`apps/realtime`) already exist. Every client (web, WXT extension, Expo mobile, Tauri desktop) needs notifications, and P1/P4 depend on preferences, unsubscribe and task notifications.

## Decision

1. Domain code writes a typed event to `OutboxEvent` in the same transaction; it never calls a channel directly.
2. A worker relay (`FOR UPDATE SKIP LOCKED`) publishes outbox rows to BullMQ; a fan-out worker resolves recipients (re-checking org membership and subject access), applies preferences, quiet hours and digests, writes `Notification` + `NotificationDelivery`, and enqueues one job per channel on separate queues (`notify.inapp|webpush|mobile|email|digest`).
3. Idempotency: `jobId = eventId / deliveryId`; `Notification` unique on `(org, user, dedupeKey)`. Retries with backoff + jitter; permanent errors are unrecoverable; failed jobs form the DLQ with a replay script.
4. In-app feed in Postgres is the source of truth; realtime via Socket.IO `user:{org}:{user}` rooms; push and email only point to it with minimal, ids-only payloads.
5. Channels: Web Push (VAPID) for web and the MV3 extension; Expo Push for mobile; Tauri notification plugin for desktop while running; email via SMTP or Resend. Each provider sits behind an ADR-002 interface.
6. Self-hosted; no Novu/Knock/OneSignal in v1.
7. New org-scoped Prisma models (ADR-010): `Notification`, `NotificationDelivery`, `NotificationPreference`, `NotificationSettings`; user-scoped `PushDevice` with tokens encrypted (ADR-008) and revoked with the session (ADR-011).

8. Security requirements (security review C, 2026-10-27), binding for every implementation:
   - **Push targets:** Web Push endpoints must be HTTPS on the default port at an exact allowlisted push-service host (`WEB_PUSH_ALLOWED_HOSTS`: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`); no IP literals or credentials. Before each send the worker re-checks with the ADR-009 SSRF guard (`assertSafeEndpoint`: DNS resolution, private/reserved address rejection, pinned address) and does not follow redirects. Expo tokens must match `ExponentPushToken[...]`, and the worker calls only the fixed Expo push API URL. No arbitrary endpoints.
   - **Tenancy:** forced RLS on every notification table (ADR-010 setting, fail-closed) plus a restrictive `owner_only` policy on user-owned rows when `app.current_user_id` is set. CASL checks on every route (own rows only, every role). Every BullMQ job carries `organizationId`, and the worker enters `withOrganizationContext` per job; no BYPASSRLS role.
   - **Push content:** generic title and body only (`GENERIC_PUSH_TITLE` / `GENERIC_PUSH_BODY`) plus the notification id; no org name, titles or content on a lock screen. Removing a membership deletes that user's push devices in that org.
   - **Realtime:** the `organizations:{org}:users:{user}` room is joined by the server on connect from the verified ADR-011 identity only. There is no client join event. Revocation disconnects the socket, which leaves all rooms.
   - **Unsubscribe:** `GET /notifications/unsubscribe?token=` renders a confirm page and changes nothing (link scanners). `POST` applies it, and RFC 8058 one-click is accepted. Tokens are HMAC-signed, expiring and scoped to user + org + category.
   - **Bull Board** (if deployed) is restricted to platform admins on the internal network. It is never exposed to org admins, because job data spans tenants.
   - **Email:** Gmail SMTP is the development default only. `loadEmailConfig` refuses `smtp.gmail.com` in production, and there is no automatic fallback to any provider.

## Consequences

- One pipeline, isolated channel failures, horizontal scaling by adding worker replicas, no vendor cost or data egress.
  − We own preferences/digest logic and UI; more tables and retention jobs; mobile push needs EAS/FCM/APNs credentials; extension needs the `notifications` permission.

## Alternatives considered

Direct calls from API handlers (dual-write, no retries) — rejected. Novu self-hosted — heavier ops and separate tenancy model; revisit later. SaaS (Knock, Courier, OneSignal) — cost and data residency. Direct FCM/APNs — more work than Expo Push for an Expo app.

## Implementation notes (2026-10-27)

- `PushDevice` is stored as `push_device_tokens` and is **org-scoped** (`org_id` + `user_id`) so it sits under the same forced tenant RLS as every other table; a device used in two orgs registers once per org. Revocation with the session (ADR-011) is still to be wired.
- Delivery rows are per attempt (`notification_delivery_attempts`), keyed by `(org, delivery_key, attempt)` where `delivery_key` is the BullMQ `jobId`.
- `NotificationSettings` (quiet hours, digest cadence) is deferred to the digest follow-up.
- Email stays on SMTP (Nodemailer, Gmail in dev); there is no automatic fallback to a paid provider.

## Sign-off

| Role         | Name    | Date | Result |
| ------------ | ------- | ---- | ------ |
| Owner        | Shubham |      |        |
| Architecture |         |      |        |
| Security     |         |      |        |

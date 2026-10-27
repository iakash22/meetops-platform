# ADR-014: GeoIP location for sessions and new-location sign-in alerts

- Status: **Proposed - needs owner, Architecture and Security sign-off**
- Date: 2026-10-28
- Related: ADR-002 (provider interfaces), ADR-008 (secrets), ADR-010 (tenant key / RLS), ADR-011 (session auth), ADR-013 (notifications)

## Context

The sessions page (`GET /auth/sessions`, `SessionSummary`) shows device and IP but not where a sign-in came from, and there is no alert when an account is used from a new place. We want coarse location without sending user IPs to a third party on every request, without API keys, and without paid providers.

## Decision

### Data source and provider

1. Use **DB-IP "IP to City Lite"** (CC BY 4.0, free, no account or key), downloaded as an `.mmdb` file and read **locally** with the `maxmind` npm package. No per-request external API call; no paid provider; no automatic fallback to any other provider.
2. Lookups go through a provider interface (ADR-002), e.g. `GeoIpProvider.lookup(ip): GeoResult | null`, with `GeoResult = { city, region, country, countryCode }`. The DB-IP reader is one implementation; MaxMind GeoLite2 (same mmdb format, needs a licence key) can drop in later by configuration only. A `null` provider is used when no database is present (lookups return null; the API still works).
3. **Attribution** (required by CC BY 4.0): "IP geolocation by [DB-IP](https://db-ip.com)", shown on the sessions UI near location values and in `docs/` (third-party notices).

### Client IP

4. The API already parses `TRUST_PROXY` (`apps/api/src/shared/trust-proxy.ts`) into Fastify `trustProxy`. Default (unset/`false`) is no trust, so `request.ip` is the socket peer; `true` and `/0` are rejected. **In production, `TRUST_PROXY` must be the CIDR/IP allowlist form** (`TRUST_PROXY=10.0.0.0/8,...`, referred to as the TRUST_PROXY_CIDRS form). The hop-count form (`TRUST_PROXY=N`) trusts a forged left-most `X-Forwarded-For` whenever an extra hop exists, so startup fails with a hop count when `NODE_ENV=production`; hop counts stay allowed in dev/test only. GeoIP lookups and new-location alerts are skipped (geo null, no alert) unless the client IP came from the socket peer or from an allowlisted proxy.
5. `CF-Connecting-IP` is honoured only when `BEHIND_CLOUDFLARE=true` **and** the socket peer (or the allowlisted proxy's peer) is inside Cloudflare's published ranges. The ranges ship as a pinned, reviewed config file refreshed from `https://www.cloudflare.com/ips-v4` and `/ips-v6` by a reviewed PR (not fetched at runtime); a stale list fails closed (header ignored).
6. Raw `X-Forwarded-For` from the internet is never trusted.

### Lookup and storage

7. Lookup happens at session creation and when a session's IP changes (on refresh/revalidation), not on every request.
8. `Session` stores nullable `geoCity`, `geoRegion`, `geoCountry`, `geoCountryCode` and `geoApproximate` (`true` whenever a value comes from GeoIP). Private, reserved, loopback or unknown IPs give `null` for all fields. No latitude/longitude or accuracy radius is stored.
9. The same fields are written on auth audit events (sign-in, refresh with IP change, revoke).
10. `SessionSummary` (contracts `0.14.0`) exposes these five fields with exactly those names, optional and not nullable (absent = unknown). Location text rejects control/CR-LF, bidi/invisible chars, `<`, `>` and IP-looking strings; ASCII `'` and `&` are allowed, so every renderer escapes.
11. Tables keep forced RLS (ADR-010); new columns add no new policy surface.

### New-location alert

12. On sign-in, compare the resolved `(countryCode, region)` with the user's previous sessions and auth audit history. A new country gives `reason: 'new_country'`; a known country but new region/state gives `reason: 'new_region'`. The first ever sign-in and null geo do not alert.
13. The auth transaction writes an outbox event `auth.new_location_signin` with payload `{ sessionId, city, region, country, countryCode, reason }` (ADR-013). Notifications delivers it **in-app and by email**, with a link to revoke the session. **No IP address appears in the email** or payload.
    - The revoke link opens the signed-in sessions page (`/settings/sessions`); revoking requires an authenticated session plus CSRF (and step-up re-auth if the session is older than the step-up window). There is no one-click token that revokes or signs in, and the link carries no sessionId (the page highlights recent sessions).
    - Alerts are deduplicated per user and `(countryCode, region)` for 24 hours and rate-limited (at most 3 per user per 24 hours) to absorb VPN flapping; the in-app item still lists every new session.
    - Email, web and push renderers escape the location text (contracts allow ASCII `'` and `&`).

### Privacy

14. A daily retention job sets raw `ip_address` to `NULL` after **30 days** on every table that stores one: `sessions`, `audit_events` and `password_resets` (and any later table with an IP column must join the job). It keeps the coarse geo fields. It runs in batches, is idempotent, uses server time (`now()` in SQL) and logs counts only.
    - `audit_events` is append-only (`20261022032000_audit_append_only`, `20261022041000_audit_hatch_session_user`). The **only** exception added is: an `UPDATE` where `ip_address` goes from non-null to `NULL` and every other column is unchanged (`(to_jsonb(NEW) - 'ip_address') = (to_jsonb(OLD) - 'ip_address')`), only on rows with `created_at < now() - interval '30 days'`, and only when `current_user` is `meetops_migrator`, i.e. inside the dedicated `SECURITY DEFINER` function `redact_expired_ip_addresses` (owned by `meetops_migrator`, `SET search_path = public, pg_temp`, `REVOKE EXECUTE ... FROM PUBLIC`, `GRANT EXECUTE` to `meetops_app` only). The function refuses a window shorter than 30 days.
    - `DELETE` and `TRUNCATE` stay refused; the `actor_id` FK rule and the session_user maintenance hatch are unchanged. `meetops_app` gets no `UPDATE` grant on `audit_events`, FORCE RLS stays on (no `NO FORCE` window), and the only new policies are `UPDATE`/`SELECT` policies scoped `TO meetops_migrator`.
    - Outbox rows, notification payloads, job data and logs never contain an IP (contracts reject IP-looking strings), so they need no IP retention.
15. Full IPs are never logged at `info` or above. When an IP is needed in logs it is **truncated** (IPv4 to /24, IPv6 to /48); no unkeyed hashes (an IPv4 hash is brute-forceable). Pino request serializers redact `remoteAddress`, `x-forwarded-for`, `cf-connecting-ip` and `x-real-ip` at `info`; GeoIP lookup and updater errors log only the error name, never the IP.
16. **Retention of the coarse geo fields:** session geo is deleted with the session row (expired/revoked sessions are purged by a session cleanup job, at most 90 days after expiry; added with the retention job if not already present); audit geo follows the audit-event retention period. Geo is never copied elsewhere except the alert notification (`geoCity`, `geoCountry`), which follows notification retention.
17. **Lawful basis and data-subject rights:** processing is based on **legitimate interest (account security and fraud prevention)**, with a short legitimate-interest assessment (LIA) filed with the privacy owner before rollout; the privacy notice and the record of processing activities (RoPA) are updated to name IP-based approximate location, its purpose, DB-IP as data source (local lookup, no data sent to DB-IP) and the retention above. Geo fields are included in the user's data export (sessions and their own auth events) and removed on account erasure along with sessions; audit rows kept for legal/security reasons keep only coarse geo (raw IP already nulled after 30 days, actor nulled on user deletion).

### Operations

18. A **monthly BullMQ repeatable job** downloads the mmdb over HTTPS from an allowlisted host (`download.db-ip.com`), with **redirects disabled** (or the final host re-checked against the allowlist) and a **maximum download size enforced while streaming** (abort before writing past the limit), then verifies it: size bounds, mmdb format (opens with `maxmind`, metadata database type and build date newer than the current file), and test lookups of a fixed set of known public IPs. DB-IP Lite publishes no checksum or signature, so integrity rests on HTTPS to the allowlisted host plus these checks; a large change in the test-lookup results (e.g. more than half differ) blocks the swap and alerts. Only then is it swapped in **atomically** (write to temp, `rename`), and the previous good file is kept for rollback. Readers reload on swap. Failure keeps the current file and logs/alerts.
19. Tests use a small fixed test mmdb fixture (generated with an mmdb writer as a dev dependency, or vendored with documented provenance), never the real database.

## Consequences

- Location for sessions and alerts with no per-request third-party calls, no keys and no cost.
- City-level accuracy is approximate (flagged by `geoApproximate`); VPNs and mobile carriers produce false positives/negatives for alerts.
- We must ship attribution, run the updater, and keep the mmdb (~100 MB) on worker/API volumes.
- Retention reduces raw IP exposure but limits forensic look-back to 30 days.
- One narrow, tested exception to audit append-only (IP to NULL after 30 days, definer function only).
- Production deploys must configure `TRUST_PROXY` as a CIDR allowlist; hop counts fail startup.

## Alternatives considered

- Per-request external APIs (ipapi, ipinfo): leak IPs to a third party, rate limits, often paid - rejected.
- MaxMind GeoLite2 now: needs account + licence key - kept as a drop-in later.
- Storing lat/long: unnecessary precision for the UI, privacy cost - rejected.

## Sign-off

| Role         | Name | Date | Result |
| ------------ | ---- | ---- | ------ |
| Owner        |      |      |        |
| Architecture |      |      |        |
| Security     |      |      |        |

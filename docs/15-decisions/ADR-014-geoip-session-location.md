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

4. Fastify `trustProxy` is set only to an explicit allowlist of known proxy IPs/CIDRs from env (e.g. `TRUST_PROXY_CIDRS`); default is no trust, so `request.ip` is the socket peer.
5. `CF-Connecting-IP` is honoured only when an env flag (e.g. `BEHIND_CLOUDFLARE=true`) is set **and** the socket peer is inside Cloudflare's published IP ranges (shipped as config, refreshable).
6. Raw `X-Forwarded-For` from the internet is never trusted.

### Lookup and storage

7. Lookup happens at session creation and when a session's IP changes (on refresh/revalidation), not on every request.
8. `Session` stores nullable `geoCity`, `geoRegion`, `geoCountry`, `geoCountryCode` and `geoApproximate` (`true` whenever a value comes from GeoIP). Private, reserved, loopback or unknown IPs give `null` for all fields. No latitude/longitude or accuracy radius is stored.
9. The same fields are written on auth audit events (sign-in, refresh with IP change, revoke).
10. `SessionSummary` (contracts `0.14.0`) exposes these five fields with exactly those names.
11. Tables keep forced RLS (ADR-010); new columns add no new policy surface.

### New-location alert

12. On sign-in, compare the resolved `(countryCode, region)` with the user's previous sessions and auth audit history. A new country gives `reason: 'new_country'`; a known country but new region/state gives `reason: 'new_region'`. The first ever sign-in and null geo do not alert.
13. The auth transaction writes an outbox event `auth.new_location_signin` with payload `{ sessionId, city, region, country, countryCode, reason }` (ADR-013). Notifications delivers it **in-app and by email**, with a link to revoke the session. **No IP address appears in the email** or payload.

### Privacy

14. A daily retention job sets raw `ipAddress` to `null` on sessions and audit rows older than **30 days** and keeps the coarse geo fields.
15. Full IPs are never logged at `info` level or above (debug only, or truncated/hashed).

### Operations

16. A **monthly BullMQ repeatable job** downloads the mmdb over HTTPS from an allowlisted host (`download.db-ip.com`), then verifies it: size bounds, mmdb format (opens with `maxmind`), checksum where published, and a test lookup of a known public IP. Only then is it swapped in **atomically** (write to temp, `rename`), and the previous good file is kept for rollback. Readers reload on swap. Failure keeps the current file and logs/alerts.
17. Tests use a small fixed test mmdb fixture (generated with an mmdb writer as a dev dependency, or vendored with documented provenance), never the real database.

## Consequences

- Location for sessions and alerts with no per-request third-party calls, no keys and no cost.
- City-level accuracy is approximate (flagged by `geoApproximate`); VPNs and mobile carriers produce false positives/negatives for alerts.
- We must ship attribution, run the updater, and keep the mmdb (~100 MB) on worker/API volumes.
- Retention reduces raw IP exposure but limits forensic look-back to 30 days.

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

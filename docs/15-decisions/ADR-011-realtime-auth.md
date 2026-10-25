# ADR-011: Realtime session auth, meeting access and org revalidation

- Status: **Proposed - needs Architecture and Security sign-off** (see [Sign-off](#sign-off))
- Date: 2026-10-25
- Owners: Architecture Agent (ARCH) and Security Agent (SEC), co-owners; Media & Realtime (MR) and Backend (BE) implement
- Amends: [ADR-005](./ADR-005-extension-auth.md) A1.3.1 (adds the realtime handshake as a bearer surface)
- Related: [ADR-004](./ADR-004-db-contract-mapping.md) (tenancy: other-org ids are NOT_FOUND),
  [ADR-010](./ADR-010-organization-id-tenant-key.md) (`runWithOrganizationContext`, `app.current_organization_id`),
  threat-model gaps G1 and G2, test cases XT-23 and XT-30

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.

## Context

`apps/realtime` (Fastify + Socket.IO, optional Redis adapter) already enforces an exact `Origin` allowlist at the HTTP
handshake and has two hooks, `verifySession` and `canAccessMeeting`. The production entrypoint wires them to
`denyAllVerifier` and `() => false` (G1), so realtime is unusable rather than unsafe. When it is wired up:

- **G1:** there is no shared way to verify a web session cookie or an extension bearer token outside `apps/api`. The
  existing `SessionVerifier` lives in `apps/api/src/modules/auth/application/session-verifier.ts` and depends on API
  internals (`AuthService`, repositories), and its `canAccessMeeting` is a fail-closed TODO.
- **G2:** `organizationId` is fixed on the socket at connect and the socket joins `organizations:{organizationId}`.
  Nothing re-checks it when the session is revoked, the user switches org (the API rotates the session), the user is
  removed from the org, or their role changes. A stale socket keeps receiving the old org's events.

Facts this decision relies on:

- Web sessions are opaque random tokens in the `__Host-meetops_sid` cookie (`meetops_sid` only when
  `NODE_ENV=development`). The `sessions` table stores only `token_hash` (SHA-256 hex), with `active_org_id`, a sliding
  idle expiry, `absolute_expires_at` and `revoked_at`. Org switch and org create revoke the old session and issue a new one.
- Extension access tokens are opaque, stored only as SHA-256 hashes, `aud=extension`, org-scoped, 15-minute TTL, with
  scopes `meetings:resolve` and `recordings:write` (ADR-005 A1.2).
- `memberships` and `meetings` are tenant tables under forced RLS keyed on `app.current_organization_id` (ADR-010).

## Decision

### 1. Credentials at the handshake (amends ADR-005)

1. **Web** clients authenticate with the session cookie sent on the Socket.IO handshake request. Because `__Host-`
   cookies are host-only, production MUST serve realtime on the API's host under a path (for example
   `https://app.example.com/socket.io` via the reverse proxy), not on a separate subdomain. A web-origin handshake MUST
   NOT carry `auth.token`; if it does, the handshake is rejected.
2. **Extension and mobile** clients send a bearer token in the Socket.IO `auth.token` handshake field, never in the query
   string, URL or a header other than the handshake payload. A bearer handshake that also carries a session cookie
   MUST be rejected (mirrors ADR-005 A1.3.1). Tokens in `handshake.query` MUST be rejected and never logged.
3. **Extension bearer rules:** `aud=extension` and scope `recordings:write`. The `Origin` MUST be an allowlisted
   `chrome-extension://<id>` (a new `REALTIME_EXTENSION_IDS` setting; today `normalizeOrigin` accepts only http(s)
   origins, so MR-1 extends the allowlist). Bearer sockets MUST NOT auto-join `organizations:{organizationId}`; they may
   only `meeting:join` meetings in the token's org (section 4). This keeps the extension's blast radius at ADR-005's level.
4. **Mobile** bearer tokens are accepted only once a mobile token type with its own audience is defined in a later ADR.
   Until then the verifier MUST return `null` for any non-`extension` audience.
5. Any verification failure MUST give the same generic `unauthorized` connect error. It does not distinguish unknown,
   expired, revoked or wrong-org credentials, and the token or cookie value MUST NOT be logged (`REDACT_KEYS`).

### 2. Shared verifier package: `@meetops/session-verifier`

1. BE-6 creates **`packages/session-verifier`**, published in the workspace as **`@meetops/session-verifier`**. Both
   `apps/api` and `apps/realtime` depend on it. `apps/realtime` MUST NOT import from `apps/api`, and the package MUST NOT
   import from any app.
2. API (minimum; BE-6 may add fields):

   ```ts
   type VerifyInput = { cookie: string } | { bearer: string };
   type VerifiedSession = {
     userId: string;
     organizationId: string; // active org; only returned while the membership is live
     sessionId: string; // sessions.id, or the extension token family id for bearers
     credential: 'session' | 'extension';
     role: Role; // the membership role in organizationId
     scopes?: readonly string[]; // bearer only
     expiresAt: Date; // the earliest of idle expiry, absolute expiry and token expiry
   };
   function verifySession(input: VerifyInput): Promise<VerifiedSession | null>;
   ```

3. It reads `sessions` (and the extension token store from ADR-005) and `memberships` through `@meetops/database`. The
   membership read MUST run under `runWithOrganizationContext(organizationId, …)`. A session with no active org, or whose
   membership is missing or soft-deleted, returns `null`. Expired, idle, revoked and wrong-audience credentials return `null`.
4. The package owns the token hashing function (SHA-256 hex of the opaque token). `apps/api`'s `CryptoTokenService.hash`
   MUST produce the same value, and a test in the package guards the shared vector.
5. Realtime verification is **read-only**: it does not slide `last_seen_at`. Only HTTP activity keeps a session alive,
   so an idle tab with an open socket cannot extend a session forever.
6. The current `apps/api` `SessionVerifier` class is superseded and removed (or reduced to a thin adapter) by BE-6.

### 3. Revocation channel: `meetops:auth:revocations`

1. The API MUST publish to the Redis pub/sub channel **`meetops:auth:revocations`** after the change commits, on:
   logout, logout-all, org switch (old session), member removal, role change, and invitation revoke. Password change or
   reset and extension token revocation (ADR-005 A1.6) publish too.
2. The message is JSON and carries identifiers only, never tokens or token hashes:

   ```json
   {
     "v": 1,
     "kind": "session",
     "sessionId": "…",
     "userId": "…",
     "organizationId": "…",
     "reason": "logout",
     "at": "…"
   }
   ```

   `kind` is `session` (one session or token family), `user` (every session of `userId`) or `membership` (every
   socket of `userId` in `organizationId`). `reason` is one of `logout`, `logout_all`, `org_switch`, `member_removed`,
   `role_changed`, `invitation_revoked`, `password_changed`, `extension_revoked`. ARC-2 adds the schema
   (`AuthRevocationMessage`) and the `auth:reauth-required` server event to `@meetops/contracts`.

3. Each realtime node subscribes and disconnects its own matching sockets. For `org_switch` it first emits
   `auth:reauth-required`, then disconnects, so the client reconnects with the new session. A message that fails schema
   validation is dropped and counted.
4. Pub/sub is at-most-once, so it is the fast path, not the guarantee (section 5 is the backstop). Targets: a revoked
   socket receives no further `organizations:{old}` or meeting-room events within 1 s with Redis up, and within the TTL
   without it (XT-30).

### 4. Meeting access

1. `canAccessMeeting` is a DB lookup in the socket's organization:
   `runWithOrganizationContext(socket.data.organizationId, (tx) => tx.meeting.findFirst({ where: { id, organizationId, deletedAt: null } }))`.
   No row means denied. RLS makes another org's meeting invisible even if the `where` clause were wrong.
2. The `meetingId` MUST be a UUID (tighten the current `^[A-Za-z0-9_-]{1,128}$` check). The ack for a missing and an
   other-org meeting MUST be identical (`{ ok: false, error: 'forbidden' }` today), per the ADR-004 tenancy rule.
3. Team or project scoping is added later on top of this lookup, never instead of it.

### 5. Revalidation (TTL and on join)

1. Every socket MUST be re-verified with `verifySession` at least every **`REALTIME_REAUTH_INTERVAL_MS`**
   (default 300 000 = 5 min, MUST be ≤ 300 000), and no later than its `expiresAt`. A `null` result or a changed
   `organizationId` disconnects the socket (with `auth:reauth-required` first on an org change).
2. Every `meeting:join` MUST re-verify before the meeting lookup and use the fresh `organizationId`.
3. To re-verify, realtime keeps the credential hash in `socket.data`, never the raw cookie or token, and calls a
   `verifySessionByHash` variant that BE-6 exposes. The raw value is used only at the handshake.
4. A verifier or DB error during revalidation fails closed: disconnect, log without credentials.

## Consequences

- Realtime becomes usable for web and extension clients without coupling it to `apps/api`. `@meetops/session-verifier` is
  a new workspace package, so BE-6 and MR-1 change `pnpm-lock.yaml` (workspace links only) and go through the lockfile queue.
- Production deploys realtime same-host with the API (path routing). A separate realtime subdomain would need a different
  cookie design and a new ADR.
- Redis becomes required wherever realtime runs with more than one API instance (OPS-1). Without Redis, revocation takes up
  to 5 minutes, which is the accepted ceiling.
- Each socket costs one DB verification per 5 minutes plus one per join. That is acceptable at current scale; caching
  MUST NOT extend beyond the TTL.
- The extension gains a realtime surface but stays within two scopes and one org, with no org-wide event room.

### Owner dependencies

- **BE-6:** `packages/session-verifier` (sections 2 and 5.3), the publisher in section 3 on all listed events, and tests:
  expired, idle, revoked and wrong-org sessions return `null`; a publish per event with fake Redis.
- **ARC-2:** `AuthRevocationMessage` and `auth:reauth-required` in `@meetops/contracts`.
- **MR-1:** wire `verifySession` and the DB `canAccessMeeting`, the credential rules in section 1, UUID meeting ids, and
  `REALTIME_EXTENSION_IDS`; keep `denyAllVerifier` for tests only. Tests: XT-23.
- **MR-2:** the subscriber, TTL and on-join revalidation, `auth:reauth-required` on org switch. Tests: XT-30.
- **OPS-1:** Redis in prod-like compose; reverse-proxy path routing for `/socket.io`.
- **SEC:** reviews BE-6, MR-1 and MR-2 against this record; SEC-2 adds the XT rows.

## Sign-off

Both signatures are required before Status moves to Accepted. Sign by replacing `pending` with the agent, date and PR.

| Role                      | Signer  | Date | Notes |
| ------------------------- | ------- | ---- | ----- |
| Architecture Agent (ARCH) | pending |      |       |
| Security Agent (SEC)      | pending |      |       |

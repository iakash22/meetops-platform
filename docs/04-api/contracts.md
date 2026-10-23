# Contracts guide (moved)

The guide to `@meetops/contracts` (what it exports, how to add a contract, versioning) now lives in the package:
[`packages/contracts/README.md`](../../packages/contracts/README.md). Changes are listed in
[`packages/contracts/CHANGELOG.md`](../../packages/contracts/CHANGELOG.md). Ownership and the change process are in
[ADR-003](../15-decisions/ADR-003-contracts-ownership.md).

## v0.3.x summary (PR #50, merged 2026-10-22)

`integration/phase-1` is on `@meetops/contracts` **0.3.2**. PR #50 (merge commit `d396cd1`) released 0.3.0. Then 0.3.1 added org, session and member list contracts, and 0.3.2 tightened the display-text checks. The full list is in the CHANGELOG. The main changes:

- **Meeting resolve:** `ResolveMeetingRequest` and `ResolveMeetingResponse { meetingId, created }` for `POST /orgs/:organizationId/meetings/resolve`. The request needs at least one of `externalMeetingUrl` (https) or `externalMeetingId`. The call is idempotent per (organizationId, source, externalMeetingId). Also adds `GetMeetingParams`.
- **Extension auth ([ADR-005](../15-decisions/ADR-005-extension-auth.md) plus amendment 1, pairing proof):**
  - Pair: `ExtensionPairRequest` returns `ExtensionPairResponse`, which carries no tokens.
  - Tokens: `ExtensionTokenRequest` returns `ExtensionTokenResponse` (Bearer, audience `extension`, `expiresIn` at most 900 s).
  - Refresh rotates tokens. Revoke requires `refreshToken` in the body, and both refresh and revoke are authenticated by that refresh token, not by a Bearer token.
  - New constants: `EXTENSION_*`, `EXTENSION_AUTH_PATHS` and `REDACT_KEYS`.
  - The extension generates a single-use nonce and must reject an `ExtensionTokenResponse` whose `nonce` echo doesn't match the stored nonce (ADR-005).
  - The pairing message handler must match `sender.origin` exactly against the production web origin (ADR-005).
  - Tokens are kept only in `chrome.storage.session`, left at `TRUSTED_CONTEXTS` (ADR-005).
  - Reusing an already-consumed refresh token revokes the whole token family (ADR-005).
- **Task list query:** `ListTasksQuery` adds cursor pagination and filters for status, priority, assignee, project, meeting, due dates and `q`. `unassigned: true` can't be combined with `assigneeId`. Also adds `TASK_STATUSES`.
- **Also added:** `SwitchOrganizationRequest` (`POST /auth/switch-org`), the `CSRF_INVALID` error code (the web client fetches a fresh token from `GET /auth/csrf` and retries once on 403; `apps/web/src/lib/api/client.ts`), and a types-only entry point, `@meetops/contracts/types`.
- **Changed:** `Transcript.provider` is now `TranscriptProviderId`. `'unknown'` is allowed only for legacy rows backfilled by the database migration.
- **Deprecated:** `PresignedUrl` and `StorageObjectMetadata`, to be removed in 0.4.0.

# @meetops/session-verifier

Shared, read-only session verification per ADR-011. Used by `apps/api` and
(later) `apps/realtime` so both services accept and reject exactly the same
credentials.

```ts
import { verifySession } from '@meetops/session-verifier';

const session = await verifySession({ cookie }); // or { bearer }
if (!session) return reject();
// { userId, organizationId, sessionId, credential, role, scopes?, expiresAt }
```

- Returns `null` for expired (idle or absolute), revoked, wrong-audience or
  malformed credentials, a session with no active organization, a deleted
  user, or a missing or soft-deleted membership.
- `expiresAt` is the earliest of idle expiry, absolute expiry and token expiry.
- Membership reads run inside `withOrganizationContext` (RLS).
- Read-only: it never slides `last_seen_at`. The API stays the only writer.
- `hashToken` is the single SHA-256 hex hash. `TOKEN_HASH_TEST_VECTORS` is
  shared with the API's `CryptoTokenService.hash` test.
- `verifySessionByHash` lets callers that only hold a hash (e.g. revocation
  fan-out) reuse the same rules.
- `createRedisRevocationPublisher` / `parseRevocationMessage` implement the
  `meetops:auth:revocations` message (`v: 1`, ids only). The types mirror the
  contracts `AuthRevocationMessage` (contracts v0.4.1) until that lands on
  integration.
- The bearer (extension token) path fails closed unless an
  `ExtensionTokenStore` is passed to `createSessionVerifier`.

This package must not import from any app.

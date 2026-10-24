# ADR-008: OAuth 3LO with PKCE state, and integration token encryption at rest

- Status: Proposed
- Date: 2026-10-24
- Owner: Architecture Agent (ARCH), with the Integrations and Security (SEC) Agents
- Implementing PR: #67 (`feat(integrations): Jira OAuth 3LO + PKCE, GitHub App install state, token encryption at
rest`), **open and unmerged**, verified at head `d9f8e3a716437f12c3d928203ce54a1866878f98`
- Related: [ADR-007](./ADR-007-integrations-retry-webhook-replay.md)

## Context

Organizations connect Jira Cloud via OAuth 2.0 three-legged (3LO) and GitHub via a GitHub App installation. The flows
need CSRF-safe state bound to the initiating user and organization, and the access and refresh tokens they return
must be encrypted in the database.

## Decision

### State and PKCE (`src/oauth-state.ts`)

1. `OAuthStateManager.issue` creates a 256-bit random state (43 base64url chars) and stores it under `sha256(state)`,
   so the raw value never rests in the store. It is bound to `provider`, `organizationId`, `userId` and `redirectUri`.
   The TTL defaults to 600 s and is clamped to 60–900 s.
2. `consume` atomically takes the record (Redis `GETDEL` in `RedisOAuthStateStore`; `put` uses `SET NX EX`). The state
   is consumed even on mismatch, so it can't be retried. Expiry and every binding field are checked, the fields in
   constant time.
3. PKCE (RFC 7636) S256: `createPkcePair` generates a 32-byte verifier. The verifier is stored server-side with the
   state and never sent to the browser. `JiraOAuth` sends `code_challenge` with `code_challenge_method=S256`.
4. Redirect URIs must exactly match an allowlist (`assertAllowedRedirect`): https only, or `http://localhost` /
   `127.0.0.1` for dev, with no fragment or credentials.
5. Jira scopes are fixed to `read:jira-work`, `write:jira-work`, `read:jira-user`, `offline_access`. The client secret
   is resolved per call from the secret manager (`clientSecret: () => Promise<string>`) and never stored on the
   instance. Rotating refresh tokens are required by default (`requireRefreshRotation`).
6. GitHub App install (`src/github-app-install.ts`) uses the same state manager with provider `github-app`. The
   returned `installation_id` stays untrusted until the backend confirms it with the App JWT.

### Token encryption (`src/token-crypto.ts`)

1. **Envelope encryption.** `TokenCipher.encrypt` makes a fresh random 256-bit data key per record and encrypts the
   token with AES-256-GCM (random 12-byte IV, 16-byte tag). The data key is wrapped by a key-encryption key (KEK). The
   stored format is one text column: `v1.<keyId>.<wrappedKey>.<iv|ciphertext|tag>` (base64url).
2. **AAD** = `["meetops.token.v1", organizationId, integrationId]` for both layers, so a blob copied to another
   organization or integration fails to decrypt. Plaintext never appears in logs or errors, and data keys are zeroed
   after use.
3. **Where keys live.** KEKs come from a `KeyEncryptionProvider`. In production it should be a KMS or secret manager.
   `LocalKeyProvider` holds 32-byte KEKs in memory, keyed by id, for dev/test or keys loaded from a secret manager at
   boot. No keys, env var names or key material are defined or committed in the repo; the host app supplies them.
4. **Rotation, as implemented.** Each envelope records its `keyId`. New records use `currentKeyId()`, and old records
   still decrypt with their recorded key. `TokenCipher.keyIdOf`, `needsRotation` and `rotate` (decrypt then
   re-encrypt under the current key) are the building blocks for a `token_key_id` column and a rotation job.

## Consequences and open items

- **Rotation operations aren't defined:** no rotation job, schedule, `token_key_id` column, or rule for retiring old
  KEKs. There is no KMS-backed `KeyEncryptionProvider` and no defined env var or secret path for KEKs. These need a
  follow-up from SEC/DevOps.
- Which `OAuthStateStore` is wired in production (it must be Redis for multiple replicas) is left to the backend.
- The `installation_id` verification via the App JWT is a backend responsibility not implemented in this package.

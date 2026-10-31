# @meetops/integrations

Issue-tracker integrations for MeetOps: a provider contract, GitHub Issues and Jira Cloud adapters, GitHub webhook verification, and a pure status-sync mapper.

## Security model (summary)

- **No auto-push.** Every outbound write (`createIssue`, `updateStatus`) needs a human approval reference that is verified by Backend.
- **No plaintext tokens in config.** Providers get a `CredentialResolver` and call it right before each API request.
- **Per-integration webhook secrets.** Secrets are looked up by the hook/installation ids GitHub sends, through a `WebhookSecretResolver`.
- **Audit.** Every write attempt, success, failure and rejection is sent to an injected `AuditSink`.
- **Sanitized errors.** Upstream error bodies, headers and tokens never appear in error messages or audit events, only the HTTP status.

## Approval gate (breaking contract change)

```ts
createIssue(input: CreateIssueInput, approval: WriteApproval): Promise<Issue>
updateStatus(key: string, status: IssueStatus, approval: WriteApproval): Promise<Issue>

// WriteApproval is imported from @meetops/contracts:
// { approvalId: uuid; organizationId: uuid; approverUserId: uuid; payloadHash: lowercase sha256 hex (64); approvedAt?: ISO date-time }
```

Order of checks (in `guardedWrite`). No credential lookup or network call happens before all of them pass:

1. The approval passes `Value.Check` against the contracts `WriteApproval` schema (strict). If not, `ApprovalRequiredError`.
2. `approval.organizationId` equals the provider's organization. If not, `ApprovalMismatchError`.
3. `approval.payloadHash` equals `computeWritePayloadHash(operation, {provider, organizationId, integrationId}, payload)`. If not, `ApprovalMismatchError`.
   - The hash is sha256 over canonical JSON (sorted keys, undefined dropped).
   - For `createIssue` the payload is the exact `CreateIssueInput` passed in. For `updateStatus` it is `{ key, status }`.
4. `ApprovalVerifier.verify(approval, {operation, provider, organizationId, integrationId, payloadHash})` returns true. If not, `ApprovalRejectedError`. Backend must check that the approval exists, is approved, is unexpired and unused, and must consume it atomically so it can only be used once.
5. `AuditSink.record({phase:'attempt'})`, then the write, then `record({phase:'success'|'failure', attemptCount})`. A rejection records `phase:'rejected'`.
   - Each audit record is retried a bounded number of times (`auditRetry`, default 3 tries with a 50 ms linear delay).
   - If the before-write `attempt` record still fails, the write is **aborted** (`AuditUnavailableError`).
   - If the write succeeded but the `success` record can't be stored, an `AuditRecordError` is thrown carrying `result`, so the caller can reconcile instead of re-pushing (which would create a duplicate).
   - `attemptCount` is the number of underlying write API attempts, including retries.

### `computeWritePayloadHash` (exported from the package root)

```ts
import { computeWritePayloadHash, canonicalJson } from '@meetops/integrations';
const payloadHash = computeWritePayloadHash(
  'createIssue',
  { provider: 'github', organizationId, integrationId },
  input,
);
// = sha256(canonicalJson({ operation, provider, organizationId, integrationId, payload })) as lowercase hex
```

Backend must store this hash on the approval record when the human approves, and pass it back in `WriteApproval.payloadHash`. The payload for `createIssue` is the exact `CreateIssueInput`; for `updateStatus` it is `{ key, status }`.

## Interfaces Backend must implement

| Interface               | Purpose                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ApprovalVerifier`      | Verify and consume approval records (single use, scoped to org, integration, operation and payload hash)                                                                                  |
| `AuditSink`             | Append-only audit log of integration writes                                                                                                                                               |
| `CredentialResolver`    | `resolve(orgId, integrationId)` returns `{kind:'github', token}`, `{kind:'jira', email, apiToken}` or `{kind:'jira-oauth', accessToken}`, read from a secret manager or encrypted storage |
| `WebhookSecretResolver` | `resolve({hookId?, targetId?, targetType?, installationId?})` returns `{organizationId, integrationId, secret}` or `null`                                                                 |
| `DeliveryStore`         | Replay protection backed by Redis (`SET key NX EX ttl`). The in-memory store refuses to run in production.                                                                                |

## Usage

```ts
import {
  GitHubIssuesProvider,
  JiraIssueTrackerProvider,
  computeWritePayloadHash,
} from '@meetops/integrations';

const scope = { organizationId, integrationId };
const github = new GitHubIssuesProvider({
  ...scope,
  credentials,
  approvals,
  audit,
  defaultRepo: 'acme/app',
});
const jira = new JiraIssueTrackerProvider({
  ...scope,
  credentials,
  approvals,
  audit,
  baseUrl: 'https://<site>.atlassian.net',
  projectKey: 'MEET',
  transitions: { done: 'Done', closed: "Won't Do" }, // internal status -> Jira transition name
  timeoutMs: 10_000,
  maxResponseBytes: 1 << 20,
});

// At approval time (Backend): store payloadHash with the approval record.
const input = { title: 'Follow up', description: 'From meeting' };
const payloadHash = computeWritePayloadHash('createIssue', { provider: 'jira', ...scope }, input);
// Later, after the human approves:
await jira.createIssue(input, { approvalId, organizationId, approverUserId, payloadHash });
```

How internal statuses map to each tracker:

| Internal      | GitHub                                            | Jira                     |
| ------------- | ------------------------------------------------- | ------------------------ |
| `open`        | open (in-progress label removed)                  | transition `To Do`       |
| `in_progress` | open + label `status: in-progress` (configurable) | transition `In Progress` |
| `done`        | closed, `state_reason=completed`                  | transition `Done`        |
| `closed`      | closed, `state_reason=not_planned`                | transition `Won't Do`    |

Jira hardening:

- Each request has a timeout enforced with `AbortController`.
- Redirects are refused (`redirect: 'error'`, and any 3xx response is rejected).
- Response bodies are capped in size.
- Only `https://<site>.atlassian.net` or `https://api.atlassian.com/ex/jira/<cloudId>` base URLs are accepted. The gateway form is required for scoped API tokens and OAuth; set `siteUrl` so browse links use the site.

## Resilience

- **Retries.** `withRetry` uses exponential backoff with full jitter. Defaults: 4 attempts, 500 ms base delay, `maxDelayMs` 60 s. Sleep, clock and randomness can be injected for tests.
- **What is retried:**
  - **429**, honoring `Retry-After` in either seconds or HTTP-date form.
  - **GitHub primary rate limit:** a 403 with `x-ratelimit-remaining: 0` waits until `x-ratelimit-reset`.
  - **GitHub secondary rate limit:** a 403 with `Retry-After`.
  - **5xx** responses, network errors and timeouts — **only for idempotent requests** (see below).
- **Idempotency (`RetryOptions.idempotent`, default `true`).** With `idempotent: false`, only failures the classifier marks `notProcessed` are retried: 429, 503 with `Retry-After`, and GitHub rate-limit 403s. Network errors, timeouts and other 5xx are not retried because the request may already have been applied (duplicate issues). Providers set this per call: Jira uses the HTTP method (`POST /issue` and transition `POST`s are non-idempotent; `isIdempotentMethod`), GitHub marks `issues.create` non-idempotent. A caller's `idempotent: false` turns retries of transport errors off for every call; it can never turn them on for a POST. Only enable it for a POST when a real idempotency key exists.
- **What is never retried:** any other 4xx. If the server asks for a wait longer than `maxDelayMs`, the call fails fast instead of sleeping.
- **Scope.** Retries apply to Octokit calls (`retry` option on `GitHubIssuesProvider`) and to Jira fetches (`retry` option on `JiraIssueTrackerProvider`).
- **Order.** The approval gate runs before the first attempt. Retries happen inside the approved, audited write, and the audit log records one attempt and one result per write.
- **Replay store.** `RedisDeliveryStore(redis, { keyPrefix = 'meetops:webhook:delivery:', defaultTtlSeconds = 604800 })` is atomic through `SET key 1 EX ttl NX`. It accepts any injected ioredis-compatible client. TTLs below 7 days (`MIN_REPLAY_TTL_SECONDS`) are raised to 7 days in both the Redis and in-memory stores.

## Persisted links (`IntegrationIssueRecord` from @meetops/contracts)

`toIntegrationIssue(issue, { id, organizationId, integrationId, taskId, createdAt? })` builds a tenant-scoped `IntegrationIssueRecord`:

- `provider` is `'github'` or `'jira'`.
- `externalId` is the provider key.
- `lastKnownStatus` is taken from `issue.status`.
- `externalUrl` is set only for https links.
- The result is validated against the contract schema.

`fromIntegrationIssue(record)` returns `{ organizationId, integrationId, provider, key, lastKnownStatus? }`. Look links up by `(organizationId, provider, externalId)`.

## GitHub webhooks

```ts
const result = await verifyGitHubWebhook({
  secretResolver, // per-integration secrets
  rawBody, // exact raw bytes of the request body; do NOT JSON.stringify a parsed body
  headers: req.headers,
  deliveryStore: redisDeliveryStore,
});
if (!result.ok) return reply.code(result.status).send({ error: result.reason });
const change = mapGitHubIssueEvent(result.event, result.payload, result); // uses result.organizationId/integrationId
// change: { organizationId, integrationId, provider: 'github', externalId: 'owner/repo#N', status, action } | null
// Look up the task by (organizationId, provider, externalId).
```

- **Routing.** `X-GitHub-Hook-ID`, `X-GitHub-Hook-Installation-Target-ID`/`-Type` and `payload.installation.id` are passed to `WebhookSecretResolver`. The body is parsed before verification only to read `installation.id`, and it is size-capped (default 1 MiB, otherwise 413).
- **Signature.** HMAC-SHA256 of the raw body is compared to `X-Hub-Signature-256` with `timingSafeEqual`, after a length check.
- **Failure codes.** An unknown integration, a missing or invalid secret, or a bad signature returns **401**. A missing or malformed delivery ID (`missing_delivery_id` / `malformed_delivery_id`) or invalid JSON returns 400. A replayed delivery returns 409. An oversized body returns 413.
- **Replay protection.** The delivery ID is recorded only after the signature is valid. Use a Redis `DeliveryStore` in production.
  - `X-GitHub-Delivery` must be a GUID (`isValidGitHubDeliveryId`, max 64 chars); anything else is rejected with 400 before the store is touched. IDs are lower-cased so case variants collide.
  - Delivery IDs are kept for `replayTtlSeconds`, default **and minimum** 7 days (604800 s); smaller values are raised.
  - **GitHub sends no signed timestamp**, so a captured request is replayable once its ID expires. The delivery-ID TTL is the only replay control for GitHub; keep it ≥ 7 days (GitHub allows manual redelivery for 3 days).
- **Freshness (providers with timestamps).** `checkTimestampFreshness(ts, { maxAgeSeconds, maxFutureSkewSeconds = 300 })` returns `fresh | stale | future | invalid` for epoch s/ms or ISO-8601 values. `checkJiraWebhookFreshness(payload, opts)` reads Jira's `timestamp` body field (returns `absent` unless `requireTimestamp`). Run it only after authenticating the request, and reject `stale`/`future`/`invalid` with 400. Combine with a delivery-ID store where the provider sends one.

### Webhook secret handling

- Use one random secret per integration (`openssl rand -hex 32`), kept in the secret manager and referenced by integration ID.
- Never log secrets, signature headers or raw bodies.
- To rotate, update the secret manager entry and the GitHub hook together.

## Target auth model: OAuth 2.0 (3LO) with PKCE

Static API tokens and PATs are a stop-gap. The target is OAuth 2.0 authorization-code flow with PKCE (S256) per organization:

- **GitHub:** a GitHub App with user-to-server or installation tokens.
- **Jira:** Atlassian OAuth 2.0 3LO, which returns `jira-oauth` credentials.

Backend stores refresh tokens encrypted, refreshes them in `CredentialResolver`, and never puts tokens in config, env or job payloads.

## Least-privilege credentials

**GitHub App (preferred)**

- Repository permissions: **Issues: Read & write**, **Metadata: Read-only**. Nothing else.
- Subscribe to webhook events: **Issues**.
- Install only on the repositories that should sync.

**Fine-grained PAT (fallback)**: scope to selected repositories; permissions **Issues: Read and write**, **Metadata: Read-only**. Avoid classic PATs (`repo` scope is far broader).

**Jira Cloud** (verified against Atlassian docs, 2026-10-21)

Operations used and the OAuth 2.0 (3LO) / scoped-token scopes Atlassian lists for each:

| Operation        | Endpoint                                   | Classic scope (recommended) | Granular scopes                                                                                                                                             |
| ---------------- | ------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create issue     | `POST /rest/api/3/issue`                   | `write:jira-work`           | `write:issue:jira`, `write:comment:jira`, `write:comment.property:jira`, `write:attachment:jira`, `read:issue:jira`                                         |
| Get issue        | `GET /rest/api/3/issue/{key}`              | `read:jira-work`            | `read:issue-meta:jira`, `read:issue-security-level:jira`, `read:issue.vote:jira`, `read:issue.changelog:jira`, `read:avatar:jira`, … (more on the doc page) |
| Get transitions  | `GET /rest/api/3/issue/{key}/transitions`  | `read:jira-work`            | `read:issue.transition:jira`, `read:status:jira`, `read:field-configuration:jira`                                                                           |
| Transition issue | `POST /rest/api/3/issue/{key}/transitions` | `write:jira-work`           | `write:issue:jira`, `write:issue.property:jira`                                                                                                             |
| Health check     | `GET /rest/api/3/myself`                   | `read:jira-user`            | `read:application-role:jira`, `read:group:jira`, `read:user:jira`, `read:avatar:jira`                                                                       |

The minimum classic set is therefore **`read:jira-work`, `write:jira-work`, `read:jira-user`**. Note that `write:jira-work` also allows deleting issues and posting comments; the granular scopes narrow this.

- **Unscoped API tokens** use basic auth `email:token` against `https://<site>.atlassian.net`. They carry the full permissions of the account, so use a dedicated service account.
- **Scoped API tokens** must call `https://api.atlassian.com/ex/jira/{cloudId}`, which is supported via `baseUrl` + `siteUrl`.
- **Token expiry.** New API tokens expire after at most one year, so plan for rotation.
- **Scopes don't override Jira permissions.** The service account still needs these project permissions: **Browse Projects**, **Create Issues**, **Edit Issues**, **Transition Issues** (plus **Assign Issues** / **Assignable User** when assigning). Grant no admin permissions.

Sources:

- Scopes (classic and granular): https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/
- Issues API (per-operation scopes): https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- Myself API: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/
- API tokens (scoped tokens, gateway URL, expiry): https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
- Project permissions: https://support.atlassian.com/jira-cloud-administration/docs/manage-project-permissions/

## Environment variables (names only)

Per-integration credentials and webhook secrets live in the secret manager or encrypted DB, resolved through the interfaces above, not in env. Only app-level values belong in env:

| Name                                                                          | Used for                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (secret manager)                    | Minting installation tokens inside `CredentialResolver` |
| `ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET` (secret manager) | Jira OAuth 3LO (target)                                 |
| `REDIS_URL`                                                                   | `DeliveryStore`                                         |

This package does not read env itself.

## Jira OAuth 2.0 (3LO) with PKCE

```ts
const oauth = new JiraOAuthClient({
  clientId, // Atlassian developer console
  clientSecret: () => secrets.get('jira-oauth-client-secret'), // resolved per call
  redirectUriAllowlist: ['https://app.example.com/integrations/jira/callback'], // exact match only
  stateStore: new RedisOAuthStateStore(redis), // single-use, GETDEL
});
const { url } = await oauth.beginAuthorization({ organizationId, userId, redirectUri }); // 302 the user here
// callback:
const conn = await oauth.completeAuthorization({
  state: q.state,
  code: q.code,
  organizationId,
  userId,
  redirectUri,
});
// conn: { accessToken, refreshToken, expiresAt, scopes, cloudId?, siteUrl?, baseUrl?, resources }
const next = await oauth.refresh(storedRefreshToken); // rotating refresh token: persist the NEW pair atomically
```

- **Endpoints.** `https://auth.atlassian.com/authorize`, `https://auth.atlassian.com/oauth/token` and `https://api.atlassian.com/oauth/token/accessible-resources`.
- **PKCE.** S256, with a 32-byte random verifier. The verifier stays server-side inside the state record and is never sent to the browser. The client secret is still sent, because this is a confidential client.
- **State.** 256-bit random, stored under `sha256(state)`, bound to provider + organization + user + redirect URI. It is compared in constant time, can be used once (it is consumed even when the binding doesn't match), and expires after 600 s by default (900 s maximum).
- **Redirect URIs.** Must match the allowlist exactly. Only https is accepted, or http://localhost for development. Fragments and userinfo are rejected.
- **Scopes.** `JIRA_OAUTH_SCOPES = read:jira-work write:jira-work read:jira-user offline_access`. `validateGrantedScopes` checks the token response: a missing scope fails with `insufficient_scope`, and any extra scope fails with `excess_scope`.
- **cloudId.** Accessible resources are filtered to Jira sites with a UUID id and an `https://*.atlassian.net` URL. If exactly one site is left, or `cloudId` names one of them, the result includes `baseUrl = https://api.atlassian.com/ex/jira/<cloudId>` for `JiraIssueTrackerProvider`. Otherwise the user must pick from `resources`.
- **Refresh.** A new refresh token must come back on every refresh (`requireRefreshRotation`, default true). Token calls are never retried, because codes and rotated refresh tokens are single use. Concurrent refreshes need a per-integration lock and a compare-and-swap write.
- **Errors.** `JiraOAuthError(code, status)` carries only an allowlisted `error` code. It never includes tokens, codes, secrets or response bodies.

## GitHub App installation state

`GitHubAppInstallFlow({ appSlug, redirectUriAllowlist, stateStore })`:

- `.begin()` returns `https://github.com/apps/<slug>/installations/new?state=…`.
- `.complete({ state, installationId, setupAction, … })` consumes the state with the same binding rules as Jira and validates `installation_id` (digits only) and `setup_action` (`install` or `update`).
- The returned `installation_id` is **untrusted** until the backend confirms it with the App JWT (`GET /app/installations/{id}`).

## Token encryption at rest

```ts
const cipher = new TokenCipher(kmsKeyProvider); // or new LocalKeyProvider({ k1: key32 }, 'k1') in dev/tests
const enc = await cipher.encrypt(JSON.stringify({ accessToken, refreshToken }), {
  organizationId,
  integrationId,
});
// enc = "v1.<keyId>.<wrappedDataKey>.<iv|ciphertext|tag>" (base64url)
const plain = await cipher.decrypt(enc, { organizationId, integrationId });
```

- **Envelope encryption.** Each record gets a fresh 256-bit data key and is encrypted with AES-256-GCM (random 12-byte IV, 16-byte tag). The `KeyEncryptionProvider` wraps the data key (KMS in production).
- **AAD.** `["meetops.token.v1", organizationId, integrationId]`. A ciphertext moved to another row fails to decrypt.
- **Rotation.** `currentKeyId()` encrypts new records, and old key ids still decrypt. `needsRotation()` and `rotate()` support re-encryption jobs. `TokenCipher.keyIdOf()` gives the value for a `key_id` column.
- **Logging.** Never log plaintext tokens. Decryption errors are generic (`TokenDecryptionError`).

## Real GitHub App e2e (opt-in)

`test/github-app.e2e.test.ts` exercises App JWT -> installation lookup -> installation token -> `GitHubIssuesProvider`
(health check, create, get, status update) against real api.github.com, then closes the issue and revokes the token.
Skipped unless `MEETOPS_GITHUB_E2E=1`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` are set (preferred; the inline
`GITHUB_APP_PRIVATE_KEY` is only a fallback when no key file is given). The installation stage additionally needs
`GITHUB_E2E_INSTALLATION_ID` and `GITHUB_E2E_REPO`, which must be a throwaway repo with Issues enabled: its name must
contain `e2e` or `throwaway`, or it must be listed in `GITHUB_E2E_REPO_ALLOWLIST` (comma-separated `owner/repo`);
otherwise the run fails with a clear refusal. Cleanup closes the issue (falling back to a direct PATCH by the raw issue
number) and revokes the installation token, which is stored right after minting. Never commit or print the key or tokens.

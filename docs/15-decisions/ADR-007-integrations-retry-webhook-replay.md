# ADR-007: Integrations retry idempotency and webhook replay protection

- Status: Proposed
- Date: 2026-10-24
- Owner: Architecture Agent (ARCH), with the Integrations and Security (SEC) Agents
- Implementing PR: #63 (`feat(integrations): webhook replay hardening + idempotency-aware retries`), **open and
  unmerged**, verified at head `6cd1ac2bbf66260bcf601a5814b50346701b839c`
- Related: [ADR-002](./ADR-002-provider-interfaces.md), [ADR-008](./ADR-008-oauth-pkce-token-encryption.md)

## Context

`packages/integrations` creates and updates Jira and GitHub issues and receives GitHub webhooks. Blindly retrying a
`POST /issue` after a timeout or 5xx can create duplicate issues. GitHub webhook deliveries carry no signed
timestamp, so a captured signed request can be replayed.

## Decision

1. **Retries** (`src/retry.ts`, `withRetry`): up to 4 attempts by default, full-jitter exponential backoff (base 500
   ms, cap 60 s). If the server asks for a wait longer than the cap, retrying stops.
2. **Classification** (`classifyHttpError`, `classifyOctokitError`): 429, 403 with `x-ratelimit-remaining: 0`, 403
   with `Retry-After`, and 503 with `Retry-After` are marked `notProcessed` (honouring `Retry-After` /
   `x-ratelimit-reset`). Other 5xx and network errors are retryable but not `notProcessed`. Other 4xx are never retried.
3. **Idempotency gate.** With `idempotent: false`, only `notProcessed` failures are retried; network errors, timeouts
   and other 5xx are thrown. Callers set this:
   - Jira: `idempotent = isIdempotentMethod(method)` (GET, HEAD, OPTIONS, PUT, DELETE), so issue-create and
     transition POSTs are non-idempotent. PATCH is also treated as non-idempotent.
   - GitHub: `issues.create` is wrapped with `idempotent: false`; `issues.get`/`issues.update` and `repos.get` use
     the default.
   - A caller-supplied `retry.idempotent: false` can only make it stricter.
   - `RetryOptions.idempotent` defaults to `true` when unset, so a new caller of `withRetry` that forgets to set it
     will retry 5xx/network errors. The adapters above always set it.
4. **Webhook replay** (`src/webhook.ts`): `verifyGitHubWebhook` checks the size cap (1 MiB default), resolves the
   per-integration secret (`WebhookSecretResolver`, returning `organizationId` and `integrationId`), verifies
   `X-Hub-Signature-256` in constant time, validates `X-GitHub-Delivery` as a GUID (≤ 64 chars), and only then records
   the delivery id. A repeat id returns 409 `replayed_delivery`.
5. **Replay TTL.** `DEFAULT_REPLAY_TTL_SECONDS` = `MIN_REPLAY_TTL_SECONDS` = 604800 (7 days).
   `effectiveReplayTtlSeconds` raises any configured value to at least 7 days, and a missing or non-finite value
   becomes the default. Both delivery stores apply it.
6. **Stores.** `RedisDeliveryStore` uses atomic `SET key 1 EX ttl NX` (prefix `meetops:webhook:delivery:`).
   `InMemoryDeliveryStore` throws under `NODE_ENV=production` unless `unsafeAllowInProduction` is set (tests only).
7. Jira webhooks: `checkJiraWebhookFreshness` checks the body `timestamp` after authenticity is verified; a missing
   timestamp gives `absent` unless `requireTimestamp` is set.

## Consequences

- A non-idempotent create that fails with a 5xx or timeout is surfaced, not retried. The caller must reconcile, for
  example by checking for the issue before creating again.
- After 7 days a captured GitHub delivery could be replayed; the floor covers GitHub's 3-day redelivery window.
- Open: no idempotency key is sent on create calls, so `idempotent: true` for a POST is never justified today.

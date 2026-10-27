# Phase 5 integrations: implementation notes and parked decisions

Branch `feat/api-integrations-oauth-webhooks`. These defaults were approved for this PR. Anything marked
**parked** needs a follow-up decision or ticket before production.

## What shipped

| Area                                                                                                                                            | Where                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| DB routing definer functions (`integration_connection_org`, `integration_connections_due_for_refresh`)                                          | `packages/database`                 |
| fetch-based GitHub App client (App JWT, installation lookup and token, user-to-server install check), Jira webhook verifier, Jira status mapper | `packages/integrations`             |
| `POST /orgs/:organizationId/integrations/connect`, `GET /integrations/:provider/callback`                                                       | `apps/api/src/modules/integrations` |
| `POST /webhooks/:provider/:integrationId` (raw body, 1 MiB, no session, returns 202)                                                            | same                                |
| `POST /orgs/:organizationId/tasks/:taskId/integration-issues` (returns 201)                                                                     | same                                |
| Token refresh sweep plus a non-overlapping interval scheduler                                                                                   | `apps/worker/src/integrations`      |

No new dependencies and no lockfile changes. All provider calls go through `fetch`, with no SDKs.

## Security properties

- **OAuth state.** The library state (single-use, expiring, bound to org, user and redirect URI) is wrapped in a
  MAC: `inner(43) || HMAC-SHA256(key, inner)` encoded base64url, 86 characters in total. The MAC is checked in
  constant time before anything reads the state store. Jira uses PKCE (S256), and the verifier stays on the
  server.
- **Callback session.** The callback requires a session. The org comes from `session.activeOrganizationId`, and
  the state must be bound to that org and user. Denied consent (`error=`) consumes the state.
- **Webhooks.** HMAC-SHA256 over the exact raw bytes, compared in constant time. Replays are rejected through the
  delivery store: the GitHub `X-GitHub-Delivery` header, or the Jira `X-Atlassian-Webhook-Identifier` scoped to
  the integration id. Stale Jira events are also rejected.
- **Token storage.** Tokens are stored only through the encrypting `IntegrationSecretCipher`. In production,
  `PrismaIntegrations` refuses to run without it.
- **Logging.** Logs and audit metadata carry identifiers and error names only.
- **Tenant isolation.** Everything is RLS-scoped through `withOrganizationContext`. Webhook routing uses a
  SECURITY DEFINER function that returns only the org id, and RLS is then re-entered with that org.
- **CSRF.** The integrations session scope now registers `mutationGuard` (CSRF plus Origin). Before this branch,
  `DELETE` had no guard.

## Decisions (approved defaults)

1. **No runtime in production.** Without an `integrationsRuntime`, the new routes return
   **503 PROVIDER_UNAVAILABLE**. Relaxed environments (dev and test) fall back to `devIntegrationsRuntime()`, which
   has an ephemeral key and no providers configured.
2. **Unconfigured provider.** If a provider is not configured on the deployment, the routes return
   **409 INTEGRATION_NOT_CONNECTED**.
3. **Jira site selection.** Jira requires exactly one accessible site. Otherwise the callback returns 400 and
   nothing is stored.
4. **GitHub has no PKCE** (the App install flow doesn't support it). Instead, the `installation_id` in the
   callback is treated as untrusted. The one-time user `code` is exchanged, and the installation must appear in
   `/user/installations` and in `/app/installations/:id`. The user token is discarded after that check.
5. **GitHub webhook secret is App-wide** (GitHub only allows one per App). A delivery is accepted only when the
   payload's `installation.id` equals the connection's `externalAccountId`. Jira webhooks use a random secret per
   connection.
6. **Unknown, revoked or mismatched webhook targets return 401**, the same response as a bad signature, so the
   endpoint doesn't reveal which integrations exist. This includes GitHub `ping` events without an installation.
7. **Issue push requires `update Organization`** (owner or admin).
8. **The approval payload hash is computed on the server** over the canonical create payload, because
   `TaskApproval` has no hash column yet.
9. **Push and status sync run synchronously in the API.** The API has no queue. A provider 5xx is not retried
   (ADR-007: non-idempotent write) and returns a sanitized 502.
10. **Jira access tokens refresh within 120 s of expiry**, at most once per push. The rotated pair is re-encrypted.
11. **Worker refresh sweep.** A permanent failure (invalid grant, or 400/401/403/404) sets the connection to
    `status=error`. Transient failures are retried on the next sweep.

## Parked (needs follow-up)

- **Env var names for the KEK and provider secrets (ADR-008).** None are defined yet, so production wiring of
  `integrationsRuntime` and of the worker's refresh deps is left out. `main()` doesn't start the refresh
  scheduler until these exist.
- **Webhook registration.** Registering webhooks at GitHub (App settings) and Jira (admin, or the dynamic webhook
  API) is manual for now. The Jira webhook secret is per connection but isn't shown anywhere yet. Exposing it, or
  registering through the API, is a follow-up.
- **Single-use approvals.** Approvals are single-use only through the existing-link check. A dedicated
  `consumedAt` column (or a hash column) would make this explicit.
- **Duplicate issues after a failed read-back.** Jira creates the issue and then reads it back. If the read-back
  fails, the issue exists but no link is stored, so a manual retry could create a duplicate. This needs an
  idempotency lookup by `externalRef` before creating.
- **Reconcile job.** The job that polls providers for missed webhooks is parked.
- **Multiple worker replicas.** The refresh scheduler must run on a single worker replica: Jira rotates refresh
  tokens, so two concurrent sweeps could revoke each other's grant. Before scaling out, switch to a BullMQ job
  scheduler or a DB lease.
- **Moving off the API path.** Move issue push and status sync onto the worker queue once the API can enqueue.

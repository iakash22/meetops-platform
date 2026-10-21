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

interface WriteApproval { approvalId: string; organizationId: string; approverUserId: string; payloadHash: string }
```

Order of checks (in `guardedWrite`). No credential lookup or network call happens before all of them pass:

1. The approval reference is complete. If not, `ApprovalRequiredError`.
2. `approval.organizationId` equals the provider's organization. If not, `ApprovalMismatchError`.
3. `approval.payloadHash` equals `computeWritePayloadHash(operation, {provider, organizationId, integrationId}, payload)`. If not, `ApprovalMismatchError`.
   - The hash is sha256 over canonical JSON (sorted keys, undefined dropped).
   - For `createIssue` the payload is the exact `CreateIssueInput` passed in. For `updateStatus` it is `{ key, status }`.
4. `ApprovalVerifier.verify(approval, {operation, provider, organizationId, integrationId, payloadHash})` returns true. If not, `ApprovalRejectedError`. Backend must check that the approval exists, is approved, is unexpired and unused, and must consume it atomically so it can only be used once.
5. `AuditSink.record({phase:'attempt'})`, then the write, then `record({phase:'success'|'failure'})`. A rejection records `phase:'rejected'`. If the audit sink throws, the write is aborted.

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
- Only `https://<site>.atlassian.net` base URLs are accepted.

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
- **Failure codes.** An unknown integration, a missing or invalid secret, or a bad signature returns **401**. A missing delivery ID or invalid JSON returns 400. A replayed delivery returns 409. An oversized body returns 413.
- **Replay protection.** The delivery ID is recorded only after the signature is valid. Use a Redis `DeliveryStore` in production.

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

**Jira Cloud**

- Use a dedicated service account and an Atlassian API token (basic auth `email:token`). If using scoped API tokens, grant only `read:jira-work` and `write:jira-work` (plus `read:jira-user` for `healthCheck` via `/myself`).
- Project permissions for that account: **Browse Projects**, **Create Issues**, **Edit Issues**, **Transition Issues** (and **Assign Issues** / **Assignable User** if assigning). No admin permissions.

## Environment variables (names only)

Per-integration credentials and webhook secrets live in the secret manager or encrypted DB, resolved through the interfaces above, not in env. Only app-level values belong in env:

| Name                                                                          | Used for                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (secret manager)                    | Minting installation tokens inside `CredentialResolver` |
| `ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET` (secret manager) | Jira OAuth 3LO (target)                                 |
| `REDIS_URL`                                                                   | `DeliveryStore`                                         |

This package does not read env itself.

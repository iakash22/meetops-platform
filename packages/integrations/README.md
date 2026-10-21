# @meetops/integrations

Issue-tracker integrations for MeetOps: a provider contract, GitHub Issues and Jira Cloud adapters, GitHub webhook verification, and a pure status-sync mapper.

## Approval gate (breaking contract change)

Every **outbound write** requires explicit approval:

```ts
createIssue(input: CreateIssueInput, approval: WriteApproval): Promise<Issue>
updateStatus(key: string, status: IssueStatus, approval: WriteApproval): Promise<Issue>
// WriteApproval = { approved: true; approvedBy?: string; reason?: string }
```

If `approval.approved !== true` (missing, `false`, `"yes"`, …) the provider throws `ApprovalRequiredError` **before any network call**. There is no default and no auto-push path: callers (Backend) must obtain user approval and pass it explicitly, ideally recording `approvedBy` for audit. Reads (`getIssue`, `healthCheck`) do not need approval.

## Usage

```ts
import { GitHubIssuesProvider, JiraIssueTrackerProvider } from '@meetops/integrations';

const github = new GitHubIssuesProvider({
  token: process.env.GITHUB_TOKEN,
  defaultRepo: 'acme/app',
});
const jira = new JiraIssueTrackerProvider({
  baseUrl: process.env.JIRA_BASE_URL!, // https://<site>.atlassian.net
  email: process.env.JIRA_EMAIL!,
  apiToken: process.env.JIRA_API_TOKEN!,
  projectKey: process.env.JIRA_PROJECT_KEY,
  transitions: { done: 'Done', closed: "Won't Do" }, // internal status -> Jira transition name
});

const issue = await jira.createIssue(
  { title: 'Follow up', description: 'From meeting' },
  { approved: true, approvedBy: userId },
);
await github.updateStatus('acme/app#12', 'in_progress', { approved: true, approvedBy: userId });
```

Status mapping:

| Internal      | GitHub                                            | Jira                     |
| ------------- | ------------------------------------------------- | ------------------------ |
| `open`        | open (in-progress label removed)                  | transition `To Do`       |
| `in_progress` | open + label `status: in-progress` (configurable) | transition `In Progress` |
| `done`        | closed, `state_reason=completed`                  | transition `Done`        |
| `closed`      | closed, `state_reason=not_planned`                | transition `Won't Do`    |

Jira transitions are matched by transition name or target status name (case-insensitive); override with `transitions`. Jira reads map status category (`new`/`indeterminate`/`done`); a done category whose resolution/status looks like "Won't Do / Cancelled / Declined / Duplicate" maps to `closed`.

## GitHub webhooks

```ts
import {
  verifyGitHubWebhook,
  InMemoryDeliveryStore,
  mapGitHubIssueEvent,
} from '@meetops/integrations';

const store = new InMemoryDeliveryStore(); // use a Redis-backed DeliveryStore with >1 replica
const result = await verifyGitHubWebhook({
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
  rawBody, // exact raw bytes of the request body — do NOT JSON.stringify a parsed body
  headers: req.headers,
  deliveryStore: store,
});
if (!result.ok) return reply.code(result.status).send({ error: result.reason });
const change = mapGitHubIssueEvent(result.event, result.payload); // null => ignore
```

- Signature: HMAC-SHA256 of the raw body vs `X-Hub-Signature-256` (`sha256=<hex>`), compared with `crypto.timingSafeEqual` after a length check.
- Replay protection: `X-GitHub-Delivery` recorded via `DeliveryStore.markIfNew(id, ttlSeconds)` (default TTL 24h) only **after** the signature is valid. Redis implementation later: `SET key 1 NX EX ttl`.
- Failure reasons → HTTP status: `missing_signature|malformed_signature|invalid_signature` 401, `missing_delivery_id|invalid_payload` 400, `replayed_delivery` 409, `missing_secret` 500.
- `mapGitHubIssueEvent` handles `issues` events `opened`, `reopened`, `closed` (completed/not_planned), `labeled`/`unlabeled` (in-progress label only). Everything else returns `null`. Inbound sync never triggers outbound writes.

### Webhook secret handling

- Generate a high-entropy secret (e.g. `openssl rand -hex 32`), store it only in the secret manager, configure the same value in the GitHub App / repo webhook settings.
- Never log the secret, the signature header, or raw bodies. Rotate by deploying the new secret and updating GitHub at the same time (brief failures are retried by GitHub redelivery).

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

| Name                    | Used for                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`          | GitHub App installation token or fine-grained PAT (caller passes to `GitHubIssuesProvider`) |
| `GITHUB_DEFAULT_REPO`   | Optional default `owner/repo`                                                               |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret                                                                         |
| `JIRA_BASE_URL`         | `https://<site>.atlassian.net`                                                              |
| `JIRA_EMAIL`            | Service account email                                                                       |
| `JIRA_API_TOKEN`        | Atlassian API token                                                                         |
| `JIRA_PROJECT_KEY`      | Default project key                                                                         |

This package does not read env itself; the application wires these values in.

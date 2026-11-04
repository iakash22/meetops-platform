import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime, SafeDisplayText } from '../common.js';
import { IntegrationProvider } from '../domain/task.js';
import { HttpsUrl } from '../domain/media.js';
import { INTEGRATION_CONNECTION_STATES, INTEGRATION_STATUSES } from '../constants.js';

export {
  INTEGRATION_CONNECTION_STATES,
  INTEGRATION_ERROR_REASONS,
  INTEGRATION_PATHS,
  INTEGRATION_STATE_TTL_SECONDS,
  INTEGRATION_STATUSES,
  INTEGRATION_WEBHOOK_MAX_BYTES,
  REDACT_CONDITIONAL_KEYS,
} from '../constants.js';

const strict = { additionalProperties: false } as const;

export const IntegrationStatus = Type.Union(INTEGRATION_STATUSES.map((s) => Type.Literal(s)));
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/**
 * v0.7.0: a connected integration, as returned to clients. **Never** carries access/refresh tokens, the webhook
 * secret, the token key id or ciphertext (ADR-008): those stay server-side, encrypted at rest.
 */
export const Integration = Type.Object(
  {
    id: Id,
    organizationId: Id,
    provider: IntegrationProvider,
    status: IntegrationStatus,
    /** Jira site name or GitHub account/org login. */
    displayName: SafeDisplayText({ maxLength: 200, trimmed: true }),
    /** Jira cloudId or GitHub installation id, as a string. */
    externalAccountId: Type.String({ minLength: 1, maxLength: 255 }),
    connectedById: Id,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  strict,
);
export type Integration = Static<typeof Integration>;

export const IntegrationList = Type.Object(
  { items: Type.Array(Integration, { maxItems: 50 }) },
  strict,
);
export type IntegrationList = Static<typeof IntegrationList>;

/**
 * v0.12.0: GET /orgs/:organizationId/integrations/providers. One entry per supported provider. `configured` is
 * false when ops has not set the provider app on this deployment (connect would return 503). `integration` is the
 * most recent non-revoked connection (active or error), else the latest revoked one, else absent. Never carries secrets.
 */
export const IntegrationConnectionState = Type.Union(
  INTEGRATION_CONNECTION_STATES.map((s) => Type.Literal(s)),
);
export type IntegrationConnectionState = (typeof INTEGRATION_CONNECTION_STATES)[number];
export const IntegrationProviderStatus = Type.Object(
  {
    provider: IntegrationProvider,
    configured: Type.Boolean(),
    connectionStatus: IntegrationConnectionState,
    integration: Type.Optional(Integration),
  },
  strict,
);
export type IntegrationProviderStatus = Static<typeof IntegrationProviderStatus>;
export const IntegrationProviderList = Type.Object(
  { items: Type.Array(IntegrationProviderStatus, { maxItems: 10 }) },
  strict,
);
export type IntegrationProviderList = Static<typeof IntegrationProviderList>;

export const IntegrationParams = Type.Object({ organizationId: Id, integrationId: Id }, strict);
export type IntegrationParams = Static<typeof IntegrationParams>;

/** v0.12.0: allowed `returnTo` web-app path (see ConnectIntegrationRequest). */
export const RETURN_TO_PATTERN =
  '^(?!.*//)(?![^?]*/\\.{1,2}(?:/|\\?|$))(?!.*%(?:2[eEfF]|5[cC]))/[A-Za-z0-9/_.~?=&%-]*$';

/**
 * POST /orgs/:organizationId/integrations/connect. `returnTo` is a web-app path (not a URL) the callback redirects to
 * after success; it must start with a single `/`.
 */
export const ConnectIntegrationRequest = Type.Object(
  {
    provider: IntegrationProvider,
    returnTo: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 512,
        // v0.12.0 (#282 L-2): single leading `/`, no `//` anywhere, no `.`/`..` path segments, and no encoded
        // `.`, `/` or `\` (%2e, %2f, %5c) that a client router could decode into one of those.
        pattern: RETURN_TO_PATTERN,
      }),
    ),
  },
  strict,
);
export type ConnectIntegrationRequest = Static<typeof ConnectIntegrationRequest>;

/** The provider authorize (Jira) or App install (GitHub) URL, carrying the opaque state. The PKCE verifier stays server-side. */
export const ConnectIntegrationResponse = Type.Object(
  { authorizeUrl: HttpsUrl, expiresAt: IsoDateTime },
  strict,
);
export type ConnectIntegrationResponse = Static<typeof ConnectIntegrationResponse>;

const OAuthState = Type.String({ minLength: 43, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' });

/**
 * GET /integrations/:provider/callback. Jira: `code` + `state` (or `error`). GitHub App: `installation_id`,
 * `setup_action` + `state`. The installation id is untrusted until verified with the App JWT (ADR-008).
 */
export const IntegrationCallbackQuery = Type.Object(
  {
    state: OAuthState,
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    installation_id: Type.Optional(Type.String({ pattern: '^[0-9]{1,20}$' })),
    setup_action: Type.Optional(
      Type.Union([Type.Literal('install'), Type.Literal('update'), Type.Literal('request')]),
    ),
    error: Type.Optional(Type.String({ maxLength: 200 })),
    error_description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  strict,
);
export type IntegrationCallbackQuery = Static<typeof IntegrationCallbackQuery>;
export const IntegrationCallbackParams = Type.Object({ provider: IntegrationProvider }, strict);
export type IntegrationCallbackParams = Static<typeof IntegrationCallbackParams>;

export const WebhookParams = Type.Object(
  { provider: IntegrationProvider, integrationId: Id },
  strict,
);
export type WebhookParams = Static<typeof WebhookParams>;
/** 202 for a verified, first-seen delivery. Duplicates get 409 REPLAYED_DELIVERY; bad signatures 401. */
export const WebhookAcceptedResponse = Type.Object({ received: Type.Literal(true) }, strict);
export type WebhookAcceptedResponse = Static<typeof WebhookAcceptedResponse>;

/**
 * POST /orgs/:organizationId/tasks/:taskId/integration-issues. Creates the external issue for an accepted task.
 * `approvalId` must reference an approved TaskApproval/WriteApproval in the same org whose payload hash matches the
 * canonical create operation; otherwise 403 APPROVAL_REQUIRED. Non-idempotent: a 5xx/timeout is surfaced, not retried
 * (ADR-007). A task already linked to this integration -> 409 CONFLICT.
 */
export const PushTaskIssueRequest = Type.Object(
  {
    integrationId: Id,
    approvalId: Id,
    /** GitHub `owner/repo` or Jira project key. */
    target: Type.String({
      minLength: 1,
      maxLength: 200,
      pattern: '^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+|[A-Z][A-Z0-9_]{0,19})$',
    }),
  },
  strict,
);
export type PushTaskIssueRequest = Static<typeof PushTaskIssueRequest>;
export const PushTaskIssueParams = Type.Object({ organizationId: Id, taskId: Id }, strict);
export type PushTaskIssueParams = Static<typeof PushTaskIssueParams>;

/** Async task sync state (see INTEGRATION_PATHS.taskSync). `needs_reconcile`: may exist upstream; never re-sent. */
export const TASK_SYNC_JOB_STATUSES = [
  'queued',
  'creating',
  'succeeded',
  'failed',
  'needs_reconcile',
] as const;
export const TaskSyncJob = Type.Object(
  {
    id: Id,
    taskId: Id,
    integrationId: Id,
    provider: Type.Union([Type.Literal('github'), Type.Literal('jira')]),
    target: Type.String({ maxLength: 200 }),
    status: Type.Union(TASK_SYNC_JOB_STATUSES.map((s) => Type.Literal(s))),
    attempts: Type.Integer({ minimum: 0 }),
    externalId: Type.Optional(Type.String({ maxLength: 255 })),
    externalUrl: Type.Optional(HttpsUrl),
    errorCode: Type.Optional(Type.String({ maxLength: 64 })),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  strict,
);
export type TaskSyncJob = Static<typeof TaskSyncJob>;

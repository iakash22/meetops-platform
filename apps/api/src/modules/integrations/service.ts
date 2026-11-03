import {
  ApprovalRequiredError,
  GitHubAppClient,
  GitHubAppError,
  GitHubAppInstallError,
  GitHubAppInstallFlow,
  GitHubIssuesProvider,
  JiraIssueTrackerProvider,
  JiraOAuthClient,
  JiraOAuthError,
  OAuthStateError,
  OAuthStateManager,
  TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
  TOKEN_REFRESH_LEASE_TTL_MS,
  boundedLeaseOp,
  computeWritePayloadHash,
  createFetchGitHubIssuesClient,
  mapGitHubIssueEvent,
  mapJiraIssueEvent,
  randomUrlToken,
  tokenRefreshLeaseKey,
  verifyGitHubSignature,
  verifyGitHubWebhook,
  verifyJiraWebhook,
  type AuditEvent as IntegrationAuditEvent,
  type CreateIssueInput,
  type HeaderBag,
  type Issue,
  type StatusChange,
} from '@meetops/integrations';
import {
  INTEGRATION_STATE_TTL_SECONDS,
  INTEGRATION_WEBHOOK_MAX_BYTES,
  type IntegrationIssue,
  type IssueStatus,
  type TaskStatus,
} from '@meetops/contracts';
import { DomainError } from '../../shared/domain-error.js';
import { isUniqueViolation } from '../../shared/prisma/context.js';
import {
  ApprovalRequiredHttpError,
  CallbackRejectedError,
  IntegrationNotConfiguredError,
  IntegrationNotConnectedError,
  IntegrationNotFoundError,
  IntegrationsUnavailableError,
  InvalidTargetError,
  IssueAlreadyLinkedError,
  OAuthStateInvalidError,
  ProviderUpstreamError,
  ReplayedDeliveryError,
  TaskNotFoundError,
  WebhookRejectedError,
  WebhookSignatureError,
} from './errors.js';
import type {
  ConnectedProvider,
  ConnectionView,
  IntegrationsRepository,
  RefreshSnapshot,
} from './ports.js';
import {
  putReturnTo,
  signState,
  takeReturnTo,
  verifySignedState,
  type IntegrationsRuntime,
} from './runtime.js';

const DEFAULT_RETURN_TO = '/settings/integrations';
/** Refresh Jira access tokens that expire within this window before using them. */
const REFRESH_SKEW_MS = 120_000;
/** Deadline on the on-demand provider refresh (half the lease TTL at most, like the worker's). */
export const JIRA_REFRESH_TIMEOUT_MS = Math.min(30_000, Math.floor(TOKEN_REFRESH_LEASE_TTL_MS / 2));
/** How long a request waits for another holder's refresh of an already-expired token, and the poll step. */
export const LEASE_WAIT_MS = 5_000;
const LEASE_WAIT_STEP_MS = 250;

export const ISSUE_TO_TASK_STATUS: Record<IssueStatus, TaskStatus> = {
  open: 'todo',
  in_progress: 'in_progress',
  done: 'done',
  closed: 'cancelled',
};

/** Audit hook (DirectoryAccess.record bound to the caller); metadata is never secret. */
export type AuditFn = (
  action: 'integration.connect' | 'integration.issue_push',
  targetId: string,
  metadata: Record<string, string | number | boolean | null>,
) => Promise<void>;

export class IntegrationsService {
  constructor(
    private readonly repo: IntegrationsRepository,
    private readonly rt: IntegrationsRuntime | undefined,
    /** Operational warnings (the app's redacting logger). Never given tokens or secrets. */
    private readonly log?: { warn(obj: object, msg: string): void },
  ) {}

  private runtime(): IntegrationsRuntime {
    if (!this.rt) throw new IntegrationsUnavailableError();
    return this.rt;
  }
  private now() {
    return (this.rt?.now ?? Date.now)();
  }
  redirectUri(provider: ConnectedProvider) {
    return `${this.runtime().apiOrigin}/integrations/${provider}/callback`;
  }
  private jiraClient() {
    const rt = this.runtime();
    if (!rt.jira)
      throw new IntegrationNotConfiguredError('Jira is not configured on this deployment');
    return new JiraOAuthClient({
      clientId: rt.jira.clientId,
      clientSecret: rt.jira.clientSecret,
      redirectUriAllowlist: [this.redirectUri('jira')],
      stateStore: rt.stateStore,
      stateTtlSeconds: INTEGRATION_STATE_TTL_SECONDS,
      ...(rt.fetch ? { fetch: rt.fetch } : {}),
      ...(rt.now ? { now: rt.now } : {}),
    });
  }
  private githubConfig() {
    const gh = this.runtime().github;
    if (!gh) throw new IntegrationNotConfiguredError('GitHub is not configured on this deployment');
    return gh;
  }
  private githubFlow() {
    const rt = this.runtime();
    return new GitHubAppInstallFlow({
      appSlug: this.githubConfig().appSlug,
      redirectUriAllowlist: [this.redirectUri('github')],
      stateStore: rt.stateStore,
      stateTtlSeconds: INTEGRATION_STATE_TTL_SECONDS,
      ...(rt.now ? { now: rt.now } : {}),
    });
  }
  private githubApp() {
    const rt = this.runtime();
    const gh = this.githubConfig();
    return new GitHubAppClient({
      appId: gh.appId,
      clientId: gh.clientId,
      privateKey: gh.privateKey,
      clientSecret: gh.clientSecret,
      ...(rt.fetch ? { fetch: rt.fetch } : {}),
      ...(rt.now ? { now: rt.now } : {}),
    });
  }

  /** Step 1: provider URL carrying the signed, single-use state (PKCE verifier stays server-side for Jira). */
  async connect(input: {
    organizationId: string;
    userId: string;
    provider: ConnectedProvider;
    returnTo?: string;
  }): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const rt = this.runtime();
    const binding = {
      organizationId: input.organizationId,
      userId: input.userId,
      redirectUri: this.redirectUri(input.provider),
    };
    const begun =
      input.provider === 'jira'
        ? await this.jiraClient().beginAuthorization(binding)
        : await this.githubFlow().begin(binding);
    if (input.returnTo)
      await putReturnTo(rt.stateStore, begun.state, input.returnTo, INTEGRATION_STATE_TTL_SECONDS);
    const url = new URL(begun.url);
    url.searchParams.set('state', signState(rt.stateSigningKey, begun.state));
    return {
      authorizeUrl: url.toString(),
      expiresAt: new Date(this.now() + INTEGRATION_STATE_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** The MAC check runs before anything else touches the state store. */
  verifyState(state: string): string {
    const inner = verifySignedState(this.runtime().stateSigningKey, state);
    if (!inner) throw new OAuthStateInvalidError();
    return inner;
  }

  /** Step 2. Returns the web redirect target. `audit` runs only after the connection is stored. */
  async callback(input: {
    provider: ConnectedProvider;
    organizationId: string;
    userId: string;
    innerState: string;
    query: { code?: string; installation_id?: string; setup_action?: string; error?: string };
    audit: AuditFn;
  }): Promise<string> {
    const rt = this.runtime();
    const { provider, organizationId, userId, innerState, query } = input;
    const redirectUri = this.redirectUri(provider);
    const returnTo = (await takeReturnTo(rt.stateStore, innerState)) ?? DEFAULT_RETURN_TO;
    const back = (status: 'connected' | 'denied') => {
      const u = safeReturnUrl(returnTo, rt.webOrigin);
      u.searchParams.set('integration', provider);
      u.searchParams.set('status', status);
      return u.toString();
    };
    try {
      if (query.error) {
        // User denied at the provider: burn the state so it cannot be replayed, then go back to the app.
        await new OAuthStateManager(rt.stateStore, rt.now ? { now: rt.now } : {}).consume(
          innerState,
          {
            provider: provider === 'jira' ? 'jira' : 'github-app',
            organizationId,
            userId,
            redirectUri,
          },
        );
        return back('denied');
      }
      const row =
        provider === 'jira'
          ? await this.completeJira(organizationId, userId, innerState, query.code, redirectUri)
          : await this.completeGitHub(organizationId, userId, innerState, query, redirectUri);
      await input.audit('integration.connect', row.id, {
        provider,
        externalAccountId: row.externalAccountId,
      });
      return back('connected');
    } catch (err) {
      throw mapProviderError(err);
    }
  }

  private async completeJira(
    organizationId: string,
    userId: string,
    state: string,
    code: string | undefined,
    redirectUri: string,
  ) {
    const conn = await this.jiraClient().completeAuthorization({
      state,
      code,
      organizationId,
      userId,
      redirectUri,
    });
    if (!conn.cloudId || !conn.siteUrl)
      throw new CallbackRejectedError('Authorize exactly one Jira site');
    return this.repo.upsert(organizationId, {
      provider: 'jira',
      displayName: new URL(conn.siteUrl).host,
      externalAccountId: conn.cloudId,
      connectedById: userId,
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      webhookSecret: randomUrlToken(32),
      accessTokenExpiresAt: new Date(conn.expiresAt),
    });
  }

  private async completeGitHub(
    organizationId: string,
    userId: string,
    state: string,
    q: { code?: string; installation_id?: string; setup_action?: string },
    redirectUri: string,
  ) {
    const done = await this.githubFlow().complete({
      state,
      installationId: q.installation_id,
      setupAction: q.setup_action,
      organizationId,
      userId,
      redirectUri,
    });
    // installation_id is untrusted: the installing user must be able to see it, and the App must own it.
    if (!q.code) throw new CallbackRejectedError('GitHub did not return a user authorization code');
    const app = this.githubApp();
    if (!(await app.userCanAccessInstallation(q.code, done.installationId)))
      throw new CallbackRejectedError('The installation is not accessible to this user');
    const inst = await app.getInstallation(done.installationId);
    const tok = await app.createInstallationToken(done.installationId);
    return this.repo.upsert(organizationId, {
      provider: 'github',
      displayName: inst.accountLogin,
      externalAccountId: inst.id,
      connectedById: userId,
      accessToken: tok.token,
      refreshToken: null,
      // GitHub App webhooks use the App-wide secret; the per-connection value is kept for parity.
      webhookSecret: randomUrlToken(32),
      accessTokenExpiresAt: tok.expiresAt,
    });
  }

  /**
   * App-wide GitHub webhook (POST /webhooks/github). Checks the HMAC with the App webhook secret before any
   * lookup, then routes by payload.installation.id through the definer routing function, re-enters RLS per
   * org and applies the status change. The install is single-account ("Only on this account"), but nothing
   * here assumes it: every live connection of that installation (max 10) gets the update.
   */
  async githubAppWebhook(input: {
    rawBody: Buffer;
    headers: HeaderBag;
    /** Called once the App HMAC has been verified and before any lookup (rate-limit charging). */
    onSignatureVerified?: () => Promise<void>;
  }): Promise<number> {
    const rt = this.runtime();
    const gh = rt.github;
    if (!gh) throw new WebhookSignatureError();
    const secret = await gh.webhookSecret();
    const h = input.headers;
    const sig =
      typeof Headers !== 'undefined' && h instanceof Headers
        ? (h.get('x-hub-signature-256') ?? undefined)
        : (h as Record<string, string | string[] | undefined>)['x-hub-signature-256'];
    const pre = verifyGitHubSignature(
      secret,
      input.rawBody,
      typeof sig === 'string' ? sig : undefined,
    );
    // missing/malformed/invalid signature are all 401, and the check runs before any database lookup.
    if (pre) throw webhookFailure(401);
    await input.onSignatureVerified?.();
    let targets: { organizationId: string; id: string }[] = [];
    const r = await verifyGitHubWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      deliveryStore: rt.deliveryStore,
      maxBodyBytes: INTEGRATION_WEBHOOK_MAX_BYTES,
      secretResolver: {
        resolve: async (ref) => {
          if (!ref.installationId) return null;
          targets = await this.repo.resolveByExternalAccount('github', ref.installationId);
          const first = targets[0];
          return first
            ? { organizationId: first.organizationId, integrationId: first.id, secret }
            : null;
        },
      },
    });
    if (!r.ok) throw webhookFailure(r.status);
    let applied = 0;
    for (const t of targets) {
      const change = mapGitHubIssueEvent(r.event, r.payload, {
        organizationId: t.organizationId,
        integrationId: t.id,
      });
      if (!change) continue;
      applied += await this.repo.applyIssueStatus(t.organizationId, {
        integrationId: t.id,
        provider: 'github',
        externalId: change.externalId,
        taskStatus: ISSUE_TO_TASK_STATUS[change.status],
      });
    }
    return applied;
  }

  /** Verifies, de-duplicates and applies a webhook delivery. No session; the org comes from the routing function. */
  async webhook(input: {
    provider: ConnectedProvider;
    integrationId: string;
    rawBody: Buffer;
    headers: HeaderBag;
  }): Promise<number> {
    const rt = this.runtime();
    const { provider, integrationId } = input;
    const organizationId = await this.repo.resolveOrganization(provider, integrationId);
    // Unknown and revoked ids look exactly like a bad signature (no existence oracle).
    if (!organizationId) throw new WebhookSignatureError();
    const conn = await this.repo.get(organizationId, integrationId);
    if (!conn) throw new WebhookSignatureError();
    const ctx = { organizationId, integrationId };
    let change: StatusChange | null;
    if (provider === 'github') {
      const gh = rt.github;
      if (!gh) throw new WebhookSignatureError();
      const r = await verifyGitHubWebhook({
        rawBody: input.rawBody,
        headers: input.headers,
        deliveryStore: rt.deliveryStore,
        maxBodyBytes: INTEGRATION_WEBHOOK_MAX_BYTES,
        secretResolver: {
          resolve: async (ref) =>
            ref.installationId === conn.externalAccountId
              ? { ...ctx, secret: await gh.webhookSecret() }
              : null,
        },
      });
      if (!r.ok) throw webhookFailure(r.status);
      change = mapGitHubIssueEvent(r.event, r.payload, ctx);
    } else {
      const secrets = await this.repo.readSecrets(organizationId, integrationId);
      if (!secrets) throw new WebhookSignatureError();
      const r = await verifyJiraWebhook({
        secret: secrets.webhookSecret,
        integrationId,
        rawBody: input.rawBody,
        headers: input.headers,
        deliveryStore: rt.deliveryStore,
        maxBodyBytes: INTEGRATION_WEBHOOK_MAX_BYTES,
        ...(rt.now ? { now: rt.now } : {}),
      });
      if (!r.ok) throw webhookFailure(r.status);
      change = mapJiraIssueEvent(r.payload, ctx);
    }
    if (!change) return 0;
    return this.repo.applyIssueStatus(organizationId, {
      integrationId,
      provider,
      externalId: change.externalId,
      taskStatus: ISSUE_TO_TASK_STATUS[change.status],
    });
  }

  /** Creates the external issue for an approved task and stores the link (ADR-007: never retried on 5xx). */
  async pushIssue(input: {
    organizationId: string;
    taskId: string;
    integrationId: string;
    approvalId: string;
    target: string;
    audit: AuditFn;
  }): Promise<IntegrationIssue> {
    this.runtime();
    const { organizationId, taskId, integrationId } = input;
    const conn = await this.repo.get(organizationId, integrationId);
    if (!conn) throw new IntegrationNotFoundError();
    if (conn.status !== 'active') throw new IntegrationNotConnectedError();
    const provider = conn.provider;
    if ((provider === 'github') !== input.target.includes('/')) throw new InvalidTargetError();
    const task = await this.repo.getTask(organizationId, taskId);
    if (!task) throw new TaskNotFoundError();
    if (await this.repo.hasIssueLink(organizationId, taskId, integrationId))
      throw new IssueAlreadyLinkedError();
    const approval = await this.repo.getApproval(organizationId, input.approvalId);
    if (
      !approval ||
      approval.decision !== 'approved' ||
      !approval.reviewerId ||
      approval.extractedTaskId !== task.extractedTaskId
    )
      throw new ApprovalRequiredHttpError();

    const issueInput: CreateIssueInput = {
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
      project: input.target,
      externalRef: `meetops:task:${task.id}`,
    };
    // TaskApproval has no payload-hash column yet: the hash is computed server-side over the canonical write.
    const payloadHash = computeWritePayloadHash(
      'createIssue',
      { provider, organizationId, integrationId },
      issueInput,
    );
    const writeApproval = {
      approvalId: approval.id,
      organizationId,
      approverUserId: approval.reviewerId,
      payloadHash,
    };
    const approvals = {
      verify: async () => {
        const again = await this.repo.getApproval(organizationId, approval.id);
        return (
          again?.decision === 'approved' &&
          !(await this.repo.hasIssueLink(organizationId, taskId, integrationId))
        );
      },
    };
    const audit = {
      record: (e: IntegrationAuditEvent) =>
        input.audit('integration.issue_push', integrationId, {
          phase: e.phase,
          provider,
          taskId,
          approvalId: e.approvalId ?? null,
          externalId: e.externalId ?? null,
          error: e.error ?? null,
        }),
    };
    let issue: Issue;
    try {
      issue = await this.createIssue(conn, issueInput, writeApproval, approvals, audit);
    } catch (err) {
      if (err instanceof ApprovalRequiredError) throw new ApprovalRequiredHttpError();
      throw mapProviderError(err);
    }
    try {
      return await this.repo.createIssueLink(organizationId, {
        taskId,
        integrationId,
        provider,
        externalId: issue.key,
        ...(issue.url.startsWith('https://') ? { externalUrl: issue.url } : {}),
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new IssueAlreadyLinkedError();
      throw err;
    }
  }

  private async createIssue(
    conn: ConnectionView,
    input: CreateIssueInput,
    approval: {
      approvalId: string;
      organizationId: string;
      approverUserId: string;
      payloadHash: string;
    },
    approvals: { verify: () => Promise<boolean> },
    audit: { record: (e: IntegrationAuditEvent) => Promise<void> },
  ): Promise<Issue> {
    const rt = this.runtime();
    const ctx = { organizationId: conn.organizationId, integrationId: conn.id };
    if (conn.provider === 'github') {
      const app = this.githubApp();
      const p = new GitHubIssuesProvider({
        ...ctx,
        approvals,
        audit,
        credentials: {
          resolve: async () => ({
            kind: 'github',
            token: (await app.createInstallationToken(conn.externalAccountId)).token,
          }),
        },
        clientFactory: (token) =>
          createFetchGitHubIssuesClient(token, rt.fetch ? { fetch: rt.fetch } : {}),
      });
      return p.createIssue(input, approval);
    }
    // One token per push: the provider resolves credentials per request and a refresh rotates the pair.
    let token: Promise<string> | undefined;
    const p = new JiraIssueTrackerProvider({
      ...ctx,
      approvals,
      audit,
      baseUrl: `https://api.atlassian.com/ex/jira/${conn.externalAccountId}`,
      siteUrl: `https://${conn.displayName}`,
      credentials: {
        resolve: async () => ({
          kind: 'jira-oauth',
          accessToken: await (token ??= this.jiraAccessToken(conn)),
        }),
      },
      ...(rt.fetch ? { fetch: rt.fetch } : {}),
    });
    return p.createIssue(input, approval);
  }

  /**
   * The stored Jira access token, refreshed (rotating) first when it is about to expire. Same guard as the worker
   * sweep (#354/#375): the refresh runs under the per-connection Redis lease (tokenRefreshLeaseKey, shared with the
   * worker so the rotating grant is never refreshed twice at once) and the result is saved with a compare-and-swap
   * on the fence from readForRefresh, never via `upsert`. A newer save (worker or another request) or a disconnect
   * moves the fence, so a stale refresh loses: it cannot overwrite newer tokens or reactivate a revoked connection.
   */
  async jiraAccessToken(conn: ConnectionView): Promise<string> {
    const snap = await this.repo.readForRefresh(conn.organizationId, conn.id);
    if (!snap || snap.status !== 'active') throw new IntegrationNotConnectedError();
    if (!this.needsRefresh(snap)) return snap.secrets.accessToken;
    const rt = this.runtime();
    const lease = rt.tokenRefreshLease;
    const key = tokenRefreshLeaseKey(conn.organizationId, conn.id);
    let leaseToken: string | null = null;
    if (lease) {
      try {
        leaseToken = await boundedLeaseOp(
          lease.acquire(key, TOKEN_REFRESH_LEASE_TTL_MS),
          TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
        );
      } catch {
        // Fail closed: never refresh a rotating grant without the lease (transient 502; nothing was called).
        throw new ProviderUpstreamError();
      }
      if (leaseToken === null) return this.awaitOtherRefresh(conn);
    }
    try {
      // Re-read under the lease: another holder may have refreshed (or a disconnect landed) since the first read.
      const cur = await this.repo.readForRefresh(conn.organizationId, conn.id);
      if (!cur || cur.status !== 'active') throw new IntegrationNotConnectedError();
      if (!this.needsRefresh(cur)) return cur.secrets.accessToken;
      const t = await this.refreshWithDeadline(cur.secrets.refreshToken as string);
      if (lease && leaseToken !== null) {
        // Renew right before the write; a lost lease is not fatal because the save below is fenced anyway,
        // but it means the refresh outlived the lease (or Redis is failing), so say so (#378 L3).
        const confirmed = await boundedLeaseOp(
          lease.confirm(key, leaseToken, TOKEN_REFRESH_LEASE_TTL_MS),
          TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
        ).catch((err: unknown) => (err instanceof Error ? err.name : 'error'));
        if (confirmed !== true)
          this.log?.warn(
            {
              integrationId: conn.id,
              provider: 'jira',
              reason: confirmed === false ? 'lease_lost' : `confirm_failed:${confirmed}`,
            },
            'jira token refresh lease could not be confirmed before save; relying on the fenced save',
          );
      }
      const saved = await this.repo.saveRefreshedTokens(
        conn.organizationId,
        conn.id,
        {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          webhookSecret: cur.secrets.webhookSecret,
          accessTokenExpiresAt: new Date(t.expiresAt),
        },
        cur.fence,
      );
      if (saved === 'saved') return t.accessToken;
      // Superseded: a newer write won (keep it) or the connection was disconnected (stay revoked).
      const after = await this.repo.readForRefresh(conn.organizationId, conn.id);
      if (!after || after.status !== 'active') throw new IntegrationNotConnectedError();
      return after.secrets.accessToken;
    } finally {
      if (lease && leaseToken !== null)
        await boundedLeaseOp(
          lease.release(key, leaseToken),
          TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
        ).catch(() => false);
    }
  }

  private needsRefresh(s: RefreshSnapshot): boolean {
    const exp = s.accessTokenExpiresAt?.getTime();
    return exp !== undefined && exp - REFRESH_SKEW_MS <= this.now() && !!s.secrets.refreshToken;
  }

  /** Bounded provider refresh: aborts the token request and fails with a 502 well inside the lease TTL. */
  private async refreshWithDeadline(refreshToken: string) {
    const ac = new AbortController();
    // JiraOAuthClient's own 10 s request timeout is the effective limit; this 30 s abort is a backstop for future clients without one.
    const timer = setTimeout(() => ac.abort(), JIRA_REFRESH_TIMEOUT_MS);
    try {
      return await this.jiraClient().refresh(refreshToken, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Someone else (the worker sweep or another request) holds the refresh lease. Use the stored token while it has
   * not actually expired (the skew window is only a head start); otherwise wait briefly for their save to land.
   */
  private async awaitOtherRefresh(conn: ConnectionView): Promise<string> {
    const deadline = this.now() + LEASE_WAIT_MS;
    for (;;) {
      const s = await this.repo.readForRefresh(conn.organizationId, conn.id);
      if (!s || s.status !== 'active') throw new IntegrationNotConnectedError();
      const exp = s.accessTokenExpiresAt?.getTime();
      if (!this.needsRefresh(s) || exp === undefined || exp > this.now())
        return s.secrets.accessToken;
      if (this.now() >= deadline) throw new ProviderUpstreamError();
      await (this.rt?.sleep ?? defaultSleep)(LEASE_WAIT_STEP_MS);
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function webhookFailure(status: number) {
  if (status === 409) return new ReplayedDeliveryError();
  if (status === 400 || status === 413) return new WebhookRejectedError(status);
  return new WebhookSignatureError();
}

/** Provider/library errors -> HTTP. State problems are 400; anything upstream is a sanitized 502. */
export function mapProviderError(err: unknown): unknown {
  if (err instanceof OAuthStateError) return new OAuthStateInvalidError();
  if (err instanceof GitHubAppInstallError)
    return new CallbackRejectedError('Invalid GitHub installation callback');
  if (
    err instanceof JiraOAuthError &&
    (err.code === 'invalid_code' || err.code === 'missing_verifier')
  )
    return new CallbackRejectedError('Invalid authorization code');
  if (err instanceof GitHubAppError && err.code === 'invalid_code')
    return new CallbackRejectedError('Invalid authorization code');
  if (err instanceof DomainError) return err;
  return new ProviderUpstreamError();
}

/**
 * #282 L-2 defense in depth (the contract pattern already rejects these): resolve `returnTo` against the web origin
 * and fall back to the default page unless the result is same-origin and its path has no `//`, `.` or `..`.
 */
export function safeReturnUrl(returnTo: string, webOrigin: string): URL {
  const origin = new URL(webOrigin).origin;
  const fallback = new URL(DEFAULT_RETURN_TO, origin);
  if (!returnTo.startsWith('/') || returnTo.includes('//') || returnTo.includes('\\'))
    return fallback;
  const path = returnTo.split('?')[0] ?? '';
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return fallback;
  let u: URL;
  try {
    u = new URL(returnTo, origin);
  } catch {
    return fallback;
  }
  if (u.origin !== origin || u.pathname.startsWith('//') || u.username || u.password)
    return fallback;
  return u;
}

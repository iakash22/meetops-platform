import { Value } from '@sinclair/typebox/value';
import { TASK_SYNC_QUEUE, TaskSyncJobPayload } from '@meetops/contracts';
import {
  createIntegrationConnectionRepository,
  createTaskSyncRepository,
  getPrismaClient,
  withOrganizationContext,
} from '@meetops/database';
import { createWorker } from '@meetops/queue';
import { LocalKeyProvider, TokenCipher, type IntegrationCredentials } from '@meetops/integrations';
import { parseKek, tokenRefreshProvidersFromEnv } from './bootstrap.js';
import {
  processTaskSyncJob,
  type TaskSyncConnection,
  type TaskSyncDeps,
  type TaskSyncLog,
  type TaskSyncLookups,
} from './task-sync.js';

export class TaskSyncEnvError extends Error {}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['', 'false', '0', 'no', 'off']);
/** Jira access tokens this close to expiry are not used; the token-refresh sweep rotates them (single writer). */
const JIRA_EXPIRY_SKEW_MS = 120_000;

/**
 * TASK_SYNC_ENABLED (default off, same flag as the API route). When on, INTEGRATIONS_TOKEN_KEK must decode to 32
 * bytes (the key the API sealed the connection tokens with) or startup fails closed. Errors name keys only.
 */
export function loadTaskSyncEnv(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; kek?: Buffer } {
  const raw = (env.TASK_SYNC_ENABLED ?? '').trim().toLowerCase();
  if (!TRUE.has(raw) && !FALSE.has(raw)) throw new TaskSyncEnvError('TASK_SYNC_ENABLED must be a boolean');
  if (!TRUE.has(raw)) return { enabled: false };
  const kek = parseKek(env);
  if (!kek) throw new TaskSyncEnvError('INTEGRATIONS_TOKEN_KEK must be 32 bytes (base64) when task sync is enabled');
  return { enabled: true, kek };
}

/** Org-scoped (forced RLS) Prisma reads for the job. */
export function createPrismaTaskSyncLookups(
  connections: ReturnType<typeof createIntegrationConnectionRepository>,
): TaskSyncLookups {
  const db = getPrismaClient();
  return {
    async connection(organizationId, integrationId) {
      const c = await connections.get(organizationId, integrationId);
      if (!c || (c.provider !== 'github' && c.provider !== 'jira')) return null;
      return {
        id: c.id,
        organizationId: c.organizationId,
        provider: c.provider,
        status: c.status,
        externalAccountId: c.externalAccountId,
        displayName: c.displayName,
      };
    },
    task: (organizationId, taskId) =>
      withOrganizationContext(
        organizationId,
        (tx) =>
          tx.task.findFirst({
            where: { id: taskId, organizationId, deletedAt: null },
            select: { id: true, title: true, description: true, extractedTaskId: true },
          }),
        { client: db },
      ),
    approval: (organizationId, approvalId) =>
      withOrganizationContext(
        organizationId,
        (tx) =>
          tx.taskApproval.findFirst({
            where: { id: approvalId, organizationId },
            select: { id: true, extractedTaskId: true, reviewerId: true, decision: true },
          }),
        { client: db },
      ),
    hasIssueLink: (organizationId, taskId, integrationId) =>
      withOrganizationContext(
        organizationId,
        async (tx) =>
          (await tx.integrationIssue.count({ where: { organizationId, taskId, integrationId } })) > 0,
        { client: db },
      ),
  };
}

/** Production deps: shared-KEK cipher, Prisma stores, GitHub App / stored Jira token. No provider fallback. */
export function createTaskSyncDeps(kek: Buffer, log: TaskSyncLog): TaskSyncDeps {
  const connections = createIntegrationConnectionRepository({
    cipher: new TokenCipher(new LocalKeyProvider({ shared: kek }, 'shared')),
  });
  const providers = tokenRefreshProvidersFromEnv();
  return {
    jobs: createTaskSyncRepository(),
    lookups: createPrismaTaskSyncLookups(connections),
    async credentials(conn: TaskSyncConnection): Promise<IntegrationCredentials> {
      if (conn.provider === 'github') {
        if (!providers.github) throw new Error('GitHub App is not configured on this worker');
        const t = await providers.github.createInstallationToken(conn.externalAccountId);
        return { kind: 'github', token: t.token };
      }
      const rec = await connections.get(conn.organizationId, conn.id);
      const exp = rec?.accessTokenExpiresAt?.getTime();
      if (exp !== undefined && exp - JIRA_EXPIRY_SKEW_MS <= Date.now())
        throw new Error('Jira access token is expiring; waiting for the token-refresh sweep');
      const secrets = await connections.readSecrets(conn.organizationId, conn.id);
      if (!secrets) throw new Error('Jira connection has no stored token');
      return { kind: 'jira-oauth', accessToken: secrets.accessToken };
    },
    audit: async (e) => {
      log.info(
        { audit: { phase: e.phase, provider: e.provider, organizationId: e.organizationId, integrationId: e.integrationId, externalId: e.externalId ?? null, error: e.error ?? null } },
        'task sync write audit',
      );
    },
    log,
  };
}

export type TaskSyncRegistration =
  | { registered: false; reason: 'disabled' }
  | { registered: true; close: () => Promise<void> };

export interface RegisterTaskSyncOptions {
  env: { enabled: boolean; kek?: Buffer };
  log: TaskSyncLog;
  /** Test seams. */
  buildDeps?: (kek: Buffer) => TaskSyncDeps;
  createWorker?: (
    name: string,
    processor: (job: { data: unknown }) => Promise<unknown>,
  ) => { close: () => Promise<void> };
}

/** BullMQ consumer for TASK_SYNC_QUEUE in apps/worker main(). Payloads are schema-checked (ids only). */
export async function registerTaskSyncWorker(opts: RegisterTaskSyncOptions): Promise<TaskSyncRegistration> {
  if (!opts.env.enabled || !opts.env.kek) return { registered: false, reason: 'disabled' };
  const deps = opts.buildDeps?.(opts.env.kek) ?? createTaskSyncDeps(opts.env.kek, opts.log);
  const factory =
    opts.createWorker ??
    ((name: string, p: (job: { data: unknown }) => Promise<unknown>) =>
      createWorker(name, p, { concurrency: 2 }));
  const worker = factory(TASK_SYNC_QUEUE, async (job) => {
    if (!Value.Check(TaskSyncJobPayload, job.data)) {
      opts.log.warn({}, 'task sync payload rejected');
      return 'skipped';
    }
    return processTaskSyncJob(deps, job.data);
  });
  return { registered: true, close: () => worker.close() };
}

import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type IntegrationConnectionStatus } from '@prisma/client';
import { getPrismaClient } from './client.js';
import {
  LEGACY_ORG_CONTEXT_SETTING,
  ORGANIZATION_CONTEXT_SETTING,
  runWithOrganizationContext,
} from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

/**
 * Integration connections (Phase 5, ADR-008). Every call runs in runWithOrganizationContext, so forced RLS
 * binds each row (and its webhook secret) to one organization; other orgs' rows read as null.
 *
 * Secrets are encrypted at rest through a cipher port that @meetops/integrations' TokenCipher satisfies
 * structurally (envelope `v1.<keyId>.<wrappedKey>.<iv|ct|tag>`, AAD = org + integration id). The id is minted
 * here before encrypting so the AAD binds the ciphertext to its row. Plaintext is only returned by the explicit
 * `readSecrets` / `resolveWebhookSecret` calls and never appears in records, errors or logs.
 */
export interface IntegrationSecretCipher {
  encrypt(
    plaintext: string,
    ctx: { organizationId: string; integrationId: string },
  ): Promise<string>;
  decrypt(
    envelope: string,
    ctx: { organizationId: string; integrationId: string },
  ): Promise<string>;
}

export type IntegrationConnectionStatusValue = IntegrationConnectionStatus;

/** Non-secret view of a connection; matches the contracts `Integration` DTO after date mapping. */
export interface IntegrationConnectionRecord {
  id: string;
  organizationId: string;
  provider: string;
  status: IntegrationConnectionStatus;
  displayName: string;
  externalAccountId: string;
  connectedById: string | null;
  tokenKeyId: string;
  accessTokenExpiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntegrationSecrets {
  accessToken: string;
  refreshToken: string | null;
  webhookSecret: string;
}

export interface UpsertIntegrationConnectionInput {
  provider: string;
  displayName: string;
  externalAccountId: string;
  connectedById?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  webhookSecret: string;
  accessTokenExpiresAt?: Date | null;
}

/** Tokens a refresh produced. The webhook secret is re-sealed alongside so every envelope uses the current key. */
export interface RefreshedIntegrationTokens {
  accessToken: string;
  refreshToken: string | null;
  webhookSecret: string;
  accessTokenExpiresAt: Date | null;
}

/**
 * What the token-refresh sweep reads in ONE query: the record, its decrypted secrets and a fence. The fence is an
 * opaque digest of the stored access-token envelope (every token write re-encrypts it, a disconnect wipes it), so a
 * write fenced on it lands only if nobody saved, reconnected or revoked since the read. Never log it.
 */
export interface IntegrationRefreshSnapshot {
  connection: IntegrationConnectionRecord;
  secrets: IntegrationSecrets;
  fence: string;
}

export type SaveRefreshedTokensResult = 'saved' | 'superseded';

export interface IntegrationConnectionRepositoryOptions extends RepositoryOptions {
  cipher: IntegrationSecretCipher;
}

const ENVELOPE_RE = /^v1\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fenceOf = (envelope: string) => createHash('sha256').update(envelope).digest('base64url');

/**
 * AAD context for the miss-path dummy decrypt. Not a real org or integration; used only so a miss still
 * runs the cipher (same cost class as a hit) and the result is discarded.
 */
const DUMMY_WEBHOOK_DECRYPT_CTX = {
  organizationId: '00000000-0000-4000-8000-000000000000',
  integrationId: '00000000-0000-4000-8000-000000000000',
};

const dummyEnvelopeByCipher = new WeakMap<IntegrationSecretCipher, Promise<string | null>>();

function dummyWebhookEnvelope(cipher: IntegrationSecretCipher): Promise<string | null> {
  let pending = dummyEnvelopeByCipher.get(cipher);
  if (!pending) {
    pending = cipher
      .encrypt('meetops-webhook-timing-dummy', DUMMY_WEBHOOK_DECRYPT_CTX)
      .catch(() => null);
    dummyEnvelopeByCipher.set(cipher, pending);
  }
  return pending;
}

/** Decrypt the webhook envelope, or run a dummy decrypt when there is no row so hits and misses take similar time. */
async function decryptWebhookSecretOrDummy(
  cipher: IntegrationSecretCipher,
  envelope: string | null,
  ctx: { organizationId: string; integrationId: string },
): Promise<string | null> {
  if (envelope) return cipher.decrypt(envelope, ctx);
  const dummy = await dummyWebhookEnvelope(cipher);
  try {
    await cipher.decrypt(dummy ?? 'v1.dummy.timing.placeholder', DUMMY_WEBHOOK_DECRYPT_CTX);
  } catch {
    // Expected when the cipher cannot mint a matching dummy envelope (result is unused).
  }
  return null;
}

function keyIdOf(envelope: string): string {
  const m = ENVELOPE_RE.exec(envelope);
  if (!m?.[1]) throw new Error('cipher returned a value that is not a v1 envelope');
  return m[1];
}

const SELECT = {
  id: true,
  organizationId: true,
  provider: true,
  status: true,
  displayName: true,
  externalAccountId: true,
  connectedById: true,
  tokenKeyId: true,
  accessTokenExpiresAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.IntegrationConnectionSelect;

export function createIntegrationConnectionRepository(
  options: IntegrationConnectionRepositoryOptions,
) {
  const { cipher } = options;
  const run = <T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runWithOrganizationContext(options.client ?? getPrismaClient(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

  const seal = async (
    organizationId: string,
    integrationId: string,
    input: Pick<UpsertIntegrationConnectionInput, 'accessToken' | 'refreshToken' | 'webhookSecret'>,
  ) => {
    const ctx = { organizationId, integrationId };
    const accessTokenEnc = await cipher.encrypt(input.accessToken, ctx);
    const refreshTokenEnc =
      input.refreshToken == null ? null : await cipher.encrypt(input.refreshToken, ctx);
    const webhookSecretEnc = await cipher.encrypt(input.webhookSecret, ctx);
    const tokenKeyId = keyIdOf(accessTokenEnc);
    for (const e of [refreshTokenEnc, webhookSecretEnc]) if (e !== null) keyIdOf(e);
    return { accessTokenEnc, refreshTokenEnc, webhookSecretEnc, tokenKeyId };
  };

  return {
    /**
     * Connect (or reconnect) the provider account. Reconnecting keeps the row id and re-encrypts every secret.
     */
    async upsert(
      organizationId: string,
      input: UpsertIntegrationConnectionInput,
    ): Promise<IntegrationConnectionRecord> {
      return run(organizationId, async (tx) => {
        const existing = await tx.integrationConnection.findUnique({
          where: {
            organizationId_provider_externalAccountId: {
              organizationId,
              provider: input.provider,
              externalAccountId: input.externalAccountId,
            },
          },
          select: { id: true },
        });
        const id = existing?.id ?? randomUUID();
        const sealed = await seal(organizationId, id, input);
        const common = {
          displayName: input.displayName,
          connectedById: input.connectedById ?? null,
          accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
          status: 'active' as const,
          revokedAt: null,
          ...sealed,
        };
        if (existing) {
          return tx.integrationConnection.update({ where: { id }, data: common, select: SELECT });
        }
        return tx.integrationConnection.create({
          data: {
            id,
            organizationId,
            provider: input.provider,
            externalAccountId: input.externalAccountId,
            ...common,
          },
          select: SELECT,
        });
      });
    },

    async get(organizationId: string, id: string): Promise<IntegrationConnectionRecord | null> {
      if (!UUID_RE.test(id)) return null;
      return run(organizationId, (tx) =>
        tx.integrationConnection.findFirst({ where: { id, organizationId }, select: SELECT }),
      );
    },

    async list(organizationId: string): Promise<IntegrationConnectionRecord[]> {
      return run(organizationId, (tx) =>
        tx.integrationConnection.findMany({
          where: { organizationId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: SELECT,
        }),
      );
    },

    /** Decrypt the secrets of one connection (worker/webhook use only). null when not found or revoked. */
    async readSecrets(organizationId: string, id: string): Promise<IntegrationSecrets | null> {
      if (!UUID_RE.test(id)) return null;
      const row = await run(organizationId, (tx) =>
        tx.integrationConnection.findFirst({
          where: { id, organizationId },
          select: { accessTokenEnc: true, refreshTokenEnc: true, webhookSecretEnc: true },
        }),
      );
      // Revoked rows hold no secrets (wiped on disconnect).
      if (!row || row.accessTokenEnc === null || row.webhookSecretEnc === null) return null;
      const ctx = { organizationId, integrationId: id };
      return {
        accessToken: await cipher.decrypt(row.accessTokenEnc, ctx),
        refreshToken:
          row.refreshTokenEnc === null ? null : await cipher.decrypt(row.refreshTokenEnc, ctx),
        webhookSecret: await cipher.decrypt(row.webhookSecretEnc, ctx),
      };
    },

    /** Token-refresh read: record + decrypted secrets + fence from one row read (null when absent or revoked). */
    async readForRefresh(
      organizationId: string,
      id: string,
    ): Promise<IntegrationRefreshSnapshot | null> {
      if (!UUID_RE.test(id)) return null;
      const row = await run(organizationId, (tx) =>
        tx.integrationConnection.findFirst({
          where: { id, organizationId },
          select: {
            ...SELECT,
            accessTokenEnc: true,
            refreshTokenEnc: true,
            webhookSecretEnc: true,
          },
        }),
      );
      if (!row || row.accessTokenEnc === null || row.webhookSecretEnc === null) return null;
      const { accessTokenEnc, refreshTokenEnc, webhookSecretEnc, ...connection } = row;
      const ctx = { organizationId, integrationId: id };
      return {
        connection,
        secrets: {
          accessToken: await cipher.decrypt(accessTokenEnc, ctx),
          refreshToken:
            refreshTokenEnc === null ? null : await cipher.decrypt(refreshTokenEnc, ctx),
          webhookSecret: await cipher.decrypt(webhookSecretEnc, ctx),
        },
        fence: fenceOf(accessTokenEnc),
      };
    },

    /**
     * Persist refreshed tokens, fenced: compare-and-swap on the access-token envelope the refresh started from
     * (`fence` from readForRefresh), and only while the row is still active. 'superseded' means another write
     * (a newer refresh, a reconnect, a revoke or an error mark) landed first and nothing was written. Unlike
     * `upsert` it never changes status or revokedAt, so it cannot resurrect a revoked or errored connection.
     */
    async saveRefreshedTokens(
      organizationId: string,
      id: string,
      tokens: RefreshedIntegrationTokens,
      fence: string,
    ): Promise<SaveRefreshedTokensResult> {
      if (!UUID_RE.test(id)) return 'superseded';
      const sealed = await seal(organizationId, id, tokens);
      return run(organizationId, async (tx) => {
        const row = await tx.integrationConnection.findFirst({
          where: { id, organizationId, status: 'active' },
          select: { accessTokenEnc: true },
        });
        if (!row?.accessTokenEnc || fenceOf(row.accessTokenEnc) !== fence) return 'superseded';
        const n = await tx.integrationConnection.updateMany({
          where: { id, organizationId, status: 'active', accessTokenEnc: row.accessTokenEnc },
          data: { ...sealed, accessTokenExpiresAt: tokens.accessTokenExpiresAt },
        });
        return n.count === 1 ? 'saved' : 'superseded';
      });
    },

    /**
     * Webhook routing: the org owning a live connection, via the integration_connection_org SECURITY DEFINER
     * function (identifiers only). Callers must then re-enter RLS with that org before reading anything else.
     */
    async resolveOrganization(provider: string, id: string): Promise<string | null> {
      if (!UUID_RE.test(id)) return null;
      const db = options.client ?? getPrismaClient();
      const rows = await db.$transaction(
        (tx) => tx.$queryRaw<{ org_id: string | null }[]>`
          SELECT integration_connection_org(${id}::uuid, ${provider}) AS org_id`,
      );
      return rows[0]?.org_id ?? null;
    },

    /**
     * Jira webhook auth: one transaction that resolves the org (SECURITY DEFINER) and reads only
     * `webhookSecretEnc` under that org's RLS. Access and refresh envelopes are not selected or decrypted.
     * A miss still runs a dummy decrypt so the timing is closer to a hit.
     */
    async resolveWebhookSecret(
      provider: string,
      id: string,
    ): Promise<{ organizationId: string; webhookSecret: string } | null> {
      if (!UUID_RE.test(id)) {
        await decryptWebhookSecretOrDummy(cipher, null, DUMMY_WEBHOOK_DECRYPT_CTX);
        return null;
      }
      const db = options.client ?? getPrismaClient();
      const looked = await db.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ org_id: string | null }[]>`
          SELECT integration_connection_org(${id}::uuid, ${provider}) AS org_id`;
        const organizationId = rows[0]?.org_id ?? null;
        if (!organizationId) return null;
        await tx.$executeRaw`SELECT set_config(${ORGANIZATION_CONTEXT_SETTING}, ${organizationId}, true)`;
        await tx.$executeRaw`SELECT set_config(${LEGACY_ORG_CONTEXT_SETTING}, ${organizationId}, true)`;
        const row = await tx.integrationConnection.findFirst({
          where: { id, organizationId },
          select: { webhookSecretEnc: true },
        });
        return { organizationId, webhookSecretEnc: row?.webhookSecretEnc ?? null };
      });
      const webhookSecret = await decryptWebhookSecretOrDummy(
        cipher,
        looked?.webhookSecretEnc ?? null,
        looked
          ? { organizationId: looked.organizationId, integrationId: id }
          : DUMMY_WEBHOOK_DECRYPT_CTX,
      );
      if (!looked || !webhookSecret) return null;
      return { organizationId: looked.organizationId, webhookSecret };
    },

    /**
     * App-wide webhook routing: live connections for a provider account (e.g. a GitHub App installation id), via
     * the integration_connections_by_external_account SECURITY DEFINER function (identifiers only, max 10).
     */
    async resolveByExternalAccount(
      provider: string,
      externalAccountId: string,
    ): Promise<{ organizationId: string; id: string }[]> {
      if (!/^[1-9]\d{0,19}$/.test(externalAccountId) && provider === 'github') return [];
      const db = options.client ?? getPrismaClient();
      const rows = await db.$transaction(
        (tx) => tx.$queryRaw<{ org_id: string; id: string }[]>`
          SELECT org_id, id FROM integration_connections_by_external_account(${provider}, ${externalAccountId})`,
      );
      return rows.map((r) => ({ organizationId: r.org_id, id: r.id }));
    },

    /** Token-refresh sweep: (org, id, provider) of active rows expiring before `before`. Identifiers only. */
    async listDueForRefresh(
      before: Date,
      limit = 100,
    ): Promise<{ organizationId: string; id: string; provider: string }[]> {
      const db = options.client ?? getPrismaClient();
      const rows = await db.$transaction(
        (tx) => tx.$queryRaw<{ org_id: string; id: string; provider: string }[]>`
          SELECT org_id, id, provider
          FROM integration_connections_due_for_refresh(${before}, ${limit}::int)`,
      );
      return rows.map((r) => ({ organizationId: r.org_id, id: r.id, provider: r.provider }));
    },

    /**
     * active <-> error only; use `disconnect` to revoke (it must wipe the secrets in the same write). With `fence`
     * (from readForRefresh) it writes only if the tokens are unchanged since that read, so a stale sweep cannot
     * mark a connection that a newer refresh or a reconnect has already fixed (returns null then).
     */
    async setStatus(
      organizationId: string,
      id: string,
      status: Exclude<IntegrationConnectionStatus, 'revoked'>,
      opts: { fence?: string } = {},
    ): Promise<IntegrationConnectionRecord | null> {
      if ((status as string) === 'revoked')
        throw new Error('Use disconnect() to revoke a connection');
      if (!UUID_RE.test(id)) return null;
      return run(organizationId, async (tx) => {
        const where: Prisma.IntegrationConnectionWhereInput = {
          id,
          organizationId,
          status: { not: 'revoked' },
        };
        if (opts.fence !== undefined) {
          const row = await tx.integrationConnection.findFirst({
            where: { id, organizationId },
            select: { accessTokenEnc: true },
          });
          if (!row?.accessTokenEnc || fenceOf(row.accessTokenEnc) !== opts.fence) return null;
          where.accessTokenEnc = row.accessTokenEnc;
        }
        const n = await tx.integrationConnection.updateMany({ where, data: { status } });
        if (n.count === 0) return null;
        return tx.integrationConnection.findFirst({
          where: { id, organizationId },
          select: SELECT,
        });
      });
    },

    /**
     * Soft disconnect: status revoked + revokedAt, and every ciphertext column wiped to NULL in one UPDATE
     * (the app role has no DELETE). Idempotent; returns the record, or null when not found in this org.
     * Reconnecting through `upsert` re-encrypts fresh secrets onto the same row.
     */
    async disconnect(
      organizationId: string,
      id: string,
    ): Promise<IntegrationConnectionRecord | null> {
      if (!UUID_RE.test(id)) return null;
      return run(organizationId, async (tx) => {
        await tx.integrationConnection.updateMany({
          where: { id, organizationId, status: { not: 'revoked' } },
          data: {
            status: 'revoked',
            revokedAt: new Date(),
            accessTokenEnc: null,
            refreshTokenEnc: null,
            webhookSecretEnc: null,
          },
        });
        return tx.integrationConnection.findFirst({
          where: { id, organizationId },
          select: SELECT,
        });
      });
    },
  };
}

export type IntegrationConnectionRepository = ReturnType<
  typeof createIntegrationConnectionRepository
>;

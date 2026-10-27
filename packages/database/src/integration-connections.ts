import { randomUUID } from 'node:crypto';
import { Prisma, type IntegrationConnectionStatus } from '@prisma/client';
import { getPrismaClient } from './client.js';
import { runWithOrganizationContext } from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

/**
 * Integration connections (Phase 5, ADR-008). Every call runs in runWithOrganizationContext, so forced RLS
 * binds each row (and its webhook secret) to one organization; other orgs' rows read as null.
 *
 * Secrets are encrypted at rest through a cipher port that @meetops/integrations' TokenCipher satisfies
 * structurally (envelope `v1.<keyId>.<wrappedKey>.<iv|ct|tag>`, AAD = org + integration id). The id is minted
 * here before encrypting so the AAD binds the ciphertext to its row. Plaintext is only returned by the explicit
 * `readSecrets` call and never appears in records, errors or logs.
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

export interface IntegrationConnectionRepositoryOptions extends RepositoryOptions {
  cipher: IntegrationSecretCipher;
}

const ENVELOPE_RE = /^v1\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    input: UpsertIntegrationConnectionInput,
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

    /** active <-> error only; use `disconnect` to revoke (it must wipe the secrets in the same write). */
    async setStatus(
      organizationId: string,
      id: string,
      status: Exclude<IntegrationConnectionStatus, 'revoked'>,
    ): Promise<IntegrationConnectionRecord | null> {
      if ((status as string) === 'revoked')
        throw new Error('Use disconnect() to revoke a connection');
      if (!UUID_RE.test(id)) return null;
      return run(organizationId, async (tx) => {
        const n = await tx.integrationConnection.updateMany({
          where: { id, organizationId, status: { not: 'revoked' } },
          data: { status },
        });
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

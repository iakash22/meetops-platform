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

    /** Decrypt the secrets of one connection (worker/webhook use only). null when not found. */
    async readSecrets(organizationId: string, id: string): Promise<IntegrationSecrets | null> {
      if (!UUID_RE.test(id)) return null;
      const row = await run(organizationId, (tx) =>
        tx.integrationConnection.findFirst({
          where: { id, organizationId },
          select: { accessTokenEnc: true, refreshTokenEnc: true, webhookSecretEnc: true },
        }),
      );
      if (!row) return null;
      const ctx = { organizationId, integrationId: id };
      return {
        accessToken: await cipher.decrypt(row.accessTokenEnc, ctx),
        refreshToken:
          row.refreshTokenEnc === null ? null : await cipher.decrypt(row.refreshTokenEnc, ctx),
        webhookSecret: await cipher.decrypt(row.webhookSecretEnc, ctx),
      };
    },

    async setStatus(
      organizationId: string,
      id: string,
      status: IntegrationConnectionStatus,
    ): Promise<IntegrationConnectionRecord | null> {
      if (!UUID_RE.test(id)) return null;
      return run(organizationId, async (tx) => {
        const n = await tx.integrationConnection.updateMany({
          where: { id, organizationId },
          data: { status },
        });
        if (n.count === 0) return null;
        return tx.integrationConnection.findFirst({
          where: { id, organizationId },
          select: SELECT,
        });
      });
    },

    /** Hard-delete (disconnect). Ciphertext goes with the row. Returns false when not found. */
    async remove(organizationId: string, id: string): Promise<boolean> {
      if (!UUID_RE.test(id)) return false;
      return run(organizationId, async (tx) => {
        const n = await tx.integrationConnection.deleteMany({ where: { id, organizationId } });
        return n.count > 0;
      });
    },
  };
}

export type IntegrationConnectionRepository = ReturnType<
  typeof createIntegrationConnectionRepository
>;

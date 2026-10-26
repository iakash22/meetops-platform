import type { AuthTokenAudience, Prisma } from '@prisma/client';
import { getPrismaClient } from './client.js';
import { runWithOrganizationContext } from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

/**
 * ADR-005 A1.2 durable token store (extension today, desktop once ADR-012 is accepted): devices, refresh
 * families and refresh-token hashes. Every call runs in runWithOrganizationContext, so forced RLS limits it to
 * one organization. Only SHA-256 hex hashes are accepted; a malformed hash is rejected before any query, so
 * plaintext tokens can never be written by mistake. Access tokens and pairing codes are not stored here.
 */

export type { AuthTokenAudience };
export const AUTH_TOKEN_AUDIENCES = ['extension', 'desktop'] as const;

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string) => UUID_RE.test(v);

export class AuthTokenHashError extends Error {
  constructor() {
    super('token hash must be a SHA-256 hex digest');
    this.name = 'AuthTokenHashError';
  }
}
const assertHash = (h: string) => {
  if (!HASH_RE.test(h)) throw new AuthTokenHashError();
};

export interface AuthDeviceInput {
  userId: string;
  audience: AuthTokenAudience;
  clientId: string;
  deviceId: string;
  label: string | null;
}

export interface AuthTokenFamilyRecord {
  id: string;
  organizationId: string;
  userId: string;
  audience: AuthTokenAudience;
  scopes: string[];
  createdAt: Date;
  maxExpiresAt: Date;
  revokedAt: Date | null;
  clientId: string;
  deviceId: string;
  deviceLabel: string | null;
}

export interface CreateAuthTokenFamilyInput {
  id: string;
  device: AuthDeviceInput;
  scopes: string[];
  createdAt: Date;
  maxExpiresAt: Date;
}

export type AuthRefreshConsumeResult =
  | { status: 'ok'; familyId: string }
  | { status: 'reused'; familyId: string }
  | { status: 'unknown' };

type Tx = Prisma.TransactionClient;

const FAMILY_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  audience: true,
  scopes: true,
  createdAt: true,
  maxExpiresAt: true,
  revokedAt: true,
  device: { select: { clientId: true, deviceId: true, label: true } },
} as const;

type FamilyRow = Prisma.AuthTokenFamilyGetPayload<{ select: typeof FAMILY_SELECT }>;
const toFamily = ({ device, ...f }: FamilyRow): AuthTokenFamilyRecord => ({
  ...f,
  clientId: device.clientId,
  deviceId: device.deviceId,
  deviceLabel: device.label,
});

export function createAuthTokenRepository(options: RepositoryOptions = {}) {
  const run = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runWithOrganizationContext(options.client ?? getPrismaClient(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

  return {
    /** Upserts the device (by user, audience, client and install id) and creates a family on it. */
    createFamily(organizationId: string, input: CreateAuthTokenFamilyInput): Promise<void> {
      const d = input.device;
      return run(organizationId, async (tx) => {
        const device = await tx.authDevice.upsert({
          where: {
            organizationId_userId_audience_clientId_deviceId: {
              organizationId,
              userId: d.userId,
              audience: d.audience,
              clientId: d.clientId,
              deviceId: d.deviceId,
            },
          },
          create: { organizationId, ...d, createdAt: input.createdAt, lastSeenAt: input.createdAt },
          update: { label: d.label, lastSeenAt: input.createdAt },
          select: { id: true },
        });
        await tx.authTokenFamily.create({
          data: {
            id: input.id,
            organizationId,
            userId: d.userId,
            authDeviceId: device.id,
            audience: d.audience,
            scopes: input.scopes,
            createdAt: input.createdAt,
            maxExpiresAt: input.maxExpiresAt,
          },
        });
      });
    },

    findFamily(organizationId: string, id: string): Promise<AuthTokenFamilyRecord | null> {
      if (!isUuid(id)) return Promise.resolve(null);
      return run(organizationId, async (tx) => {
        const row = await tx.authTokenFamily.findFirst({
          where: { organizationId, id },
          select: FAMILY_SELECT,
        });
        return row ? toFamily(row) : null;
      });
    },

    /** Live (unrevoked, unexpired) families of a user in this organization. */
    listFamilies(
      organizationId: string,
      userId: string,
      now: Date,
      audience?: AuthTokenAudience,
    ): Promise<AuthTokenFamilyRecord[]> {
      return run(organizationId, async (tx) =>
        (
          await tx.authTokenFamily.findMany({
            where: {
              organizationId,
              userId,
              revokedAt: null,
              maxExpiresAt: { gt: now },
              ...(audience ? { audience } : {}),
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: FAMILY_SELECT,
          })
        ).map(toFamily),
      );
    },

    /** Idempotent: the first revocation time is kept. */
    revokeFamily(organizationId: string, id: string, at: Date): Promise<void> {
      if (!isUuid(id)) return Promise.resolve();
      return run(organizationId, async (tx) => {
        await tx.authTokenFamily.updateMany({
          where: { organizationId, id, revokedAt: null },
          data: { revokedAt: at },
        });
      });
    },

    saveRefresh(
      organizationId: string,
      tokenHash: string,
      familyId: string,
      expiresAt: Date,
    ): Promise<void> {
      assertHash(tokenHash);
      return run(organizationId, async (tx) => {
        await tx.authRefreshToken.create({
          data: { organizationId, familyId, tokenHash, expiresAt },
        });
      });
    },

    /** Atomic single use: exactly one caller sees `ok`; a consumed hash reads as `reused`. */
    consumeRefresh(
      organizationId: string,
      tokenHash: string,
      at: Date,
    ): Promise<AuthRefreshConsumeResult> {
      assertHash(tokenHash);
      return run(organizationId, async (tx) => {
        const row = await tx.authRefreshToken.findFirst({
          where: { organizationId, tokenHash },
          select: { familyId: true },
        });
        if (!row) return { status: 'unknown' } as const;
        const { count } = await tx.authRefreshToken.updateMany({
          where: { organizationId, tokenHash, consumedAt: null },
          data: { consumedAt: at },
        });
        return { status: count === 1 ? 'ok' : 'reused', familyId: row.familyId } as const;
      });
    },

    peekRefresh(organizationId: string, tokenHash: string): Promise<AuthRefreshConsumeResult> {
      assertHash(tokenHash);
      return run(organizationId, async (tx) => {
        const row = await tx.authRefreshToken.findFirst({
          where: { organizationId, tokenHash },
          select: { familyId: true, consumedAt: true },
        });
        if (!row) return { status: 'unknown' } as const;
        return { status: row.consumedAt ? 'reused' : 'ok', familyId: row.familyId } as const;
      });
    },
  };
}

export type AuthTokenRepository = ReturnType<typeof createAuthTokenRepository>;

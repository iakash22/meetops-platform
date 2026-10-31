import type { CalendarConnection, CalendarProviderId } from '@meetops/contracts';
import type { IntegrationSecretCipher } from '@meetops/database';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import { refusingCipher } from '../integrations/prisma.repository.js';
import type {
  CalendarConnectionsRepository,
  CalendarConnectionUpsert,
  CalendarSecrets,
} from './ports.js';

type Row = {
  id: string;
  organizationId: string;
  userId: string;
  provider: string;
  status: CalendarConnection['status'];
  displayName: string;
  externalAccountId: string;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const toView = (r: Row): CalendarConnection => ({
  id: r.id,
  organizationId: r.organizationId,
  userId: r.userId,
  provider: r.provider as CalendarProviderId,
  status: r.status,
  displayName: r.displayName,
  externalAccountId: r.externalAccountId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
const keyIdOf = (env: string) => env.split('.')[1] ?? 'unknown';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prisma calendar connections. Every query runs in withOrganizationContext (forced RLS) and also filters by userId.
 * Tokens are TokenCipher envelopes with AAD = org + connection id (the cipher's `integrationId` slot).
 */
export class PrismaCalendarConnections implements CalendarConnectionsRepository {
  constructor(
    private readonly db: DatabaseClient,
    private readonly cipher: IntegrationSecretCipher = refusingCipher,
  ) {}
  private org<T>(organizationId: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) {
    return withOrganizationContext(organizationId, fn, { client: this.db });
  }
  private enc(organizationId: string, id: string, v: string) {
    return this.cipher.encrypt(v, { organizationId, integrationId: id });
  }

  async listForUser(organizationId: string, userId: string) {
    const rows = (await this.org(organizationId, (tx) =>
      tx.calendarConnection.findMany({
        where: { organizationId, userId },
        orderBy: [{ updatedAt: 'desc' }],
        take: 50,
      }),
    )) as Row[];
    return rows
      .map(toView)
      .sort((a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked'));
  }

  async upsert(organizationId: string, i: CalendarConnectionUpsert) {
    return this.org(organizationId, async (tx) => {
      const existing = await tx.calendarConnection.findUnique({
        where: {
          organizationId_userId_provider_externalAccountId: {
            organizationId,
            userId: i.userId,
            provider: i.provider,
            externalAccountId: i.externalAccountId,
          },
        },
        select: { id: true },
      });
      const id = existing?.id ?? crypto.randomUUID();
      const accessTokenEnc = await this.enc(organizationId, id, i.accessToken);
      const refreshTokenEnc = await this.enc(organizationId, id, i.refreshToken);
      const data = {
        status: 'active' as const,
        displayName: i.displayName,
        accessTokenEnc,
        refreshTokenEnc,
        tokenKeyId: keyIdOf(accessTokenEnc),
        accessTokenExpiresAt: i.accessTokenExpiresAt,
        revokedAt: null,
      };
      const row = existing
        ? await tx.calendarConnection.update({ where: { id }, data })
        : await tx.calendarConnection.create({
            data: {
              id,
              organizationId,
              userId: i.userId,
              provider: i.provider,
              externalAccountId: i.externalAccountId,
              ...data,
            },
          });
      return toView(row as Row);
    });
  }

  async readSecrets(organizationId: string, userId: string, id: string) {
    if (!UUID_RE.test(id)) return null;
    const row = (await this.org(organizationId, (tx) =>
      tx.calendarConnection.findFirst({ where: { id, organizationId, userId } }),
    )) as Row | null;
    if (!row || row.status === 'revoked' || !row.accessTokenEnc) return null;
    const ctx = { organizationId, integrationId: row.id };
    const out: CalendarSecrets = {
      accessToken: await this.cipher.decrypt(row.accessTokenEnc, ctx),
      refreshToken: row.refreshTokenEnc
        ? await this.cipher.decrypt(row.refreshTokenEnc, ctx)
        : null,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
    };
    return out;
  }

  async updateTokens(
    organizationId: string,
    id: string,
    t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
  ) {
    const accessTokenEnc = await this.enc(organizationId, id, t.accessToken);
    const refreshTokenEnc = await this.enc(organizationId, id, t.refreshToken);
    await this.org(organizationId, (tx) =>
      tx.calendarConnection.updateMany({
        where: { id, organizationId, status: { not: 'revoked' } },
        data: {
          status: 'active',
          accessTokenEnc,
          refreshTokenEnc,
          tokenKeyId: keyIdOf(accessTokenEnc),
          accessTokenExpiresAt: t.accessTokenExpiresAt,
        },
      }),
    );
  }

  async markError(organizationId: string, id: string) {
    await this.org(organizationId, (tx) =>
      tx.calendarConnection.updateMany({
        where: { id, organizationId, status: 'active' },
        data: { status: 'error' },
      }),
    );
  }

  async revoke(organizationId: string, userId: string, id: string) {
    if (!UUID_RE.test(id)) return false;
    const r = await this.org(organizationId, (tx) =>
      tx.calendarConnection.updateMany({
        where: { id, organizationId, userId, status: { not: 'revoked' } },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          accessTokenEnc: null,
          refreshTokenEnc: null,
          accessTokenExpiresAt: null,
        },
      }),
    );
    return r.count > 0;
  }
}

import type { CalendarConnection, CalendarProviderId } from '@meetops/contracts';
import type { IntegrationSecretCipher } from '@meetops/database';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import { refusingCipher } from '../integrations/prisma.repository.js';
import type {
  CalendarConnectionsRepository,
  CalendarConnectionUpsert,
  CalendarSecrets,
  CalendarTokenWriteOptions,
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
  tokenGeneration?: number;
  refreshEncVersion?: number | null;
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
  /** Separate AAD per field: an access-token envelope can't be swapped into the refresh column or vice versa. */
  private ctx(organizationId: string, id: string, field: 'access' | 'refresh') {
    return { organizationId, integrationId: `calendar:${id}:${field}` };
  }
  /** Decrypts with the current per-field context, falling back to the pre-v2 (org + id) context. */
  private async open(
    organizationId: string,
    id: string,
    enc: string,
    field: 'access' | 'refresh',
    declared: number | null = null,
  ): Promise<{ value: string; legacy: boolean } | null> {
    if (declared === 1)
      return this.cipher
        .decrypt(enc, { organizationId, integrationId: id })
        .then((value) => ({ value, legacy: true }))
        .catch(() => null);
    try {
      return {
        value: await this.cipher.decrypt(enc, this.ctx(organizationId, id, field)),
        legacy: false,
      };
    } catch {
      // A declared per-field (v2) envelope never falls back to the pre-v2 context.
      if (declared === 2) return null;
      try {
        return {
          value: await this.cipher.decrypt(enc, { organizationId, integrationId: id }),
          legacy: true,
        };
      } catch {
        return null;
      }
    }
  }
  private enc(organizationId: string, id: string, v: string, field: 'access' | 'refresh') {
    return this.cipher.encrypt(v, this.ctx(organizationId, id, field));
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
      const accessTokenEnc = await this.enc(organizationId, id, i.accessToken, 'access');
      const refreshTokenEnc = await this.enc(organizationId, id, i.refreshToken, 'refresh');
      const data = {
        status: 'active' as const,
        displayName: i.displayName,
        accessTokenEnc,
        refreshTokenEnc,
        tokenKeyId: keyIdOf(accessTokenEnc),
        refreshEncVersion: 2,
        accessTokenExpiresAt: i.accessTokenExpiresAt,
        revokedAt: null,
        // A (re)connect drops any sweep lease of the old grant: an in-flight sweep can no longer write
        // (its lease no longer matches) and the new grant is due immediately.
        nextSyncAt: null,
        // A (re)connect starts a fresh incremental round: a cursor from the old grant must not be replayed.
        syncCursorEnc: null,
        syncCursorFrom: null,
        syncCursorTo: null,
      };
      const row = existing
        ? // Reconnect bumps the token generation: an in-flight refresh of the old grant fails its compare-and-set.
          await tx.calendarConnection.update({
            where: { id },
            data: { ...data, tokenGeneration: { increment: 1 } },
          })
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
      return toView(row);
    });
  }

  async readSecrets(organizationId: string, userId: string, id: string) {
    if (!UUID_RE.test(id)) return null;
    const row = (await this.org(organizationId, (tx) =>
      tx.calendarConnection.findFirst({ where: { id, organizationId, userId } }),
    )) as Row | null;
    if (!row || row.status === 'revoked' || !row.accessTokenEnc) return null;
    const declared = row.refreshEncVersion ?? null;
    const access = await this.open(organizationId, row.id, row.accessTokenEnc, 'access');
    let refresh = row.refreshTokenEnc
      ? await this.open(organizationId, row.id, row.refreshTokenEnc, 'refresh', declared)
      : null;
    // The refresh token must open under its declared context (refresh_enc_version): a v2 access token next to a
    // declared legacy refresh token is valid (Google omits refresh_token on refresh). Rows written before that
    // column (NULL) only accept the pre-v2 context when the whole row is legacy: a v2 access token next to an
    // undeclared legacy-only refresh token means an envelope was moved between columns.
    if (declared === null && access && refresh && refresh.legacy && !access.legacy) refresh = null;
    if (!access || (row.refreshTokenEnc && !refresh)) {
      // Undecryptable under every known context: treat as disconnected (user must reconnect), never a 500.
      await this.markError(organizationId, row.id);
      return null;
    }
    let generation = row.tokenGeneration ?? 0;
    if (access.legacy || refresh?.legacy) {
      // Rows written before per-field AAD: re-encrypt under the current context (compare-and-set on the
      // generation, so a concurrent refresh or reconnect always wins over this rewrite).
      const newAccess = await this.enc(organizationId, row.id, access.value, 'access');
      const r = await this.org(organizationId, async (tx) =>
        tx.calendarConnection.updateMany({
          // Never resurrect secrets on a row revoked between the read and this write.
          where: {
            id: row.id,
            organizationId,
            status: { not: 'revoked' },
            tokenGeneration: generation,
          },
          data: {
            accessTokenEnc: newAccess,
            tokenKeyId: keyIdOf(newAccess),
            tokenGeneration: { increment: 1 },
            ...(refresh
              ? {
                  refreshTokenEnc: await this.enc(organizationId, row.id, refresh.value, 'refresh'),
                  refreshEncVersion: 2,
                }
              : {}),
          },
        }),
      );
      if (r.count === 1) {
        generation += 1;
        if (refresh) refresh = { ...refresh, legacy: false };
      }
    }
    const out: CalendarSecrets = {
      accessToken: access.value,
      refreshToken: refresh?.value ?? null,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      tokenGeneration: generation,
      refreshEncVersion: refresh ? (refresh.legacy ? 1 : 2) : null,
    };
    return out;
  }

  async updateTokens(
    organizationId: string,
    id: string,
    t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
    opts: CalendarTokenWriteOptions = {},
  ) {
    const accessTokenEnc = await this.enc(organizationId, id, t.accessToken, 'access');
    // Google omits refresh_token on refresh: keep the stored ciphertext and its declared context version.
    const refreshTokenEnc = t.refreshToken
      ? await this.enc(organizationId, id, t.refreshToken, 'refresh')
      : undefined;
    const r = await this.org(organizationId, (tx) =>
      tx.calendarConnection.updateMany({
        // Only an ACTIVE row: a refresh racing a revoke / error mark must neither resurrect it nor rewrite it.
        // With `generation`: compare-and-set, so a slower refresh never overwrites a newer grant or rotated token.
        where: {
          id,
          organizationId,
          status: 'active',
          ...(opts.generation !== undefined ? { tokenGeneration: opts.generation } : {}),
        },
        data: {
          accessTokenEnc,
          ...(refreshTokenEnc
            ? { refreshTokenEnc, refreshEncVersion: 2 }
            : opts.refreshEncVersion
              ? { refreshEncVersion: opts.refreshEncVersion }
              : {}),
          tokenKeyId: keyIdOf(accessTokenEnc),
          accessTokenExpiresAt: t.accessTokenExpiresAt,
          tokenGeneration: { increment: 1 },
        },
      }),
    );
    return r.count === 1;
  }

  async markError(organizationId: string, id: string) {
    await this.org(organizationId, (tx) =>
      tx.calendarConnection.updateMany({
        where: { id, organizationId, status: 'active' },
        data: { status: 'error' },
      }),
    );
  }

  /** revoke() also deletes the connection's event links in its transaction. */
  readonly revokesLinks = true;

  async revoke(organizationId: string, userId: string, id: string) {
    if (!UUID_RE.test(id)) return false;
    return this.org(organizationId, async (tx) => {
      const r = await tx.calendarConnection.updateMany({
        where: { id, organizationId, userId, status: { not: 'revoked' } },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          accessTokenEnc: null,
          refreshTokenEnc: null,
          refreshEncVersion: null,
          tokenGeneration: { increment: 1 },
          accessTokenExpiresAt: null,
          // Like upsert: the encrypted sync cursor and its window belong to the revoked grant.
          syncCursorEnc: null,
          syncCursorFrom: null,
          syncCursorTo: null,
        },
      });
      if (r.count === 0) return false;
      // Same transaction: purge the events cached by the background sync (the app role has no DELETE; the
      // definer function only deletes events of an already-revoked connection in this org context).
      await tx.$queryRaw`SELECT calendar_events_purge_for_connection(${organizationId}::uuid, ${id}::uuid)`;
      // Same transaction: event -> meeting links of the connection (a failure rolls the revoke back).
      await tx.calendarEventLink.deleteMany({ where: { organizationId, connectionId: id } });
      return true;
    });
  }
}

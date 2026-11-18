import { withOrganizationContext, type DatabaseClient } from '../../../shared/prisma/context.js';
import type {
  ConsentSettingsRecord,
  ConsentSettingsRepository,
} from '../domain/consent-settings.js';
import type { ConsentSettingsMode } from '@meetops/contracts';

const select = {
  organizationId: true,
  mode: true,
  noticeText: true,
  skipExternalParticipants: true,
  retentionDays: true,
  currentConsentVersion: true,
  updatedAt: true,
  updatedById: true,
} as const;

type Row = {
  organizationId: string;
  mode: string;
  noticeText: string;
  skipExternalParticipants: boolean;
  retentionDays: number;
  currentConsentVersion: string;
  updatedAt: Date;
  updatedById: string | null;
};

const toRecord = (r: Row): ConsentSettingsRecord => ({
  ...r,
  mode: r.mode as ConsentSettingsMode,
});

export class PrismaConsentSettingsRepository implements ConsentSettingsRepository {
  constructor(private readonly client: DatabaseClient) {}

  private ctx<T>(organizationId: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) {
    return withOrganizationContext(organizationId, fn, { client: this.client });
  }

  async get(organizationId: string): Promise<ConsentSettingsRecord | null> {
    return this.ctx(organizationId, async (tx) => {
      const row = await tx.organizationConsentSettings.findUnique({
        where: { organizationId },
        select,
      });
      return row ? toRecord(row) : null;
    });
  }

  async update(
    organizationId: string,
    defaults: ConsentSettingsRecord,
    mutate: (current: ConsentSettingsRecord) => ConsentSettingsRecord,
  ): Promise<ConsentSettingsRecord> {
    return this.ctx(organizationId, async (tx) => {
      // A first write has no row to lock: insert the defaults (a concurrent insert of the same key waits for the
      // other transaction, then does nothing), so every writer then locks the same committed row below.
      await tx.$executeRaw`
        INSERT INTO organization_consent_settings
          (org_id, mode, notice_text, skip_external_participants, retention_days, current_consent_version,
           updated_by_id, updated_at)
        VALUES
          (${organizationId}::uuid, ${defaults.mode}::"ConsentMethod", ${defaults.noticeText},
           ${defaults.skipExternalParticipants}, ${defaults.retentionDays}, ${defaults.currentConsentVersion},
           NULL, ${defaults.updatedAt})
        ON CONFLICT (org_id) DO NOTHING`;
      const [locked] = await tx.$queryRaw<Row[]>`
        SELECT org_id::text AS "organizationId", mode::text AS mode, notice_text AS "noticeText",
               skip_external_participants AS "skipExternalParticipants", retention_days AS "retentionDays",
               current_consent_version AS "currentConsentVersion", updated_at AS "updatedAt",
               updated_by_id::text AS "updatedById"
        FROM organization_consent_settings
        WHERE org_id = ${organizationId}::uuid
        FOR UPDATE`;
      if (!locked) throw new Error('consent settings row not visible after insert');
      const next = mutate(toRecord(locked));
      const saved = await tx.organizationConsentSettings.update({
        where: { organizationId },
        data: {
          mode: next.mode,
          noticeText: next.noticeText,
          skipExternalParticipants: next.skipExternalParticipants,
          retentionDays: next.retentionDays,
          currentConsentVersion: next.currentConsentVersion,
          updatedAt: next.updatedAt,
          updatedById: next.updatedById,
        },
        select,
      });
      return toRecord(saved);
    });
  }
}

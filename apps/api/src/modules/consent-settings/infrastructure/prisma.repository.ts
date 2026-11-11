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

  async upsert(row: ConsentSettingsRecord): Promise<ConsentSettingsRecord> {
    const data = {
      mode: row.mode,
      noticeText: row.noticeText,
      skipExternalParticipants: row.skipExternalParticipants,
      retentionDays: row.retentionDays,
      currentConsentVersion: row.currentConsentVersion,
      updatedAt: row.updatedAt,
      updatedById: row.updatedById,
    };
    return this.ctx(row.organizationId, async (tx) => {
      const saved = await tx.organizationConsentSettings.upsert({
        where: { organizationId: row.organizationId },
        create: { organizationId: row.organizationId, ...data },
        update: data,
        select,
      });
      return toRecord(saved);
    });
  }
}

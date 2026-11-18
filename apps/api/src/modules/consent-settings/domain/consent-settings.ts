import {
  CURRENT_CONSENT_VERSION,
  DEFAULT_CONSENT_NOTICE_TEXT,
  DEFAULT_CONSENT_SETTINGS_MODE,
  DEFAULT_RETENTION_DAYS,
  type ConsentSettingsMode,
} from '@meetops/contracts';

export interface ConsentSettingsRecord {
  organizationId: string;
  mode: ConsentSettingsMode;
  noticeText: string;
  skipExternalParticipants: boolean;
  retentionDays: number;
  currentConsentVersion: string;
  updatedAt: Date;
  updatedById: string | null;
}

export interface ConsentSettingsRepository {
  get(organizationId: string): Promise<ConsentSettingsRecord | null>;
  /**
   * PATCH primitive. In ONE transaction (inside the org's RLS context): ensure the org's row exists (inserted from
   * `defaults` when absent), lock it with SELECT ... FOR UPDATE, pass it to `mutate`, and write the result. Concurrent
   * updates of one org serialise on the row lock, so each `mutate` sees the previous writer's committed row and a
   * notice edit can never be lost or keep a stale currentConsentVersion.
   */
  update(
    organizationId: string,
    defaults: ConsentSettingsRecord,
    mutate: (current: ConsentSettingsRecord) => ConsentSettingsRecord,
  ): Promise<ConsentSettingsRecord>;
}

export function defaultConsentSettingsRecord(
  organizationId: string,
  now: Date,
): ConsentSettingsRecord {
  return {
    organizationId,
    mode: DEFAULT_CONSENT_SETTINGS_MODE,
    noticeText: DEFAULT_CONSENT_NOTICE_TEXT,
    skipExternalParticipants: false,
    retentionDays: DEFAULT_RETENTION_DAYS,
    currentConsentVersion: CURRENT_CONSENT_VERSION,
    updatedAt: now,
    updatedById: null,
  };
}

/**
 * Consent version an org accepts right now: its stored currentConsentVersion (the repository reads inside the org's
 * RLS context), or the global CURRENT_CONSENT_VERSION when the org has no settings row yet.
 */
export function orgConsentVersion(
  settings: Pick<ConsentSettingsRepository, 'get'>,
): (organizationId: string) => Promise<string> {
  return async (organizationId) =>
    (await settings.get(organizationId))?.currentConsentVersion ?? CURRENT_CONSENT_VERSION;
}

export function cloneConsentSettings(row: ConsentSettingsRecord): ConsentSettingsRecord {
  return { ...row, updatedAt: new Date(row.updatedAt) };
}

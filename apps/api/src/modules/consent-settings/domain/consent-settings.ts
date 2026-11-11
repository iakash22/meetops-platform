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
  upsert(row: ConsentSettingsRecord): Promise<ConsentSettingsRecord>;
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

export function cloneConsentSettings(row: ConsentSettingsRecord): ConsentSettingsRecord {
  return { ...row, updatedAt: new Date(row.updatedAt) };
}

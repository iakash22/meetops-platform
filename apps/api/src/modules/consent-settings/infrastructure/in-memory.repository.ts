import {
  cloneConsentSettings,
  type ConsentSettingsRecord,
  type ConsentSettingsRepository,
} from '../domain/consent-settings.js';

export class InMemoryConsentSettingsRepository implements ConsentSettingsRepository {
  private readonly rows = new Map<string, ConsentSettingsRecord>();

  async get(organizationId: string): Promise<ConsentSettingsRecord | null> {
    const row = this.rows.get(organizationId);
    return row ? cloneConsentSettings(row) : null;
  }

  async upsert(row: ConsentSettingsRecord): Promise<ConsentSettingsRecord> {
    const saved = cloneConsentSettings(row);
    this.rows.set(row.organizationId, saved);
    return cloneConsentSettings(saved);
  }
}

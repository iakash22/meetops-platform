import {
  cloneConsentSettings,
  type ConsentSettingsRecord,
  type ConsentSettingsRepository,
} from '../domain/consent-settings.js';

export class InMemoryConsentSettingsRepository implements ConsentSettingsRepository {
  private readonly rows = new Map<string, ConsentSettingsRecord>();
  /** Per-org promise chain: stands in for the Prisma row lock so concurrent updates serialise. */
  private readonly locks = new Map<string, Promise<unknown>>();

  async get(organizationId: string): Promise<ConsentSettingsRecord | null> {
    const row = this.rows.get(organizationId);
    return row ? cloneConsentSettings(row) : null;
  }

  async update(
    organizationId: string,
    defaults: ConsentSettingsRecord,
    mutate: (current: ConsentSettingsRecord) => ConsentSettingsRecord,
  ): Promise<ConsentSettingsRecord> {
    const prev = this.locks.get(organizationId) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        // Yield once so a concurrent caller really overlaps the read in tests.
        await Promise.resolve();
        const current = this.rows.get(organizationId) ?? defaults;
        const next = cloneConsentSettings(
          mutate(cloneConsentSettings({ ...current, organizationId })),
        );
        this.rows.set(organizationId, { ...next, organizationId });
        return cloneConsentSettings(next);
      });
    this.locks.set(organizationId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(organizationId) === run) this.locks.delete(organizationId);
    }
  }
}

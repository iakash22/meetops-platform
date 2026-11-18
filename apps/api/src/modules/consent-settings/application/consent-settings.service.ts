import {
  CONSENT_SETTINGS_WRITE_ROLES,
  nextConsentVersion,
  type ConsentSettings,
  type UpdateConsentSettingsRequest,
} from '@meetops/contracts';
import { safeAudit, type AuditLog } from '../../auth/domain/audit.js';
import type { DirectoryCaller } from '../../directory/access.js';
import { ForbiddenError } from '../../organizations/domain/errors.js';
import {
  defaultConsentSettingsRecord,
  type ConsentSettingsRecord,
  type ConsentSettingsRepository,
} from '../domain/consent-settings.js';

export interface ConsentSettingsServiceDeps {
  settings: ConsentSettingsRepository;
  audit: AuditLog;
  now: () => Date;
}

export function toConsentSettingsDto(row: ConsentSettingsRecord): ConsentSettings {
  return {
    mode: row.mode,
    noticeText: row.noticeText,
    skipExternalParticipants: row.skipExternalParticipants,
    retentionDays: row.retentionDays,
    currentConsentVersion: row.currentConsentVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ConsentSettingsService {
  constructor(private readonly d: ConsentSettingsServiceDeps) {}

  /** GET: existing row, or in-memory defaults (no write). All roles. */
  async get(c: DirectoryCaller): Promise<ConsentSettings> {
    const row =
      (await this.d.settings.get(c.ctx.organizationId)) ??
      defaultConsentSettingsRecord(c.ctx.organizationId, this.d.now());
    return toConsentSettingsDto(row);
  }

  /** PATCH: owner/admin only. Bumps currentConsentVersion when noticeText changes. Audited. */
  async update(c: DirectoryCaller, patch: UpdateConsentSettingsRequest): Promise<ConsentSettings> {
    if (!(CONSENT_SETTINGS_WRITE_ROLES as readonly string[]).includes(c.ctx.role)) {
      throw new ForbiddenError();
    }
    const now = this.d.now();
    const org = c.ctx.organizationId;
    let noticeChanged = false;
    // Read and write in one transaction under a row lock: concurrent PATCHes apply one after the other.
    const saved = await this.d.settings.update(
      org,
      defaultConsentSettingsRecord(org, now),
      (current): ConsentSettingsRecord => {
        const noticeText = patch.noticeText !== undefined ? patch.noticeText : current.noticeText;
        noticeChanged = noticeText !== current.noticeText;
        return {
          organizationId: org,
          mode: patch.mode ?? current.mode,
          noticeText,
          skipExternalParticipants:
            patch.skipExternalParticipants ?? current.skipExternalParticipants,
          retentionDays: patch.retentionDays ?? current.retentionDays,
          currentConsentVersion: noticeChanged
            ? nextConsentVersion(current.currentConsentVersion, now)
            : current.currentConsentVersion,
          updatedAt: now,
          updatedById: c.ctx.userId,
        };
      },
    );
    await safeAudit(this.d.audit, {
      organizationId: c.ctx.organizationId,
      actorId: c.ctx.userId,
      action: 'consent.settings.update',
      targetType: 'consent_settings',
      targetId: c.ctx.organizationId,
      metadata: {
        mode: saved.mode,
        retentionDays: saved.retentionDays,
        skipExternalParticipants: saved.skipExternalParticipants,
        noticeChanged,
        currentConsentVersion: saved.currentConsentVersion,
      },
      ip: c.meta.ip,
      userAgent: c.meta.userAgent,
    });
    return toConsentSettingsDto(saved);
  }
}

/**
 * organization_consent_settings: forced RLS, tenant isolation, retention/notice CHECKs.
 * Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL are set. Live runs may use only
 * drill_* databases on 127.0.0.1:55432.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

describe.skipIf(!APP_URL || !OWNER_URL)('organization_consent_settings (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'Consent A', slug: `consent-a-${orgA}` },
        { id: orgB, name: 'Consent B', slug: `consent-b-${orgB}` },
      ],
    });
  });

  afterAll(async () => {
    await owner.organizationConsentSettings.deleteMany({
      where: { organizationId: { in: [orgA, orgB] } },
    });
    await owner.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('is forced RLS and isolated per org', async () => {
    const [flags] = await app.$queryRaw<{ forced: boolean }[]>`
      SELECT c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'organization_consent_settings'`;
    expect(flags?.forced).toBe(true);

    const now = new Date();
    await runWithOrganizationContext(app, orgA, async (tx) => {
      await tx.organizationConsentSettings.create({
        data: {
          organizationId: orgA,
          mode: 'all_parties_consented',
          noticeText: 'A notice',
          skipExternalParticipants: false,
          retentionDays: 90,
          currentConsentVersion: '2026-10',
          updatedAt: now,
        },
      });
    });
    await runWithOrganizationContext(app, orgB, async (tx) => {
      const seen = await tx.organizationConsentSettings.findMany();
      expect(seen).toEqual([]);
      await tx.organizationConsentSettings.create({
        data: {
          organizationId: orgB,
          mode: 'all_parties_notified',
          noticeText: 'B notice',
          skipExternalParticipants: true,
          retentionDays: 30,
          currentConsentVersion: '2026-10',
          updatedAt: now,
        },
      });
    });
    const a = await runWithOrganizationContext(app, orgA, (tx) =>
      tx.organizationConsentSettings.findMany(),
    );
    expect(a).toHaveLength(1);
    expect(a[0]?.organizationId).toBe(orgA);
    expect(a[0]?.noticeText).toBe('A notice');
  });

  it('rejects retention outside 7–365 and an empty notice', async () => {
    const now = new Date();
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.organizationConsentSettings.update({
          where: { organizationId: orgA },
          data: { retentionDays: 6, updatedAt: now },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.organizationConsentSettings.update({
          where: { organizationId: orgA },
          data: { noticeText: '', updatedAt: now },
        }),
      ),
    ).rejects.toThrow();
    // notice_text_not_blank_check: the same blank set as the contract (v050-consent-settings-uploads.test.ts).
    for (const blank of [
      ' ',
      '   ',
      '\n\t ',
      '\r\n',
      '\t',
      '\v',
      '\u00a0',
      '\u2003',
      '\u3000',
      '\ufeff',
      '\u200b',
      '\u0085',
      ' \u00a0\u3000\u200b\u0085\t',
    ]) {
      await expect(
        runWithOrganizationContext(app, orgA, (tx) =>
          tx.organizationConsentSettings.update({
            where: { organizationId: orgA },
            data: { noticeText: blank, updatedAt: now },
          }),
        ),
      ).rejects.toThrow(/notice_text_not_blank_check/);
    }
    // Visible text passes, including the letter 'v' (a bad "\v" escape once stripped it).
    for (const ok of ['v', 'A\u00a0B', 'x\u200by']) {
      const saved = await runWithOrganizationContext(app, orgA, (tx) =>
        tx.organizationConsentSettings.update({
          where: { organizationId: orgA },
          data: { noticeText: ok, updatedAt: now },
        }),
      );
      expect(saved.noticeText).toBe(ok);
    }
  });

  it('defaults retention_days to 90 and mode to all_parties_consented', async () => {
    const orgC = randomUUID();
    await owner.organization.create({
      data: { id: orgC, name: 'Consent C', slug: `consent-c-${orgC}` },
    });
    try {
      const [row] = await runWithOrganizationContext(app, orgC, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO organization_consent_settings
            (org_id, notice_text, skip_external_participants, current_consent_version, updated_at)
          VALUES (${orgC}::uuid, 'C notice', false, '2026-10', now())`;
        return tx.$queryRaw<{ retention_days: number; mode: string }[]>`
          SELECT retention_days, mode::text AS mode FROM organization_consent_settings
          WHERE org_id = ${orgC}::uuid`;
      });
      expect(row).toEqual({ retention_days: 90, mode: 'all_parties_consented' });
    } finally {
      await owner.organizationConsentSettings.deleteMany({ where: { organizationId: orgC } });
      await owner.organization.deleteMany({ where: { id: orgC } });
    }
  });
});

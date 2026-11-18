import { afterEach, describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ConsentSettings,
  CURRENT_CONSENT_VERSION,
  DEFAULT_CONSENT_NOTICE_TEXT,
  DEFAULT_CONSENT_SETTINGS_MODE,
  DEFAULT_RETENTION_DAYS,
} from '@meetops/contracts';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryConsentSettingsRepository } from '../src/modules/consent-settings/infrastructure/in-memory.repository.js';
import { buildApp, signupAndLogin, type App } from './helpers.js';

describe('consent settings API', () => {
  let app: App;
  afterEach(async () => app?.close());

  const at = new Date('2026-11-11T17:30:00.000Z');
  async function world(audit = new InMemoryAuditLog()) {
    const settings = new InMemoryConsentSettingsRepository();
    app = await buildApp({
      audit,
      consentSettings: settings,
      clock: { now: () => at },
    });
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = (await owner.post('/orgs', { name: 'Acme' })).json<{
      organization: { id: string };
    }>().organization.id;
    const join = async (email: string, role: 'admin' | 'member' | 'viewer') => {
      const c = await signupAndLogin(app, email);
      expect((await owner.post(`/orgs/${org}/invitations`, { email, role })).statusCode).toBe(201);
      const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
      const token = new URL(sent!.data.url!).searchParams.get('token')!;
      expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
      expect((await c.post('/orgs/switch', { organizationId: org })).statusCode).toBe(200);
      return c;
    };
    const admin = await join('admin@example.com', 'admin');
    const member = await join('member@example.com', 'member');
    const viewer = await join('viewer@example.com', 'viewer');
    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = (await other.post('/orgs', { name: 'Globex' })).json<{
      organization: { id: string };
    }>().organization.id;
    return { app, audit, settings, owner, admin, member, viewer, other, org, otherOrg };
  }
  const path = (org: string) => `/orgs/${org}/settings/consent`;
  const expectDto = (
    res: { statusCode: number; json: () => unknown },
    over: Partial<ConsentSettings> = {},
  ) => {
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    const body = res.json();
    expect(Value.Check(ConsentSettings, body)).toBe(true);
    expect(body).toMatchObject({
      mode: DEFAULT_CONSENT_SETTINGS_MODE,
      noticeText: DEFAULT_CONSENT_NOTICE_TEXT,
      skipExternalParticipants: false,
      retentionDays: DEFAULT_RETENTION_DAYS,
      currentConsentVersion: CURRENT_CONSENT_VERSION,
      updatedAt: at.toISOString(),
      ...over,
    });
    return body as ConsentSettings;
  };

  it('GET returns ADR defaults for every role and does not persist a row', async () => {
    const w = await world();
    for (const c of [w.owner, w.admin, w.member, w.viewer]) {
      expectDto(await c.get(path(w.org)));
    }
    expect(await w.settings.get(w.org)).toBeNull();
  });

  it('PATCH is owner or admin, CSRF, audited, and bumps the version only when the notice changes', async () => {
    const w = await world();
    const first = expectDto(await w.owner.patch(path(w.org), { retentionDays: 30 }), {
      retentionDays: 30,
      currentConsentVersion: CURRENT_CONSENT_VERSION,
    });
    expect(first.currentConsentVersion).toBe(CURRENT_CONSENT_VERSION);
    expect(w.audit.events.filter((e) => e.action === 'consent.settings.update')).toHaveLength(1);
    expect(w.audit.events.at(-1)).toMatchObject({
      organizationId: w.org,
      action: 'consent.settings.update',
      targetType: 'consent_settings',
      targetId: w.org,
      metadata: {
        retentionDays: 30,
        noticeChanged: false,
        currentConsentVersion: CURRENT_CONSENT_VERSION,
      },
    });

    const bumped = expectDto(
      await w.admin.patch(path(w.org), { noticeText: 'We record this call.' }),
      {
        retentionDays: 30,
        noticeText: 'We record this call.',
        currentConsentVersion: '2026-11-11',
      },
    );
    expect(bumped.currentConsentVersion).toBe('2026-11-11');
    expect(w.audit.events.at(-1)?.metadata).toMatchObject({
      noticeChanged: true,
      currentConsentVersion: '2026-11-11',
    });

    expect((await w.member.patch(path(w.org), { retentionDays: 60 })).statusCode).toBe(403);
    expect((await w.viewer.patch(path(w.org), { retentionDays: 60 })).statusCode).toBe(403);
    expect((await w.member.get(path(w.org))).json()).toMatchObject({ retentionDays: 30 });
  });

  it('serialises concurrent PATCHes: every notice edit bumps the version, none is lost', async () => {
    const w = await world();
    const notices = ['Notice one.', 'Notice two.', 'Notice three.'];
    const res = await Promise.all(
      notices.map((noticeText, i) =>
        (i % 2 ? w.admin : w.owner).patch(path(w.org), { noticeText }),
      ),
    );
    const bodies = res.map((r) => {
      expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
      return r.json<ConsentSettings>();
    });
    // Each writer saw the previous one's committed row: three distinct, consecutive versions.
    expect(bodies.map((b) => b.currentConsentVersion).sort()).toEqual([
      '2026-11-11',
      '2026-11-11.2',
      '2026-11-11.3',
    ]);
    const last = bodies.find((b) => b.currentConsentVersion === '2026-11-11.3')!;
    const stored = await w.settings.get(w.org);
    expect(stored).toMatchObject({
      currentConsentVersion: '2026-11-11.3',
      noticeText: last.noticeText,
    });
    const audits = w.audit.events.filter((e) => e.action === 'consent.settings.update');
    expect(audits.map((e) => e.metadata?.noticeChanged)).toEqual([true, true, true]);
  });

  it('rejects other-org ids with 404 and does not leak a row', async () => {
    const w = await world();
    expect((await w.other.get(path(w.org))).statusCode).toBe(404);
    expect((await w.other.patch(path(w.org), { retentionDays: 30 })).statusCode).toBe(404);
    expect((await w.owner.get(path(w.otherOrg))).statusCode).toBe(404);
    expect(await w.settings.get(w.org)).toBeNull();
  });

  it('validates the PATCH body (empty, unknown mode, retention range, server-owned fields)', async () => {
    const w = await world();
    const bad = [
      {},
      { mode: 'one_party' },
      { mode: 'all_party' },
      { retentionDays: 6 },
      { retentionDays: 366 },
      { currentConsentVersion: '2027-01' },
      { updatedAt: at.toISOString() },
      { noticeText: '' },
    ];
    for (const body of bad) {
      const r = await w.owner.patch(path(w.org), body);
      expect(r.statusCode, JSON.stringify({ body, res: r.json() })).toBe(400);
    }
  });

  it('rejects a PATCH without a CSRF token', async () => {
    const w = await world();
    const r = await w.app.inject({
      method: 'PATCH',
      url: path(w.org),
      payload: { retentionDays: 30 },
      headers: {
        cookie: w.owner.cookie,
        origin: 'http://localhost:5173',
      },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_INVALID');
  });
});

describe('InMemoryConsentSettingsRepository', () => {
  it('returns copies so a caller cannot mutate the store', async () => {
    const repo = new InMemoryConsentSettingsRepository();
    const now = new Date('2026-11-11T00:00:00.000Z');
    const row = {
      organizationId: 'o1',
      mode: 'all_parties_consented' as const,
      noticeText: 'N',
      skipExternalParticipants: false,
      retentionDays: 90,
      currentConsentVersion: '2026-10',
      updatedAt: now,
      updatedById: 'u1',
    };
    const saved = await repo.update('o1', row, (current) => ({ ...current, updatedById: 'u1' }));
    saved.noticeText = 'mutated';
    saved.retentionDays = 7;
    const got = await repo.get('o1');
    expect(got?.noticeText).toBe('N');
    expect(got?.retentionDays).toBe(90);
    got!.noticeText = 'again';
    expect((await repo.get('o1'))?.noticeText).toBe('N');
    expect(await repo.get('missing')).toBeNull();
  });
});

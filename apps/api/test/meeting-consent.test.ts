import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { MeetingConsentEvent, MeetingConsentStatus } from '@meetops/contracts';
import { consentEnforcementEnabled } from '../src/modules/index.js';
import type { InMemoryMeetingConsentRepository } from '../src/modules/media/infrastructure/in-memory.js';
import type { InMemoryRecordingSessionRepository } from '../src/modules/media/infrastructure/in-memory.js';
import { consent, errorOf, mediaWorld, SHA_B64 } from './media-helpers.js';
import type { Client } from './helpers.js';

async function setup(enforce = false) {
  const w = await mediaWorld({ consentEnforcementEnabled: enforce });
  const mk = async (c: Client, org: string, code: string) =>
    (
      await c.post(`/orgs/${org}/meetings/resolve`, {
        source: 'extension',
        externalMeetingUrl: `https://meet.google.com/${code}`,
        title: 'Standup',
      })
    ).json<{ meetingId: string }>().meetingId;
  const meetingId = await mk(w.member, w.org, 'abc-defg-hij');
  const otherMeetingId = await mk(w.other, w.otherOrg, 'zzz-zzzz-zzz');
  const base = (org = w.org, m = meetingId) => `/orgs/${org}/meetings/${m}/consent`;
  const grant = (c: Client = w.member, body: unknown = consent(), org = w.org, m = meetingId) =>
    c.post(base(org, m), body as Record<string, unknown>);
  const revoke = (
    c: Client = w.member,
    body: Record<string, unknown> = {},
    org = w.org,
    m = meetingId,
  ) => c.post(`${base(org, m)}/revoke`, body);
  const status = (c: Client = w.member, org = w.org, m = meetingId) => c.get(base(org, m));
  const initSession = (c: Client = w.member) =>
    c.post(`/orgs/${w.org}/recording-sessions`, {
      mimeType: 'video/webm',
      startedAt: new Date().toISOString(),
      source: 'tab',
      meetingId,
      consent: consent(),
    });
  const initUpload = (over: Record<string, unknown> = {}) =>
    w.member.post(`/orgs/${w.org}/uploads`, {
      filename: 'call.webm',
      mimeType: 'video/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      meetingId,
      consent: consent(),
      ...over,
    });
  const ledger = w.media.meetingConsents as InMemoryMeetingConsentRepository;
  return {
    ...w,
    meetingId,
    otherMeetingId,
    grant,
    revoke,
    status,
    initSession,
    initUpload,
    ledger,
  };
}

describe('Consent API', { timeout: 30_000 }, () => {
  it('records, reads and revokes consent as append-only events from the session identity', async () => {
    const w = await setup();
    const empty = await w.status();
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ state: 'none', valid: false, latest: null, events: [] });

    const g = await w.grant();
    expect(g.statusCode).toBe(201);
    const ev = g.json<{ actorUserId: string; eventType: string }>();
    expect(Value.Check(MeetingConsentEvent, ev)).toBe(true);
    expect(ev.eventType).toBe('granted');
    expect(w.ledger.rows[0]!.organizationId).toBe(w.org);

    const s1 = (await w.status(w.viewer)).json();
    expect(Value.Check(MeetingConsentStatus, s1)).toBe(true);
    expect(s1).toMatchObject({ state: 'granted', valid: true });

    const r = await w.revoke(w.member, { reason: 'participant objected' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      eventType: 'revoked',
      reason: 'participant objected',
      method: null,
    });

    const s2 = (await w.status()).json<{ state: string; valid: boolean; events: unknown[] }>();
    expect(s2.state).toBe('revoked');
    expect(s2.valid).toBe(false);
    // The grant is kept as evidence; the revocation is a new event.
    expect(s2.events).toHaveLength(2);
    expect(w.ledger.rows.map((x) => x.eventType)).toEqual(['granted', 'revoked']);
  });

  it('rejects invalid consent with 422 CONSENT_* and never takes identity from the body', async () => {
    const w = await setup();
    const cases: [unknown, string][] = [
      [{}, 'CONSENT_REQUIRED'],
      [consent({ method: 'covert' }), 'CONSENT_REQUIRED'],
      [consent({ organizationId: w.otherOrg }), 'CONSENT_REQUIRED'],
      [consent({ actorUserId: '00000000-0000-4000-8000-000000000001' }), 'CONSENT_REQUIRED'],
      [consent({ consentVersion: '1999-01' }), 'CONSENT_VERSION_UNSUPPORTED'],
      [consent({ attestedAt: new Date(Date.now() + 3_600_000).toISOString() }), 'CONSENT_INVALID'],
    ];
    for (const [body, reason] of cases) {
      const res = await w.grant(w.member, body);
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({ code: 'VALIDATION_FAILED', reason });
    }
    expect((await w.revoke(w.member, { organizationId: w.otherOrg })).statusCode).toBe(400);
    expect(w.ledger.rows).toHaveLength(0);
  });

  it('viewer can read but not write', async () => {
    const w = await setup();
    expect((await w.status(w.viewer)).statusCode).toBe(200);
    expect((await w.grant(w.viewer)).statusCode).toBe(403);
    expect((await w.revoke(w.viewer)).statusCode).toBe(403);
    expect(w.ledger.rows).toHaveLength(0);
  });

  it('cross-org access is 404 for every route, and unknown meetings are 404', async () => {
    const w = await setup();
    await w.grant();
    // Another org's user on this org's path.
    expect((await w.status(w.other)).statusCode).toBe(404);
    expect((await w.grant(w.other)).statusCode).toBe(404);
    expect((await w.revoke(w.other)).statusCode).toBe(404);
    // This org's user naming another org's meeting under their own org.
    expect((await w.status(w.member, w.org, w.otherMeetingId)).statusCode).toBe(404);
    expect((await w.grant(w.member, consent(), w.org, w.otherMeetingId)).statusCode).toBe(404);
    expect((await w.revoke(w.member, {}, w.org, w.otherMeetingId)).statusCode).toBe(404);
    // ...or the other org's path.
    expect((await w.status(w.member, w.otherOrg, w.otherMeetingId)).statusCode).toBe(404);
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await w.status(w.member, w.org, unknown)).statusCode).toBe(404);
    // Nothing leaked into or out of the other org's ledger.
    expect(w.ledger.rows.every((r) => r.organizationId === w.org)).toBe(true);
    expect(w.ledger.rows).toHaveLength(1);
  });

  it('enforcement OFF (default): recording and upload init work without a meeting consent grant', async () => {
    const w = await setup(false);
    expect((await w.initSession()).statusCode).toBe(201);
    expect((await w.initUpload()).statusCode).toBe(201);
    expect((await w.initUpload({ meetingId: undefined })).statusCode).toBe(201);
  });

  it('enforcement ON: fails closed until granted, and again after revocation', async () => {
    const w = await setup(true);
    const expect422 = (
      res: Awaited<ReturnType<typeof w.initSession>>,
      reason = 'CONSENT_REQUIRED',
    ) => {
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({ code: 'VALIDATION_FAILED', reason });
    };
    const sessions = w.media.sessions as InMemoryRecordingSessionRepository;
    expect422(await w.initSession());
    expect422(await w.initUpload());
    expect422(await w.initUpload({ meetingId: undefined }));
    expect(sessions.rows.size).toBe(0);

    expect((await w.grant()).statusCode).toBe(201);
    const ok = await w.initSession();
    expect(ok.statusCode).toBe(201);
    expect((await w.initUpload()).statusCode).toBe(201);
    const { sessionId } = ok.json<{ sessionId: string }>();
    const chunk = () =>
      w.member.post(`/recording-sessions/${sessionId}/chunks`, {
        seq: 0,
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
      });
    expect((await chunk()).statusCode).toBe(200);

    expect((await w.revoke()).statusCode).toBe(201);
    expect422(await chunk());
    expect422(
      await w.member.post(`/recording-sessions/${sessionId}/complete`, {
        chunkCount: 1,
        durationMs: 1000,
      }),
    );
    expect422(await w.initSession());

    // Re-granting is a new event and re-opens capture.
    expect((await w.grant()).statusCode).toBe(201);
    expect((await w.initSession()).statusCode).toBe(201);
  });

  it('CONSENT_ENFORCEMENT_ENABLED parses strictly and defaults off', () => {
    expect(consentEnforcementEnabled({})).toBe(false);
    expect(consentEnforcementEnabled({ CONSENT_ENFORCEMENT_ENABLED: '' })).toBe(false);
    expect(consentEnforcementEnabled({ CONSENT_ENFORCEMENT_ENABLED: 'false' })).toBe(false);
    expect(consentEnforcementEnabled({ CONSENT_ENFORCEMENT_ENABLED: 'true' })).toBe(true);
    expect(consentEnforcementEnabled({ CONSENT_ENFORCEMENT_ENABLED: ' ON ' })).toBe(true);
    expect(() => consentEnforcementEnabled({ CONSENT_ENFORCEMENT_ENABLED: 'maybe' })).toThrow();
  });
});

describe('in-memory consent ledger ordering', () => {
  it('breaks a recordedAt tie deterministically: revoked first, then id desc', async () => {
    const { InMemoryMeetingConsentRepository: Repo } =
      await import('../src/modules/media/infrastructure/in-memory.js');
    const repo = new Repo();
    const at = new Date('2026-10-31T10:00:00.000Z');
    const base = {
      organizationId: 'o',
      meetingId: 'm',
      consentVersion: null,
      method: null,
      reason: null,
      actorUserId: 'u',
      occurredAt: at,
      recordedAt: at,
    };
    repo.rows.push(
      { ...base, id: 'a', eventType: 'granted' },
      { ...base, id: 'c', eventType: 'granted' },
      { ...base, id: 'b', eventType: 'revoked' },
      { ...base, id: 'z', eventType: 'granted', recordedAt: new Date(at.getTime() - 1) },
    );
    expect((await repo.list('o', 'm', 10)).map((r) => r.id)).toEqual(['b', 'c', 'a', 'z']);
  });
});

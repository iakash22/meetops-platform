/**
 * #484 T&S: uploads, recording sessions and the Consent API accept only the org's stored currentConsentVersion
 * (read server-side), falling back to the global CURRENT_CONSENT_VERSION only when the org has no settings row.
 */
import { describe, expect, it } from 'vitest';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts';
import { orgConsentVersion } from '../src/modules/consent-settings/domain/consent-settings.js';
import { InMemoryConsentSettingsRepository } from '../src/modules/consent-settings/infrastructure/in-memory.repository.js';
import { reconcileStaleMedia } from '../src/modules/media/application/reconcile.js';
import { consent, errorOf, mediaWorld, SHA_B64 } from './media-helpers.js';
import type { Client } from './helpers.js';

const ARBITRARY = 'zz-arbitrary-9';

async function setup(enforce = false) {
  const consentSettings = new InMemoryConsentSettingsRepository();
  const w = await mediaWorld({ consentEnforcementEnabled: enforce, consentSettings });
  const meeting = async (c: Client, org: string, code: string) =>
    (
      await c.post(`/orgs/${org}/meetings/resolve`, {
        source: 'extension',
        externalMeetingUrl: `https://meet.google.com/${code}`,
        title: 'Standup',
      })
    ).json<{ meetingId: string }>().meetingId;
  const meetingId = await meeting(w.member, w.org, 'abc-defg-hij');
  const otherMeetingId = await meeting(w.other, w.otherOrg, 'zzz-zzzz-zzz');
  const upload = (c: Client, org: string, consentVersion: string, m?: string) =>
    c.post(`/orgs/${org}/uploads`, {
      filename: 'call.webm',
      mimeType: 'video/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      ...(m ? { meetingId: m } : {}),
      consent: consent({ consentVersion }),
    });
  const session = (c: Client, org: string, m: string, consentVersion: string) =>
    c.post(`/orgs/${org}/recording-sessions`, {
      mimeType: 'video/webm',
      startedAt: new Date().toISOString(),
      source: 'tab',
      meetingId: m,
      consent: consent({ consentVersion }),
    });
  const grant = (c: Client, org: string, m: string, consentVersion: string) =>
    c.post(`/orgs/${org}/meetings/${m}/consent`, consent({ consentVersion }));
  /** Owner edits the notice; returns the org's new server-owned version. */
  const editNotice = async (noticeText: string) => {
    const r = await w.owner.patch(`/orgs/${w.org}/settings/consent`, { noticeText });
    expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
    return r.json<{ currentConsentVersion: string }>().currentConsentVersion;
  };
  return { ...w, consentSettings, meetingId, otherMeetingId, upload, session, grant, editNotice };
}

const unsupported = (r: { statusCode: number; json: () => unknown }) => {
  expect(r.statusCode, JSON.stringify(r.json())).toBe(422);
  expect(errorOf(r)).toMatchObject({
    code: 'VALIDATION_FAILED',
    reason: 'CONSENT_VERSION_UNSUPPORTED',
  });
};

describe('org consent version (server-side, per org)', () => {
  it('an org with no settings row accepts only the global default version', async () => {
    const w = await setup();
    expect(await w.consentSettings.get(w.org)).toBeNull();
    expect((await w.upload(w.member, w.org, CURRENT_CONSENT_VERSION)).statusCode).toBe(201);
    unsupported(await w.upload(w.member, w.org, ARBITRARY));
    expect((await w.grant(w.member, w.org, w.meetingId, CURRENT_CONSENT_VERSION)).statusCode).toBe(
      201,
    );
    unsupported(await w.grant(w.member, w.org, w.meetingId, ARBITRARY));
    expect(
      (await w.session(w.member, w.org, w.meetingId, CURRENT_CONSENT_VERSION)).statusCode,
    ).toBe(201);
  });

  it('after a notice edit the new version is 2xx; the old and an arbitrary version are 422', async () => {
    const w = await setup();
    const v2 = await w.editNotice('This call is recorded and transcribed with MeetOps.');
    expect(v2).not.toBe(CURRENT_CONSENT_VERSION);

    expect((await w.upload(w.member, w.org, v2)).statusCode).toBe(201);
    unsupported(await w.upload(w.member, w.org, CURRENT_CONSENT_VERSION));
    unsupported(await w.upload(w.member, w.org, ARBITRARY));

    expect((await w.grant(w.member, w.org, w.meetingId, v2)).statusCode).toBe(201);
    unsupported(await w.grant(w.member, w.org, w.meetingId, CURRENT_CONSENT_VERSION));
    unsupported(await w.grant(w.member, w.org, w.meetingId, ARBITRARY));
    const status = await w.member.get(`/orgs/${w.org}/meetings/${w.meetingId}/consent`);
    expect(status.json()).toMatchObject({ state: 'granted', valid: true });

    expect((await w.session(w.member, w.org, w.meetingId, v2)).statusCode).toBe(201);
    unsupported(await w.session(w.member, w.org, w.meetingId, CURRENT_CONSENT_VERSION));
    unsupported(await w.session(w.member, w.org, w.meetingId, ARBITRARY));

    // A second edit moves the org on again: the first edited version is now stale too.
    const v3 = await w.editNotice('Recorded with MeetOps by a participant. Ask to opt out.');
    expect(v3).not.toBe(v2);
    unsupported(await w.upload(w.member, w.org, v2));
    expect((await w.upload(w.member, w.org, v3)).statusCode).toBe(201);
    // The earlier v2 grant is no longer a valid current consent.
    const after = await w.member.get(`/orgs/${w.org}/meetings/${w.meetingId}/consent`);
    expect(after.json()).toMatchObject({ state: 'granted', valid: false });
  });

  it("another org's edit never changes what an org without a row accepts", async () => {
    const w = await setup();
    const v2 = await w.editNotice('Org A only notice.');
    expect(await w.consentSettings.get(w.otherOrg)).toBeNull();
    expect((await w.upload(w.other, w.otherOrg, CURRENT_CONSENT_VERSION)).statusCode).toBe(201);
    unsupported(await w.upload(w.other, w.otherOrg, v2));
    expect(
      (await w.grant(w.other, w.otherOrg, w.otherMeetingId, CURRENT_CONSENT_VERSION)).statusCode,
    ).toBe(201);
    unsupported(await w.grant(w.other, w.otherOrg, w.otherMeetingId, v2));
  });

  it('(a) an upload in flight across a notice edit completes (2xx) and keeps its original version', async () => {
    const w = await setup();
    const init = await w.upload(w.member, w.org, CURRENT_CONSENT_VERSION);
    expect(init.statusCode).toBe(201);
    const { fileObjectId } = init.json<{ fileObjectId: string }>();
    w.signer.put(`organizations/${w.org}/uploads/${fileObjectId}/source`, 1000);
    const v2 = await w.editNotice('Edited after the upload started.');
    expect(v2).not.toBe(CURRENT_CONSENT_VERSION);
    // A client cannot swap in another version at complete: the body is not a version source (extra fields are 400).
    const forged = await w.member.post(`/orgs/${w.org}/uploads/${fileObjectId}/complete`, {
      consent: consent({ consentVersion: v2 }),
    });
    expect(forged.statusCode).toBe(400);
    const done = await w.member.post(`/orgs/${w.org}/uploads/${fileObjectId}/complete`, {});
    expect(done.statusCode, JSON.stringify(done.json())).toBe(200);
    const receipt = w.consents.rows.find((r) => r.subjectId === fileObjectId)!;
    expect(receipt.consentVersion).toBe(CURRENT_CONSENT_VERSION);
    expect(w.jobs.jobs).toEqual([
      expect.objectContaining({
        kind: 'process_upload',
        subjectId: fileObjectId,
        consentAttestationId: receipt.id,
      }),
    ]);
  });

  it('(a) the reconciler processes a grandfathered upload instead of skipping it', async () => {
    const w = await setup();
    const init = await w.upload(w.member, w.org, CURRENT_CONSENT_VERSION);
    const { fileObjectId } = init.json<{ fileObjectId: string }>();
    await w.editNotice('Edited while the upload was processing.');
    const receipt = w.consents.rows.find((r) => r.subjectId === fileObjectId)!;
    const r = await reconcileStaleMedia({
      store: {
        organizationIds: async () => [w.org],
        staleUploads: async () => [{ id: fileObjectId, meetingId: null }],
      },
      consents: w.consents,
      jobs: w.jobs,
      now: () => new Date(),
      olderThanMs: 0,
    });
    expect(r).toEqual({ organizations: 1, uploads: 1, sessions: 0, skipped: 0 });
    expect(w.jobs.jobs).toEqual([
      expect.objectContaining({ subjectId: fileObjectId, consentAttestationId: receipt.id }),
    ]);
    expect(receipt.consentVersion).toBe(CURRENT_CONSENT_VERSION);
  });

  it('with enforcement on, a grant for a superseded version no longer allows capture', async () => {
    const w = await setup(true);
    expect((await w.grant(w.member, w.org, w.meetingId, CURRENT_CONSENT_VERSION)).statusCode).toBe(
      201,
    );
    expect(
      (await w.session(w.member, w.org, w.meetingId, CURRENT_CONSENT_VERSION)).statusCode,
    ).toBe(201);
    const v2 = await w.editNotice('New notice, consent again.');
    // The body version is current, but the meeting's latest grant is for the old notice.
    unsupported(await w.session(w.member, w.org, w.meetingId, v2));
    expect((await w.grant(w.member, w.org, w.meetingId, v2)).statusCode).toBe(201);
    expect((await w.session(w.member, w.org, w.meetingId, v2)).statusCode).toBe(201);
  });
});

describe('orgConsentVersion', () => {
  it('returns the stored version, else the global default', async () => {
    const repo = new InMemoryConsentSettingsRepository();
    const resolve = orgConsentVersion(repo);
    expect(await resolve('o1')).toBe(CURRENT_CONSENT_VERSION);
    const now = new Date('2026-11-18T00:00:00.000Z');
    await repo.update(
      'o1',
      {
        organizationId: 'o1',
        mode: 'all_parties_consented',
        noticeText: 'N',
        skipExternalParticipants: false,
        retentionDays: 90,
        currentConsentVersion: CURRENT_CONSENT_VERSION,
        updatedAt: now,
        updatedById: null,
      },
      (c) => ({ ...c, currentConsentVersion: '2026-11-18' }),
    );
    expect(await resolve('o1')).toBe('2026-11-18');
    expect(await resolve('o2')).toBe(CURRENT_CONSENT_VERSION);
  });
});

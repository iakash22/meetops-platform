import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CURRENT_CONSENT_VERSION,
  MAX_CONSENT_REVOCATION_REASON_LENGTH,
  MEETING_CONSENT_EVENT_TYPES,
  MEETING_CONSENT_PATHS,
  MeetingConsentEvent,
  MeetingConsentStatus,
  RecordMeetingConsentRequest,
  RevokeMeetingConsentRequest,
} from '../src/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const now = '2026-10-31T10:00:00.000Z';
const grant = {
  id,
  meetingId: id,
  eventType: 'granted',
  consentVersion: CURRENT_CONSENT_VERSION,
  method: 'all_parties_consented',
  reason: null,
  actorUserId: id,
  occurredAt: now,
  recordedAt: now,
};

describe('meeting consent contracts', () => {
  it('record request is strict and server-fills identity', () => {
    const ok = {
      consentVersion: CURRENT_CONSENT_VERSION,
      attestedAt: now,
      method: 'all_parties_notified',
    };
    expect(Value.Check(RecordMeetingConsentRequest, ok)).toBe(true);
    for (const extra of ['organizationId', 'userId', 'actorUserId', 'meetingId']) {
      expect(Value.Check(RecordMeetingConsentRequest, { ...ok, [extra]: id })).toBe(false);
    }
    expect(Value.Check(RecordMeetingConsentRequest, { ...ok, method: 'covert' })).toBe(false);
    expect(Value.Check(RecordMeetingConsentRequest, { ...ok, consentVersion: '../x' })).toBe(false);
    expect(Value.Check(RecordMeetingConsentRequest, { method: ok.method })).toBe(false);
  });

  it('revoke request: optional bounded reason, strict', () => {
    expect(Value.Check(RevokeMeetingConsentRequest, {})).toBe(true);
    expect(Value.Check(RevokeMeetingConsentRequest, { reason: 'participant objected' })).toBe(true);
    expect(
      Value.Check(RevokeMeetingConsentRequest, {
        reason: 'x'.repeat(MAX_CONSENT_REVOCATION_REASON_LENGTH + 1),
      }),
    ).toBe(false);
    expect(Value.Check(RevokeMeetingConsentRequest, { reason: '' })).toBe(false);
    expect(Value.Check(RevokeMeetingConsentRequest, { organizationId: id })).toBe(false);
  });

  it('event and status shapes', () => {
    expect(MEETING_CONSENT_EVENT_TYPES).toEqual(['granted', 'revoked']);
    expect(Value.Check(MeetingConsentEvent, grant)).toBe(true);
    const revoke = {
      ...grant,
      eventType: 'revoked',
      consentVersion: null,
      method: null,
      reason: 'no',
    };
    expect(Value.Check(MeetingConsentEvent, revoke)).toBe(true);
    expect(Value.Check(MeetingConsentEvent, { ...grant, organizationId: id })).toBe(false);
    expect(
      Value.Check(MeetingConsentStatus, {
        meetingId: id,
        state: 'revoked',
        valid: false,
        latest: revoke,
        events: [revoke, grant],
      }),
    ).toBe(true);
    expect(
      Value.Check(MeetingConsentStatus, {
        meetingId: id,
        state: 'none',
        valid: false,
        latest: null,
        events: [],
      }),
    ).toBe(true);
  });

  it('paths are org-scoped meeting routes', () => {
    expect(MEETING_CONSENT_PATHS).toEqual({
      consent: '/orgs/:organizationId/meetings/:meetingId/consent',
      revoke: '/orgs/:organizationId/meetings/:meetingId/consent/revoke',
    });
  });
});

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AuthReauthRequiredEvent,
  AuthRevocationMessage,
  AUTH_REVOCATION_REASONS,
  AUTH_REVOCATIONS_CHANNEL,
  OrgAccessChangedEvent,
  REALTIME_CONTROL_EVENTS,
  RealtimeControlEvent,
  RealtimeControlEventSchemas,
  SessionRevokedEvent,
  type ServerToClientEvents,
  MeetingStatusEvent,
  REALTIME_EVENTS,
  RealtimeEvent,
  RealtimeEventSchemas,
  TaskUpdateEvent,
  TranscriptionProgressEvent,
  type RealtimeEventMap,
} from '../src/index.js';

const at = '2026-10-21T17:00:00.000Z';
const ids = {
  organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734',
  meetingId: 'ae7be26c-daa7-42ca-8480-68d5ac90eaca',
};

describe('realtime events', () => {
  it('maps event names to schemas', () => {
    expect(Object.values(REALTIME_EVENTS).sort()).toEqual(Object.keys(RealtimeEventSchemas).sort());
  });
  it('meeting:status uses contract statuses and organizationId', () => {
    expect(Value.Check(MeetingStatusEvent, { ...ids, status: 'processing', at })).toBe(true);
    expect(Value.Check(MeetingStatusEvent, { ...ids, status: 'transcribing', at })).toBe(false);
    expect(
      Value.Check(MeetingStatusEvent, {
        orgId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734',
        meetingId: 'ae7be26c-daa7-42ca-8480-68d5ac90eaca',
        status: 'completed',
        at,
      }),
    ).toBe(false);
  });
  it('transcription:progress bounds percent', () => {
    expect(
      Value.Check(TranscriptionProgressEvent, { ...ids, percent: 42, stage: 'chunking', at }),
    ).toBe(true);
    expect(Value.Check(TranscriptionProgressEvent, { ...ids, percent: 101, at })).toBe(false);
  });
  it('task:update uses contract task statuses', () => {
    const e: RealtimeEventMap['task:update'] = {
      organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734',
      taskId: '83f1535f-99ab-4bf4-89d0-2dfd85d3e3f7',
      status: 'todo',
      at,
    };
    expect(Value.Check(TaskUpdateEvent, e)).toBe(true);
    expect(Value.Check(TaskUpdateEvent, { ...e, status: 'open' })).toBe(false);
  });
  it('discriminated union checks payload against event name', () => {
    expect(
      Value.Check(RealtimeEvent, {
        event: 'meeting:status',
        data: { ...ids, status: 'failed', at },
      }),
    ).toBe(true);
    expect(
      Value.Check(RealtimeEvent, { event: 'task:update', data: { ...ids, status: 'failed', at } }),
    ).toBe(false);
  });
});

describe('v0.4.1 realtime control events (G2, ADR-011 section 5)', () => {
  const orgId = ids.organizationId;
  it('maps control event names to schemas and keeps them out of the domain events', () => {
    expect(Object.values(REALTIME_CONTROL_EVENTS).sort()).toEqual(
      Object.keys(RealtimeControlEventSchemas).sort(),
    );
    expect(Object.values(REALTIME_CONTROL_EVENTS).sort()).toEqual([
      'auth:reauth-required',
      'org:access-changed',
      'session:revoked',
    ]);
    for (const name of Object.values(REALTIME_CONTROL_EVENTS))
      expect(Object.keys(RealtimeEventSchemas)).not.toContain(name);
  });
  it('session:revoked carries a reason and time only', () => {
    expect(Value.Check(SessionRevokedEvent, { reason: 'logout', at })).toBe(true);
    expect(Value.Check(SessionRevokedEvent, { reason: 'extension_revoked', at })).toBe(true);
    expect(Value.Check(SessionRevokedEvent, { reason: 'hacked', at })).toBe(false);
    expect(Value.Check(SessionRevokedEvent, { reason: 'logout' })).toBe(false);
    expect(Value.Check(SessionRevokedEvent, { reason: 'logout', at, sessionId: orgId })).toBe(
      false,
    );
    expect(Value.Check(SessionRevokedEvent, { reason: 'logout', at, token: 'x' })).toBe(false);
  });
  it('org:access-changed: member_removed without role, role_changed with role', () => {
    expect(
      Value.Check(OrgAccessChangedEvent, { organizationId: orgId, reason: 'member_removed', at }),
    ).toBe(true);
    expect(
      Value.Check(OrgAccessChangedEvent, {
        organizationId: orgId,
        reason: 'role_changed',
        role: 'viewer',
        at,
      }),
    ).toBe(true);
    expect(
      Value.Check(OrgAccessChangedEvent, { organizationId: orgId, reason: 'role_changed', at }),
    ).toBe(false);
    expect(
      Value.Check(OrgAccessChangedEvent, {
        organizationId: orgId,
        reason: 'member_removed',
        role: 'viewer',
        at,
      }),
    ).toBe(false);
    expect(
      Value.Check(OrgAccessChangedEvent, {
        organizationId: orgId,
        reason: 'role_changed',
        role: 'superuser',
        at,
      }),
    ).toBe(false);
    expect(
      Value.Check(OrgAccessChangedEvent, { organizationId: 'nope', reason: 'member_removed', at }),
    ).toBe(false);
    expect(
      Value.Check(OrgAccessChangedEvent, { organizationId: orgId, reason: 'logout', at }),
    ).toBe(false);
  });
  it('auth:reauth-required carries a reauth reason', () => {
    for (const reason of ['org_switch', 'session_expired', 'revalidation_failed']) {
      expect(Value.Check(AuthReauthRequiredEvent, { reason, at })).toBe(true);
    }
    expect(Value.Check(AuthReauthRequiredEvent, { reason: 'logout', at })).toBe(false);
    expect(
      Value.Check(AuthReauthRequiredEvent, { reason: 'org_switch', at, organizationId: orgId }),
    ).toBe(false);
  });
  it('RealtimeControlEvent checks payload against event name', () => {
    expect(
      Value.Check(RealtimeControlEvent, {
        event: 'session:revoked',
        data: { reason: 'logout_all', at },
      }),
    ).toBe(true);
    expect(
      Value.Check(RealtimeControlEvent, {
        event: 'auth:reauth-required',
        data: { reason: 'org_switch', at },
      }),
    ).toBe(true);
    expect(
      Value.Check(RealtimeControlEvent, {
        event: 'session:revoked',
        data: { reason: 'session_expired', at },
      }),
    ).toBe(false);
    expect(
      Value.Check(RealtimeControlEvent, {
        event: 'meeting:status',
        data: { ...ids, status: 'failed', at },
      }),
    ).toBe(false);
  });
  it('ServerToClientEvents covers domain and control events', () => {
    const handlers: Pick<ServerToClientEvents, 'session:revoked' | 'meeting:status'> = {
      'session:revoked': (p) => void p.reason,
      'meeting:status': (p) => void p.status,
    };
    expect(Object.keys(handlers)).toHaveLength(2);
  });
});

describe('v0.4.1 AuthRevocationMessage (ADR-011 section 3)', () => {
  const userId = '83f1535f-99ab-4bf4-89d0-2dfd85d3e3f7';
  const sessionId = '4b5b2d52-7c1e-4d8a-9a43-0f1d1f6f2a11';
  const organizationId = ids.organizationId;
  it('uses the meetops:auth:revocations channel', () =>
    expect(AUTH_REVOCATIONS_CHANNEL).toBe('meetops:auth:revocations'));
  it('covers the six API events plus password change and extension revoke', () => {
    expect([...AUTH_REVOCATION_REASONS].sort()).toEqual([
      'extension_revoked',
      'invitation_revoked',
      'logout',
      'logout_all',
      'member_removed',
      'org_switch',
      'password_changed',
      'role_changed',
    ]);
  });
  it('accepts one message per kind', () => {
    expect(
      Value.Check(AuthRevocationMessage, {
        v: 1,
        kind: 'session',
        sessionId,
        userId,
        organizationId,
        reason: 'logout',
        at,
      }),
    ).toBe(true);
    expect(
      Value.Check(AuthRevocationMessage, {
        v: 1,
        kind: 'session',
        sessionId,
        userId,
        reason: 'extension_revoked',
        at,
      }),
    ).toBe(true);
    expect(
      Value.Check(AuthRevocationMessage, { v: 1, kind: 'user', userId, reason: 'logout_all', at }),
    ).toBe(true);
    expect(
      Value.Check(AuthRevocationMessage, {
        v: 1,
        kind: 'membership',
        userId,
        organizationId,
        reason: 'member_removed',
        at,
      }),
    ).toBe(true);
  });
  it('rejects missing ids, wrong version and unknown kinds', () => {
    expect(
      Value.Check(AuthRevocationMessage, { v: 1, kind: 'session', userId, reason: 'logout', at }),
    ).toBe(false);
    expect(
      Value.Check(AuthRevocationMessage, {
        v: 1,
        kind: 'membership',
        userId,
        reason: 'role_changed',
        at,
      }),
    ).toBe(false);
    expect(
      Value.Check(AuthRevocationMessage, { v: 2, kind: 'user', userId, reason: 'logout_all', at }),
    ).toBe(false);
    expect(
      Value.Check(AuthRevocationMessage, { v: 1, kind: 'org', userId, reason: 'logout_all', at }),
    ).toBe(false);
    expect(
      Value.Check(AuthRevocationMessage, { v: 1, kind: 'user', userId, reason: 'nope', at }),
    ).toBe(false);
  });
  it('is ids only: never a token, cookie or hash', () => {
    for (const extra of [
      { token: 'x' },
      { tokenHash: 'a'.repeat(64) },
      { cookie: 'sid=1' },
      { email: 'a@b.co' },
    ]) {
      expect(
        Value.Check(AuthRevocationMessage, {
          v: 1,
          kind: 'user',
          userId,
          reason: 'logout_all',
          at,
          ...extra,
        }),
      ).toBe(false);
    }
  });
});

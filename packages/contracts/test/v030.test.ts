import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as C from '../src/index.js';
import {
  ApiErrorCode, EXTENSION_SCOPES, EXTENSION_TOKEN_TTL_SECONDS, ExtensionTokenRequest, ExtensionTokenResponse,
  ExtractedTask, GetMeetingParams, ListTasksQuery, MeetingParticipant, PresignedUrlString, ResolveMeetingRequest,
  ResolveMeetingResponse, SwitchOrganizationRequest, TASK_STATUSES, Task, TaskStatus, Transcript,
  type TaskStatusValue,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-21T17:00:00.000Z';

describe('ResolveMeetingRequest', () => {
  it('requires externalMeetingUrl or externalMeetingId', () => {
    expect(Value.Check(ResolveMeetingRequest, { source: 'extension', externalMeetingUrl: 'https://meet.google.com/abc-defg-hij' })).toBe(true);
    expect(Value.Check(ResolveMeetingRequest, { source: 'extension', externalMeetingId: 'zoom:123456789' })).toBe(true);
    expect(
      Value.Check(ResolveMeetingRequest, {
        source: 'extension', externalMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/x', externalMeetingId: 'teams:x', title: 'Standup', startedAt: at,
      }),
    ).toBe(true);
    expect(Value.Check(ResolveMeetingRequest, { source: 'extension', title: 'No ids' })).toBe(false);
  });
  it('is strict and validates fields', () => {
    const ok = { source: 'extension', externalMeetingId: 'meet:abc' };
    expect(Value.Check(ResolveMeetingRequest, { ...ok, organizationId: id(1) })).toBe(false);
    expect(Value.Check(ResolveMeetingRequest, { ...ok, source: 'phone' })).toBe(false);
    expect(Value.Check(ResolveMeetingRequest, { ...ok, externalMeetingId: 'x'.repeat(256) })).toBe(false);
    expect(Value.Check(ResolveMeetingRequest, { ...ok, title: 'x'.repeat(301) })).toBe(false);
    expect(Value.Check(ResolveMeetingRequest, { source: 'extension', externalMeetingUrl: 'http://meet.google.com/x' })).toBe(false);
  });
  it('response', () => {
    expect(Value.Check(ResolveMeetingResponse, { meetingId: id(1), created: true })).toBe(true);
    expect(Value.Check(ResolveMeetingResponse, { meetingId: id(1) })).toBe(false);
  });
});

describe('extension token (ADR-005)', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  it('request', () => {
    const t = { extensionId, deviceId: id(9), pairingCode: 'p'.repeat(43), nonce: 'n'.repeat(43) };
    expect(Value.Check(ExtensionTokenRequest, t)).toBe(true);
    expect(Value.Check(ExtensionTokenRequest, { ...t, extensionId: 'not-an-extension-id' })).toBe(false);
    expect(Value.Check(ExtensionTokenRequest, { ...t, scopes: ['admin'] })).toBe(false);
    expect(Value.Check(ExtensionTokenRequest, { extensionId })).toBe(false);
  });
  it('response carries tokens with limited scopes', () => {
    expect(EXTENSION_TOKEN_TTL_SECONDS).toBe(900);
    expect(EXTENSION_SCOPES).toEqual(['meetings:resolve', 'recordings:write']);
    const r = {
      accessToken: 'a'.repeat(64), refreshToken: 'r'.repeat(64), tokenType: 'Bearer', audience: 'extension', expiresAt: at,
      expiresIn: 900, refreshExpiresAt: at, organizationId: id(1), scopes: ['recordings:write'], nonce: 'n'.repeat(43),
    };
    expect(Value.Check(ExtensionTokenResponse, r)).toBe(true);
    expect(Value.Check(ExtensionTokenResponse, { ...r, scopes: ['tasks:write'] })).toBe(false);
    expect(Value.Check(ExtensionTokenResponse, { ...r, scopes: [] })).toBe(false);
  });
  it('no other auth response schema carries an accessToken or refreshToken', () => {
    for (const name of ['AuthSession', 'GetAuthSessionResponse', 'CsrfResponse']) {
      const keys = Object.keys((C as unknown as Record<string, { properties: object }>)[name]!.properties);
      expect(keys).not.toContain('accessToken');
      expect(keys).not.toContain('refreshToken');
    }
  });
});

describe('FE #48', () => {
  it('CSRF_INVALID code', () => {
    expect(Value.Check(ApiErrorCode, 'CSRF_INVALID')).toBe(true);
  });
  it('SwitchOrganizationRequest and GetMeetingParams are strict', () => {
    expect(Value.Check(SwitchOrganizationRequest, { organizationId: id(1) })).toBe(true);
    expect(Value.Check(SwitchOrganizationRequest, { organizationId: id(1), role: 'owner' })).toBe(false);
    expect(Value.Check(GetMeetingParams, { organizationId: id(1), meetingId: id(2) })).toBe(true);
    expect(Value.Check(GetMeetingParams, { organizationId: 'org_1', meetingId: id(2) })).toBe(false);
  });
  it('ListTasksQuery', () => {
    expect(Value.Check(ListTasksQuery, {})).toBe(true);
    expect(Value.Check(ListTasksQuery, { cursor: 'c', limit: 50, status: 'todo', priority: 'high', assigneeId: id(1), dueBefore: at, q: 'deploy' })).toBe(true);
    expect(Value.Check(ListTasksQuery, { status: ['todo', 'in_progress'] })).toBe(true);
    expect(Value.Check(ListTasksQuery, { status: [] })).toBe(false);
    expect(Value.Check(ListTasksQuery, { status: 'open' })).toBe(false);
    expect(Value.Check(ListTasksQuery, { q: 'x'.repeat(201) })).toBe(false);
    expect(Value.Check(ListTasksQuery, { limit: 101 })).toBe(false);
    expect(Value.Check(ListTasksQuery, { due: 'week' })).toBe(false);
  });
  it('ListTasksQuery unassigned filter', () => {
    expect(Value.Check(ListTasksQuery, { unassigned: true })).toBe(true);
    expect(Value.Check(ListTasksQuery, { unassigned: true, status: 'todo', limit: 10 })).toBe(true);
    expect(Value.Check(ListTasksQuery, { assigneeId: id(1) })).toBe(true);
    expect(Value.Check(ListTasksQuery, { assigneeId: id(1), unassigned: true })).toBe(false);
    expect(Value.Check(ListTasksQuery, { unassigned: false })).toBe(false);
    expect(Value.Check(ListTasksQuery, { unassigned: 'true' })).toBe(false);
    expect(Value.Check(ListTasksQuery, { unassigned: 1 })).toBe(false);
  });
  it('TaskStatus alias', () => {
    const s: TaskStatusValue = 'cancelled';
    const t: Task['status'] = s;
    expect(TASK_STATUSES).toEqual(TaskStatus.anyOf.map((x) => x.const));
    expect(t).toBe('cancelled');
  });
});

describe('DB #mismatch decisions', () => {
  it('ExtractedTask.reportId and Transcript.provider are required', () => {
    expect(ExtractedTask.required).toContain('reportId');
    expect(Transcript.required).toContain('provider');
  });
  it('organizationId is canonical; no orgId, acceptedTaskId or employeeId anywhere', () => {
    const json = JSON.stringify(Object.values(C).filter((v) => typeof v === 'object'));
    expect(json).not.toMatch(/"orgId"|"acceptedTaskId"|"employeeId"/);
    expect(Object.keys(Task.properties)).toContain('extractedTaskId');
    expect(Object.keys(MeetingParticipant.properties)).not.toContain('employeeId');
  });
});

describe('PresignedUrlString userinfo', () => {
  it.each([
    'https://user@s3.example.com/b',
    'https://user:pass@s3.example.com/b',
    'https://s3.example.com@evil.com/b',
    'http://user@localhost:9000/b',
    'http://user:pass@minio:9000/b',
    'http://localhost@evil.com/b',
  ])('rejects %s', (u) => expect(Value.Check(PresignedUrlString, u)).toBe(false));
  it.each(['https://s3.example.com/b/k@v.webm', 'https://s3.example.com/b?x=a@b', 'https://s3.example.com', 'http://minio:9000/b/a@b'])(
    'allows @ outside the authority: %s',
    (u) => expect(Value.Check(PresignedUrlString, u)).toBe(true),
  );
});

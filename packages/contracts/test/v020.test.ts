import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AbortRecordingSessionRequest, ChunkUploadUrlRequest, ChunkUploadUrlResponse, CHUNK_UPLOAD_URL_TTL_SECONDS,
  CompleteRecordingSessionRequest, CompleteRecordingSessionResponse, ExtractedTask, Id,
  InitRecordingSessionRequest, MAX_CHUNK_BYTES, MAX_RECORDING_SESSION_BYTES, Meeting, MeetingParticipant,
  ModelRouteId, Report, ReportContent, ResetPasswordRequest, Task, Transcript, VerifyEmailRequest,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-21T17:00:00.000Z';

describe('ids', () => {
  it('are uuid', () => {
    expect(Value.Check(Id, id(1))).toBe(true);
    expect(Value.Check(Id, 'ckabc123')).toBe(false);
  });
});

describe('reset password / verify email', () => {
  const token = 't'.repeat(43);
  it('validates token and password lengths and rejects extras', () => {
    expect(Value.Check(ResetPasswordRequest, { token, password: 'correct-horse-battery' })).toBe(true);
    expect(Value.Check(ResetPasswordRequest, { token: 'short', password: 'correct-horse-battery' })).toBe(false);
    expect(Value.Check(ResetPasswordRequest, { token, password: 'short' })).toBe(false);
    expect(Value.Check(ResetPasswordRequest, { token, password: 'correct-horse-battery', email: 'a@b.co' })).toBe(false);
    expect(Value.Check(VerifyEmailRequest, { token })).toBe(true);
    expect(Value.Check(VerifyEmailRequest, { token: 'x'.repeat(513) })).toBe(false);
    expect(Value.Check(VerifyEmailRequest, { token, userId: id(1) })).toBe(false);
  });
});

describe('chunked recording session', () => {
  it('init', () => {
    const ok = { mimeType: 'audio/webm;codecs=opus', startedAt: at, source: 'tab', meetingId: '00000000-0000-4000-8000-000000000099' };
    expect(Value.Check(InitRecordingSessionRequest, ok)).toBe(true);
    expect(Value.Check(InitRecordingSessionRequest, { ...ok, mimeType: 'text/html' })).toBe(false);
    expect(Value.Check(InitRecordingSessionRequest, { ...ok, source: 'screen' })).toBe(false);
    expect(Value.Check(InitRecordingSessionRequest, { ...ok, extra: 1 })).toBe(false);
  });
  it('chunk url', () => {
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: 1024 })).toBe(true);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: -1, sizeBytes: 1024 })).toBe(false);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 1.5, sizeBytes: 1024 })).toBe(false);
    const res = { seq: 0, upload: { url: 'https://s3.example.com/c0', method: 'PUT', headers: { 'content-length': '1024' }, expiresAt: at } };
    expect(Value.Check(ChunkUploadUrlResponse, res)).toBe(true);
    expect(Value.Check(ChunkUploadUrlResponse, { ...res, upload: { ...res.upload, method: 'GET' } })).toBe(false);
    expect(CHUNK_UPLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(900);
    expect(MAX_CHUNK_BYTES).toBeLessThan(MAX_RECORDING_SESSION_BYTES);
    expect(MAX_RECORDING_SESSION_BYTES).toBe(2_000_000_000);
  });
  it('complete and abort', () => {
    expect(Value.Check(CompleteRecordingSessionRequest, { chunkCount: 12, durationMs: 60000 })).toBe(true);
    expect(Value.Check(CompleteRecordingSessionRequest, { chunkCount: 0, durationMs: 0 })).toBe(false);
    expect(Value.Check(CompleteRecordingSessionResponse, { status: 'processing' })).toBe(true);
    expect(Value.Check(AbortRecordingSessionRequest, { reason: 'consent_revoked' })).toBe(true);
    expect(Value.Check(AbortRecordingSessionRequest, { reason: 'x'.repeat(10) })).toBe(false);
  });
});

describe('DB #25 alignment', () => {
  it('Task links to ExtractedTask; ExtractedTask has segment ids and no acceptedTaskId', () => {
    expect(Object.keys(Task.properties)).toContain('extractedTaskId');
    expect(Object.keys(ExtractedTask.properties)).not.toContain('acceptedTaskId');
    expect(Object.keys(ExtractedTask.properties)).toContain('sourceSegmentIds');
  });
  it('Report has structured content and nullable aiRunId', () => {
    const content = { summary: 's', decisions: ['d'], risks: [], actionItems: [{ title: 'Ship', assigneeHint: 'Ana' }] };
    expect(Value.Check(ReportContent, content)).toBe(true);
    expect(Value.Check(ReportContent, { ...content, html: '<b>' })).toBe(false);
    const r = { id: id(1), organizationId: id(2), meetingId: id(3), ...content, aiRunId: null, createdAt: at };
    expect(Value.Check(Report, r)).toBe(true);
    expect(Object.keys(Report.properties)).not.toContain('modelRouteId');
  });
  it('Transcript has provider and optional providerJobId', () => {
    const t = { id: id(1), meetingId: id(2), recordingId: id(3), provider: 'assemblyai', providerJobId: 'aai_1', segments: [], createdAt: at };
    expect(Value.Check(Transcript, t)).toBe(true);
    expect(Value.Check(Transcript, { ...t, provider: 'whisper-api' })).toBe(false);
  });
  it('Meeting.createdById is nullable', () => {
    const m = { id: id(1), organizationId: id(2), title: 'Bot', source: 'bot', status: 'scheduled', createdById: null, createdAt: at, updatedAt: at };
    expect(Value.Check(Meeting, m)).toBe(true);
  });
  it('MeetingParticipant', () => {
    const p = { id: id(1), meetingId: id(2), organizationId: id(3), userId: null, displayName: 'Guest', email: null, role: 'participant' };
    expect(Value.Check(MeetingParticipant, p)).toBe(true);
    expect(Value.Check(MeetingParticipant, { ...p, role: 'attendee' })).toBe(false);
  });
  it('model route example', () => {
    expect(Value.Check(ModelRouteId, 'gemini:gemini-2.5-flash-lite')).toBe(true);
  });
});

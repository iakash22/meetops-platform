import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AiJobPayload,
  ApiErrorEnvelope,
  CursorPage,
  FileObject,
  Membership,
  ROLES,
  TranscriptionJobPayload,
  Transcript,
  type AiJobPayload as AiJob,
} from '../src/index.js';

const now = '2026-10-21T17:00:00.000Z';

describe('domain schemas', () => {
  it('accepts a provider-independent FileObject', () => {
    expect(
      Value.Check(FileObject, {
        id: 'f1', organizationId: 'o1', provider: 'minio', bucket: 'rec', key: 'a/b.webm',
        mimeType: 'audio/webm', sizeBytes: 1024, createdAt: now,
      }),
    ).toBe(true);
  });
  it('rejects negative file size', () => {
    expect(
      Value.Check(FileObject, {
        id: 'f1', organizationId: 'o1', provider: 's3', bucket: 'b', key: 'k',
        mimeType: 'audio/webm', sizeBytes: -1, createdAt: now,
      }),
    ).toBe(false);
  });
  it('validates membership roles', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'member', 'viewer']);
    const m = { id: 'm1', organizationId: 'o1', userId: 'u1', role: 'admin', createdAt: now };
    expect(Value.Check(Membership, m)).toBe(true);
    expect(Value.Check(Membership, { ...m, role: 'superuser' })).toBe(false);
  });
  it('validates transcript segments', () => {
    expect(
      Value.Check(Transcript, {
        id: 't1', meetingId: 'mt1', recordingId: 'r1', providerId: 'assemblyai', createdAt: now,
        segments: [{ index: 0, startMs: 0, endMs: 1200, speaker: 'A', text: 'hi' }],
      }),
    ).toBe(true);
  });
});

describe('api schemas', () => {
  it('validates the error envelope', () => {
    expect(Value.Check(ApiErrorEnvelope, { error: { code: 'NOT_FOUND', message: 'x' } })).toBe(true);
    expect(Value.Check(ApiErrorEnvelope, { error: { code: 'NOPE', message: 'x' } })).toBe(false);
  });
  it('builds a cursor page schema', () => {
    const S = CursorPage(Membership);
    expect(Value.Check(S, { items: [], nextCursor: null })).toBe(true);
  });
});

describe('job payloads', () => {
  const base = { jobVersion: 1, organizationId: 'o1', idempotencyKey: 'k1' } as const;
  it('accepts a gemini route and rejects unknown providers', () => {
    const job: AiJob = {
      ...base, kind: 'extract_tasks', meetingId: 'm', transcriptId: 't',
      modelRouteId: 'gemini:gemini-2.0-flash', promptVersion: 'v1',
    };
    expect(Value.Check(AiJobPayload, job)).toBe(true);
    expect(Value.Check(AiJobPayload, { ...job, modelRouteId: 'anthropic:claude' })).toBe(false);
  });
  it('defaults to no paid fallback', () => {
    const job = Value.Default(TranscriptionJobPayload, {
      ...base, kind: 'transcribe_recording', meetingId: 'm', recordingId: 'r', fileObjectId: 'f',
      sttProviderId: 'assemblyai', fallback: {},
    }) as { fallback: { allowPaidFallback: boolean; fallbackRouteIds: string[] }; diarize: boolean };
    expect(job.fallback.allowPaidFallback).toBe(false);
    expect(job.fallback.fallbackRouteIds).toEqual([]);
    expect(job.diarize).toBe(true);
  });
});

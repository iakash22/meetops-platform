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
        id: 'bd19836d-db62-411c-85ab-251ccaca5645', organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', provider: 'minio', bucket: 'rec', key: 'a/b.webm',
        mimeType: 'audio/webm', sizeBytes: 1024, createdAt: now,
      }),
    ).toBe(true);
  });
  it('rejects negative file size', () => {
    expect(
      Value.Check(FileObject, {
        id: 'bd19836d-db62-411c-85ab-251ccaca5645', organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', provider: 's3', bucket: 'b', key: 'k',
        mimeType: 'audio/webm', sizeBytes: -1, createdAt: now,
      }),
    ).toBe(false);
  });
  it('validates membership roles', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'member', 'viewer']);
    const m = { id: 'ae7be26c-daa7-42ca-8480-68d5ac90eaca', organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', userId: 'e4774cdd-a079-4f86-814e-8b9140bb6db4', role: 'admin', createdAt: now };
    expect(Value.Check(Membership, m)).toBe(true);
    expect(Value.Check(Membership, { ...m, role: 'superuser' })).toBe(false);
  });
  it('validates transcript segments', () => {
    expect(
      Value.Check(Transcript, {
        id: '83f1535f-99ab-4bf4-89d0-2dfd85d3e3f7', meetingId: '47dba6d1-d17e-46a7-89ec-7e51d3f02c0e', recordingId: '7c92cf1e-ee8d-49cc-85f8-355a3d6e4b86', provider: 'assemblyai', createdAt: now,
        segments: [{ id: '9e1bfb06-75ab-4b16-88d0-088f241f68d8', index: 0, startMs: 0, endMs: 1200, speaker: 'A', text: 'hi' }],
      }),
    ).toBe(true);
  });
});

describe('api schemas', () => {
  it('validates the error envelope', () => {
    expect(Value.Check(ApiErrorEnvelope, { error: { code: 'NOT_FOUND', message: 'x', requestId: '7c92cf1e-ee8d-49cc-85f8-355a3d6e4b86' } })).toBe(true);
    expect(Value.Check(ApiErrorEnvelope, { error: { code: 'NOPE', message: 'x', requestId: '7c92cf1e-ee8d-49cc-85f8-355a3d6e4b86' } })).toBe(false);
  });
  it('builds a cursor page schema', () => {
    const S = CursorPage(Membership);
    expect(Value.Check(S, { items: [], nextCursor: null })).toBe(true);
  });
});

describe('job payloads', () => {
  const base = { jobVersion: 1, organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', idempotencyKey: 'k1' } as const;
  it('accepts a gemini route and rejects unknown providers', () => {
    const job: AiJob = {
      ...base, kind: 'extract_tasks', meetingId: '6f8f5771-5090-4a26-8245-3988d9a1501b', transcriptId: 'e358efa4-89f5-4062-810d-d7316b65649e',
      modelRouteId: 'gemini:gemini-2.0-flash', promptVersion: 'v1',
    };
    expect(Value.Check(AiJobPayload, job)).toBe(true);
    expect(Value.Check(AiJobPayload, { ...job, modelRouteId: 'anthropic:claude' })).toBe(false);
  });
  it('defaults to no paid fallback', () => {
    const job = Value.Default(TranscriptionJobPayload, {
      ...base, kind: 'transcribe_recording', meetingId: '6f8f5771-5090-4a26-8245-3988d9a1501b', recordingId: '4b43b0ae-e356-44cd-85b9-10189b3dc231', fileObjectId: '8fa14cdd-754f-41cc-8554-c9e71929cce7',
      sttProviderId: 'assemblyai', fallback: {},
    }) as { fallback: { allowPaidFallback: boolean; fallbackRouteIds: string[] }; diarize: boolean };
    expect(job.fallback.allowPaidFallback).toBe(false);
    expect(job.fallback.fallbackRouteIds).toEqual([]);
    expect(job.diarize).toBe(true);
  });
});

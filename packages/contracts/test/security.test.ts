import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ApiErrorCode,
  ApiErrorEnvelope,
  CreateUploadRequest,
  CreateUploadResponse,
  ExtractedTask,
  FallbackPolicy,
  IntegrationIssue,
  MAX_UPLOAD_BYTES,
  PublicFileObject,
  User,
} from '../src/index.js';

const now = '2026-10-21T17:00:00.000Z';

describe('error envelope', () => {
  it('requires requestId', () => {
    expect(Value.Check(ApiErrorEnvelope, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: '7c92cf1e-ee8d-49cc-85f8-355a3d6e4b86' } })).toBe(true);
    expect(Value.Check(ApiErrorEnvelope, { error: { code: 'NOT_FOUND', message: 'Not found' } })).toBe(false);
  });
  it('has no account-enumeration codes', () => {
    const codes = ApiErrorCode.anyOf.map((s) => s.const as string);
    expect(codes).toContain('AUTH_FAILED');
    for (const bad of ['USER_EXISTS', 'EMAIL_NOT_FOUND', 'USER_NOT_FOUND', 'EMAIL_TAKEN']) expect(codes).not.toContain(bad);
  });
});

describe('files and uploads', () => {
  it('PublicFileObject exposes no storage location', () => {
    const keys = Object.keys(PublicFileObject.properties);
    for (const k of ['bucket', 'key', 'provider']) expect(keys).not.toContain(k);
    expect(
      Value.Check(PublicFileObject, {
        id: 'bd19836d-db62-411c-85ab-251ccaca5645', organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', mimeType: 'audio/webm', sizeBytes: 10, createdAt: now,
        download: { url: 'https://cdn.example.com/x?sig=1', method: 'GET', expiresAt: now },
      }),
    ).toBe(true);
    expect(
      Value.Check(PublicFileObject, {
        id: 'bd19836d-db62-411c-85ab-251ccaca5645', organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', mimeType: 'audio/webm', sizeBytes: 10, createdAt: now, bucket: 'b',
      }),
    ).toBe(true); // response objects are open; mappers must build from the schema
  });
  it('CreateUploadRequest limits', () => {
    const ok = { filename: 'standup.webm', mimeType: 'audio/webm', sizeBytes: 1024, meetingId: 'ae7be26c-daa7-42ca-8480-68d5ac90eaca' };
    expect(Value.Check(CreateUploadRequest, ok)).toBe(true);
    expect(Value.Check(CreateUploadRequest, { ...ok, sizeBytes: 0 })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, sizeBytes: MAX_UPLOAD_BYTES + 1 })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, filename: '../etc/passwd' })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, mimeType: 'text/html' })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, bucket: 'other' })).toBe(false);
  });
  it('CreateUploadResponse requires an https presigned URL', () => {
    const r = { fileObjectId: 'bd19836d-db62-411c-85ab-251ccaca5645', upload: { url: 'https://s3.example.com/u', method: 'PUT', headers: { 'content-type': 'audio/webm' }, expiresAt: now } };
    expect(Value.Check(CreateUploadResponse, r)).toBe(true);
    expect(Value.Check(CreateUploadResponse, { ...r, upload: { ...r.upload, url: 'http://s3.example.com/u' } })).toBe(false);
  });
});

describe('low-severity hardening', () => {
  it('fallbackRouteIds must be model route ids', () => {
    expect(Value.Check(FallbackPolicy, { fallbackRouteIds: ['ollama:llama3.1'], allowPaidFallback: false })).toBe(true);
    expect(Value.Check(FallbackPolicy, { fallbackRouteIds: ['anything'], allowPaidFallback: false })).toBe(false);
  });
  it('avatarUrl and externalUrl must be https', () => {
    const u = { id: 'e4774cdd-a079-4f86-814e-8b9140bb6db4', email: 'a@b.co', createdAt: now, updatedAt: now };
    expect(Value.Check(User, { ...u, avatarUrl: 'https://img.example.com/a.png' })).toBe(true);
    expect(Value.Check(User, { ...u, avatarUrl: 'javascript:alert(1)' })).toBe(false);
    const i = { id: '9dd4e461-268c-4034-85c8-564e155c67a6', taskId: 'e358efa4-89f5-4062-810d-d7316b65649e', integration: 'linear', externalId: 'L-1', createdAt: now };
    expect(Value.Check(IntegrationIssue, { ...i, externalUrl: 'http://linear.app/x' })).toBe(false);
  });
  it('assigneeHint is documented as untrusted', () => {
    expect(ExtractedTask.properties.assigneeHint.description).toMatch(/UNTRUSTED/);
  });
});

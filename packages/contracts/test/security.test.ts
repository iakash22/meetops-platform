import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ApiErrorCode,
  ApiErrorEnvelope,
  CreateUploadRequest,
  CreateUploadResponse,
  EmailJobPayload,
  ExtractedTask,
  FallbackPolicy,
  IntegrationIssue,
  MAX_UPLOAD_BYTES,
  PublicFileObject,
  User,
} from '../src/index.js';

const now = '2026-10-21T17:00:00.000Z';
const meta = { jobVersion: 1, organizationId: 'o1', idempotencyKey: 'k1', kind: 'send_email', templateId: 'password_reset' };

describe('email job payload (ids only)', () => {
  it('accepts userId or invitationId', () => {
    expect(Value.Check(EmailJobPayload, { ...meta, userId: 'u1' })).toBe(true);
    expect(Value.Check(EmailJobPayload, { ...meta, invitationId: 'i1' })).toBe(true);
  });
  it('rejects emails, tokens, links and missing ids', () => {
    expect(Value.Check(EmailJobPayload, meta)).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...meta, userId: 'u1', to: [{ email: 'a@b.co' }] })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...meta, userId: 'u1', resetToken: 'x' })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...meta, userId: 'u1', link: 'https://x' })).toBe(false);
  });
});

describe('error envelope', () => {
  it('requires requestId', () => {
    expect(Value.Check(ApiErrorEnvelope, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r1' } })).toBe(true);
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
        id: 'f1', organizationId: 'o1', mimeType: 'audio/webm', sizeBytes: 10, createdAt: now,
        download: { url: 'https://cdn.example.com/x?sig=1', method: 'GET', expiresAt: now },
      }),
    ).toBe(true);
    expect(
      Value.Check(PublicFileObject, {
        id: 'f1', organizationId: 'o1', mimeType: 'audio/webm', sizeBytes: 10, createdAt: now, bucket: 'b',
      }),
    ).toBe(true); // response objects are open; mappers must build from the schema
  });
  it('CreateUploadRequest limits', () => {
    const ok = { filename: 'standup.webm', mimeType: 'audio/webm', sizeBytes: 1024, meetingId: 'm1' };
    expect(Value.Check(CreateUploadRequest, ok)).toBe(true);
    expect(Value.Check(CreateUploadRequest, { ...ok, sizeBytes: 0 })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, sizeBytes: MAX_UPLOAD_BYTES + 1 })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, filename: '../etc/passwd' })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, mimeType: 'text/html' })).toBe(false);
    expect(Value.Check(CreateUploadRequest, { ...ok, bucket: 'other' })).toBe(false);
  });
  it('CreateUploadResponse requires an https presigned URL', () => {
    const r = { fileObjectId: 'f1', upload: { url: 'https://s3.example.com/u', method: 'PUT', headers: { 'content-type': 'audio/webm' }, expiresAt: now } };
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
    const u = { id: 'u1', email: 'a@b.co', createdAt: now, updatedAt: now };
    expect(Value.Check(User, { ...u, avatarUrl: 'https://img.example.com/a.png' })).toBe(true);
    expect(Value.Check(User, { ...u, avatarUrl: 'javascript:alert(1)' })).toBe(false);
    const i = { id: 'x', taskId: 't', integration: 'linear', externalId: 'L-1', createdAt: now };
    expect(Value.Check(IntegrationIssue, { ...i, externalUrl: 'http://linear.app/x' })).toBe(false);
  });
  it('assigneeHint is documented as untrusted', () => {
    expect(ExtractedTask.properties.assigneeHint.description).toMatch(/UNTRUSTED/);
  });
});

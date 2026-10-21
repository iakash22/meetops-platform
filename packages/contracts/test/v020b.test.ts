import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as C from '../src/index.js';
import * as Legacy from '../src/legacy.js';
import {
  ALLOWED_MEDIA_MIME_TYPES, CreateUploadRequest, EmailJobPayload, EmailTemplateId, InitRecordingSessionRequest,
  MAX_MEDIA_BYTES, MAX_RECORDING_SESSION_BYTES, MAX_UPLOAD_BYTES, MediaMimeType,
} from '../src/index.js';
import type { PresignedUrl } from '../src/legacy.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const meta = { jobVersion: 1, organizationId: id(1), idempotencyKey: 'k', kind: 'send_email' };

describe('N1 legacy subpath', () => {
  it('main barrel no longer exposes legacy storage types', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports).toHaveProperty('./legacy');
    const p: PresignedUrl = { url: 'https://x', expiresAt: new Date(), method: 'GET' };
    expect(p.method).toBe('GET');
    expect(Object.keys(Legacy)).toEqual([]); // type-only module
    expect(C).not.toHaveProperty('PresignedUrl');
  });
});

describe('N2 email template discriminator', () => {
  it('invite needs invitationId', () => {
    expect(Value.Check(EmailJobPayload, { ...meta, templateId: 'invite', invitationId: id(2) })).toBe(true);
    expect(Value.Check(EmailJobPayload, { ...meta, templateId: 'invite', userId: id(2) })).toBe(false);
  });
  it.each(['verify_email', 'reset_password', 'meeting_summary'])('%s needs userId', (t) => {
    expect(Value.Check(EmailJobPayload, { ...meta, templateId: t, userId: id(2) })).toBe(true);
    expect(Value.Check(EmailJobPayload, { ...meta, templateId: t, invitationId: id(2) })).toBe(false);
  });
  it('rejects unknown templates', () => {
    expect(Value.Check(EmailTemplateId, 'marketing')).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...meta, templateId: 'marketing', userId: id(2) })).toBe(false);
  });
});

describe('N3 media limits', () => {
  it('2 GB cap everywhere', () => {
    expect(MAX_MEDIA_BYTES).toBe(2_000_000_000);
    expect(MAX_UPLOAD_BYTES).toBe(MAX_MEDIA_BYTES);
    expect(MAX_RECORDING_SESSION_BYTES).toBe(MAX_MEDIA_BYTES);
    const ok = { filename: 'a.webm', mimeType: 'audio/webm', sizeBytes: 2_000_000_000 };
    expect(Value.Check(CreateUploadRequest, ok)).toBe(true);
    expect(Value.Check(CreateUploadRequest, { ...ok, sizeBytes: 2_000_000_001 })).toBe(false);
  });
  it.each([...ALLOWED_MEDIA_MIME_TYPES])('allows %s', (m) => {
    expect(Value.Check(MediaMimeType, m)).toBe(true);
  });
  it.each(['audio/webm;codecs=opus', 'video/webm; codecs="vp8,opus"', 'video/mp4;codecs=avc1.42E01E'])('allows codecs %s', (m) => {
    expect(Value.Check(MediaMimeType, m)).toBe(true);
  });
  it.each(['audio/flac', 'video/quicktime', 'audio/x-matroska', 'text/html', 'audio/webm;charset=utf-8', 'audio/webmx', 'audio/webm;codecs=opus;x=1'])(
    'rejects %s',
    (m) => {
      expect(Value.Check(MediaMimeType, m)).toBe(false);
    },
  );
  it('recording sessions use the allowlist', () => {
    const r = { startedAt: '2026-10-21T17:00:00.000Z', source: 'tab' };
    expect(Value.Check(InitRecordingSessionRequest, { ...r, mimeType: 'audio/webm;codecs=opus' })).toBe(true);
    expect(Value.Check(InitRecordingSessionRequest, { ...r, mimeType: 'video/quicktime' })).toBe(false);
  });
});

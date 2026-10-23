import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  EMAIL_JOB_RETENTION, EMAIL_QUEUE, EMAIL_TEMPLATE_IDS, EmailJobPayload, EmailTemplateId, QUEUE_NAMES,
  WriteApproval,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = {
  jobVersion: 1,
  kind: 'send_email',
  organizationId: id(1),
  idempotencyKey: 'verify_user-42',
  templateId: 'verification',
  recipient: { userId: id(2) },
};

describe('email queue constants', () => {
  it('queue name and retention', () => {
    expect(EMAIL_QUEUE).toBe('email');
    expect(QUEUE_NAMES.email).toBe(EMAIL_QUEUE);
    expect(EMAIL_JOB_RETENTION).toEqual({
      removeOnComplete: { count: 100, age: 3600 },
      removeOnFail: { count: 500, age: 86400 },
    });
  });
  it('template ids', () => {
    expect(EMAIL_TEMPLATE_IDS).toEqual(['verification', 'password-reset', 'invitation', 'task-assigned', 'meeting-summary']);
    for (const t of EMAIL_TEMPLATE_IDS) expect(Value.Check(EmailTemplateId, t)).toBe(true);
    expect(Value.Check(EmailTemplateId, 'reset_password')).toBe(false);
  });
});

describe('EmailJobPayload (INT shape)', () => {
  it('accepts the minimal and full payloads', () => {
    expect(Value.Check(EmailJobPayload, base)).toBe(true);
    expect(
      Value.Check(EmailJobPayload, {
        ...base,
        templateId: 'task-assigned',
        requestId: 'req_123',
        refs: { taskId: id(3), meetingId: id(4) },
        locale: 'en-IN',
      }),
    ).toBe(true);
  });
  it('binds recipient kind to template', () => {
    expect(Value.Check(EmailJobPayload, { ...base, templateId: 'invitation', recipient: { invitationId: id(5) } })).toBe(true);
    expect(Value.Check(EmailJobPayload, { ...base, templateId: 'invitation', recipient: { userId: id(5) } })).toBe(false);
    for (const t of ['verification', 'password-reset', 'task-assigned', 'meeting-summary']) {
      expect(Value.Check(EmailJobPayload, { ...base, templateId: t, recipient: { userId: id(5) } })).toBe(true);
      expect(Value.Check(EmailJobPayload, { ...base, templateId: t, recipient: { invitationId: id(5) } })).toBe(false);
    }
  });
  it('requestId must be opaque and at most 200 chars', () => {
    expect(Value.Check(EmailJobPayload, { ...base, requestId: 'req_1' })).toBe(true);
    expect(Value.Check(EmailJobPayload, { ...base, requestId: 'has space' })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, requestId: 'x'.repeat(201) })).toBe(false);
  });
  it('rejects bad recipients', () => {
    expect(Value.Check(EmailJobPayload, { ...base, recipient: {} })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, recipient: { userId: id(2), invitationId: id(5) } })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, recipient: { userId: id(2), email: 'a@b.co' } })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, recipient: { userId: 'not-a-uuid' } })).toBe(false);
  });
  it('rejects addresses, variables, URLs and tokens at any level', () => {
    for (const extra of [{ to: 'a@b.co' }, { variables: {} }, { url: 'https://x' }, { token: 'abc' }]) {
      expect(Value.Check(EmailJobPayload, { ...base, ...extra })).toBe(false);
    }
    expect(Value.Check(EmailJobPayload, { ...base, refs: { link: 'https://evil.test/x' } })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, refs: { email: 'a@b.co' } })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, refs: { 'bad key': id(3) } })).toBe(false);
  });
  it('limits refs to 10 keys', () => {
    const refs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, id(i)]));
    expect(Value.Check(EmailJobPayload, { ...base, refs })).toBe(false);
  });
  it('validates idempotencyKey, jobVersion and locale', () => {
    expect(Value.Check(EmailJobPayload, { ...base, idempotencyKey: id(9) })).toBe(true);
    expect(Value.Check(EmailJobPayload, { ...base, idempotencyKey: 'has space' })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, idempotencyKey: 'x'.repeat(201) })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, idempotencyKey: '' })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, jobVersion: 2 })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, version: 1 })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, locale: 'x'.repeat(36) })).toBe(false);
    expect(Value.Check(EmailJobPayload, { ...base, locale: 'en_US' })).toBe(false);
  });
});

describe('WriteApproval', () => {
  const a = { approvalId: id(1), organizationId: id(2), approverUserId: id(3), payloadHash: 'a'.repeat(64) };
  it('accepts a complete reference', () => {
    expect(Value.Check(WriteApproval, a)).toBe(true);
    expect(Value.Check(WriteApproval, { ...a, approvedAt: '2026-10-21T17:00:00.000Z' })).toBe(true);
  });
  it('requires a lowercase sha256 hex hash and no extras', () => {
    expect(Value.Check(WriteApproval, { ...a, payloadHash: 'A'.repeat(64) })).toBe(false);
    expect(Value.Check(WriteApproval, { ...a, payloadHash: 'a'.repeat(63) })).toBe(false);
    expect(Value.Check(WriteApproval, { ...a, approved: true })).toBe(false);
    const { approverUserId: _omit, ...missing } = a;
    void _omit;
    expect(Value.Check(WriteApproval, missing)).toBe(false);
  });
});

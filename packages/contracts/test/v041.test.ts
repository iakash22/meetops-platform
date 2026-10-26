import { describe, it, expect, expectTypeOf } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  API_ERROR_REASONS,
  ApiErrorReason,
  CONSENT_ATTESTATION_MAX_SKEW_SECONDS,
  CONSENT_ERROR_REASONS,
  CONSENT_HTTP_STATUS,
  CONSENT_METHODS,
  CURRENT_CONSENT_VERSION,
  ConsentAttestation,
  ConsentAttestationInput,
  ConsentErrorReason,
  CreateUploadRequest,
  FILE_OBJECT_SCAN_STATUSES,
  FileObject,
  FileObjectScanStatus,
  InitRecordingSessionRequest,
  InitUploadRequest,
  InitUploadResponse,
  CreateUploadResponse,
  MAX_PRESIGNED_GET_TTL_SECONDS,
  MAX_RECORDING_SESSION_BYTES,
  MAX_UPLOAD_BYTES,
  type ConsentErrorEnvelope,
} from '../src/index.js';
import * as Light from '../src/types.js';
import pkg from '../package.json' with { type: 'json' };

const omit = <T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> => {
  const copy = { ...o };
  delete copy[k];
  return copy;
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-21T17:00:00.000Z';
const consent = {
  consentVersion: CURRENT_CONSENT_VERSION,
  attestedAt: '2026-10-21T16:59:00.000Z',
  method: 'all_parties_notified',
};
const session = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: at,
  source: 'tab',
  meetingId: id(9),
  consent,
};
const upload = {
  filename: 'standup.webm',
  mimeType: 'audio/webm',
  sizeBytes: 1024,
  checksumSha256: `${'A'.repeat(43)}=`,
  consent,
};

describe('v0.4.1 package version', () => {
  it('is 0.4.1 or a later 0.x', () => expect(pkg.version).toMatch(/^0\.(4\.[1-9]\d*|[56]\.\d+)$/));
});

describe('v0.4.1 consent attestation (G11)', () => {
  it('accepts a valid attestation for every method', () => {
    for (const method of CONSENT_METHODS)
      expect(Value.Check(ConsentAttestationInput, { ...consent, method })).toBe(true);
    expect(CONSENT_METHODS).toContain('all_parties_notified');
  });
  it('rejects a client-supplied attestedByUserId or organizationId (server-filled)', () => {
    expect(Value.Check(ConsentAttestationInput, { ...consent, attestedByUserId: id(2) })).toBe(
      false,
    );
    expect(Value.Check(ConsentAttestationInput, { ...consent, organizationId: id(1) })).toBe(false);
  });
  it('rejects a missing field, unknown method, bad version or bad timestamp', () => {
    for (const k of ['consentVersion', 'attestedAt', 'method'] as const) {
      expect(Value.Check(ConsentAttestationInput, omit(consent, k))).toBe(false);
    }
    expect(Value.Check(ConsentAttestationInput, { ...consent, method: 'implied' })).toBe(false);
    expect(Value.Check(ConsentAttestationInput, { ...consent, consentVersion: '' })).toBe(false);
    expect(Value.Check(ConsentAttestationInput, { ...consent, consentVersion: '../v1' })).toBe(
      false,
    );
    expect(
      Value.Check(ConsentAttestationInput, { ...consent, consentVersion: 'v'.repeat(33) }),
    ).toBe(false);
    expect(Value.Check(ConsentAttestationInput, { ...consent, attestedAt: 'yesterday' })).toBe(
      false,
    );
  });
  it('stored attestation carries server-filled attestedByUserId', () => {
    const row = {
      id: id(3),
      organizationId: id(1),
      subjectType: 'recording_session',
      subjectId: id(4),
      consentVersion: CURRENT_CONSENT_VERSION,
      method: 'all_parties_notified',
      attestedByUserId: id(2),
      attestedAt: consent.attestedAt,
      recordedAt: at,
    };
    expect(Value.Check(ConsentAttestation, row)).toBe(true);
    expect(Value.Check(ConsentAttestation, { ...row, subjectType: 'upload' })).toBe(true);
    expect(Value.Check(ConsentAttestation, omit(row, 'attestedByUserId'))).toBe(false);
    expect(Value.Check(ConsentAttestation, { ...row, subjectType: 'meeting' })).toBe(false);
  });
  it('skew bound is five minutes', () => expect(CONSENT_ATTESTATION_MAX_SKEW_SECONDS).toBe(300));
});

describe('v0.4.1 init requires consent', () => {
  it('recording-session init without attestation is rejected', () => {
    expect(Value.Check(InitRecordingSessionRequest, session)).toBe(true);
    expect(Value.Check(InitRecordingSessionRequest, omit(session, 'consent'))).toBe(false);
    expect(Value.Check(InitRecordingSessionRequest, { ...session, consent: {} })).toBe(false);
    expect(
      Value.Check(InitRecordingSessionRequest, {
        ...session,
        consent: { ...consent, attestedByUserId: id(2) },
      }),
    ).toBe(false);
  });
  it('upload init without attestation is rejected', () => {
    expect(Value.Check(InitUploadRequest, upload)).toBe(true);
    expect(Value.Check(InitUploadRequest, omit(upload, 'consent'))).toBe(false);
    expect(Value.Check(InitUploadRequest, { ...upload, consent: null })).toBe(false);
    expect(Value.Check(InitUploadRequest, { ...upload, sizeBytes: MAX_UPLOAD_BYTES + 1 })).toBe(
      false,
    );
  });
  it('deprecated CreateUploadRequest is the v0.4.0 shape and cannot carry consent', () => {
    expect(Value.Check(CreateUploadRequest, omit(upload, 'consent'))).toBe(true);
    expect(Value.Check(CreateUploadRequest, upload)).toBe(false);
    expect(InitUploadResponse).toBe(CreateUploadResponse);
  });
  it('consent rejection is 422 VALIDATION_FAILED with a named reason', () => {
    expect(CONSENT_HTTP_STATUS).toBe(422);
    expect([...CONSENT_ERROR_REASONS]).toEqual([
      'CONSENT_REQUIRED',
      'CONSENT_VERSION_UNSUPPORTED',
      'CONSENT_INVALID',
    ]);
    for (const r of CONSENT_ERROR_REASONS) {
      expect(API_ERROR_REASONS).toContain(r);
      expect(Value.Check(ApiErrorReason, r)).toBe(true);
      expect(Value.Check(ConsentErrorReason, r)).toBe(true);
    }
    expect(new Set(API_ERROR_REASONS).size).toBe(API_ERROR_REASONS.length);
    expectTypeOf<ConsentErrorEnvelope['error']['code']>().toEqualTypeOf<'VALIDATION_FAILED'>();
  });
});

describe('v0.4.1 FileObject scan status', () => {
  it('has exactly pending, clean, quarantined, rejected', () => {
    expect([...FILE_OBJECT_SCAN_STATUSES]).toEqual(['pending', 'clean', 'quarantined', 'rejected']);
    for (const s of FILE_OBJECT_SCAN_STATUSES)
      expect(Value.Check(FileObjectScanStatus, s)).toBe(true);
    expect(Value.Check(FileObjectScanStatus, 'infected')).toBe(false);
  });
  it('FileObject.scanStatus is optional and validated', () => {
    const fo = {
      id: id(5),
      organizationId: id(1),
      provider: 's3',
      bucket: 'b',
      key: 'k',
      mimeType: 'audio/webm',
      sizeBytes: 1,
      createdAt: at,
    };
    expect(Value.Check(FileObject, fo)).toBe(true);
    expect(Value.Check(FileObject, { ...fo, scanStatus: 'quarantined' })).toBe(true);
    expect(Value.Check(FileObject, { ...fo, scanStatus: 'infected' })).toBe(false);
  });
});

describe('v0.4.1 G9 limits', () => {
  it('keeps 1.4 GB per session, 4 h max duration and a 300 s GET TTL', () => {
    expect(MAX_RECORDING_SESSION_BYTES).toBe(1_400_000_000);
    expect(Light.MAX_DURATION_MS).toBe(4 * 60 * 60 * 1000);
    expect(MAX_PRESIGNED_GET_TTL_SECONDS).toBe(300);
    expect(Light.MAX_PRESIGNED_GET_TTL_SECONDS).toBe(300);
  });
});

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CONSENT_ERROR_REASONS,
  CONSENT_SETTINGS_WRITE_ROLES,
  CONSENT_UPLOAD_PATHS,
  CURRENT_CONSENT_VERSION,
  CompleteUploadRequest,
  CompleteUploadResponse,
  ConsentSettings,
  DownloadUrlResponse,
  MAX_PRESIGNED_GET_TTL_SECONDS,
  UPLOAD_COMPLETE_CONSENT_ERROR_REASONS,
  UpdateConsentSettingsRequest,
} from '../src/index.js';
import * as Light from '../src/types.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-26T12:00:00.000Z';
const settings = {
  mode: 'all_party',
  noticeText: 'This meeting is recorded.',
  skipExternalParticipants: false,
  retentionDays: 90,
  currentConsentVersion: CURRENT_CONSENT_VERSION,
  updatedAt: at,
};

describe('consent settings (proposal)', () => {
  it('paths follow org-scoped conventions and are in the light entry', () => {
    expect(CONSENT_UPLOAD_PATHS.consentSettings).toBe('/orgs/:organizationId/settings/consent');
    expect(CONSENT_UPLOAD_PATHS.uploadComplete).toBe(
      '/orgs/:organizationId/uploads/:fileObjectId/complete',
    );
    expect(CONSENT_UPLOAD_PATHS.uploadDownloadUrl).toBe(
      '/orgs/:organizationId/uploads/:fileObjectId/download-url',
    );
    expect(Light.CONSENT_UPLOAD_PATHS).toEqual(CONSENT_UPLOAD_PATHS);
  });
  it('only owner/admin may write', () => {
    expect([...CONSENT_SETTINGS_WRITE_ROLES]).toEqual(['owner', 'admin']);
  });
  it('accepts a full settings object and rejects bad values / extra keys', () => {
    expect(Value.Check(ConsentSettings, settings)).toBe(true);
    expect(Value.Check(ConsentSettings, { ...settings, mode: 'none' })).toBe(false);
    expect(Value.Check(ConsentSettings, { ...settings, retentionDays: 0 })).toBe(false);
    expect(Value.Check(ConsentSettings, { ...settings, retentionDays: 3651 })).toBe(false);
    expect(Value.Check(ConsentSettings, { ...settings, noticeText: '' })).toBe(false);
    expect(Value.Check(ConsentSettings, { ...settings, organizationId: id(1) })).toBe(false);
  });
  it('PATCH is partial, non-empty, and cannot set server-owned fields', () => {
    expect(Value.Check(UpdateConsentSettingsRequest, { mode: 'one_party' })).toBe(true);
    expect(
      Value.Check(UpdateConsentSettingsRequest, {
        retentionDays: 30,
        skipExternalParticipants: true,
      }),
    ).toBe(true);
    expect(Value.Check(UpdateConsentSettingsRequest, {})).toBe(false);
    expect(Value.Check(UpdateConsentSettingsRequest, { currentConsentVersion: '2027-01' })).toBe(
      false,
    );
    expect(Value.Check(UpdateConsentSettingsRequest, { updatedAt: at })).toBe(false);
  });
});

describe('upload complete (proposal)', () => {
  it('request is an empty strict object', () => {
    expect(Value.Check(CompleteUploadRequest, {})).toBe(true);
    expect(Value.Check(CompleteUploadRequest, { consent: {} })).toBe(false);
  });
  it('consent error reasons are exactly the G11 reasons', () => {
    expect([...UPLOAD_COMPLETE_CONSENT_ERROR_REASONS]).toEqual([
      'CONSENT_REQUIRED',
      'CONSENT_VERSION_UNSUPPORTED',
      'CONSENT_INVALID',
    ]);
    expect(UPLOAD_COMPLETE_CONSENT_ERROR_REASONS).toBe(CONSENT_ERROR_REASONS);
  });
  it('response carries the file and scan status', () => {
    const fileObject = {
      id: id(2),
      organizationId: id(1),
      mimeType: 'video/webm',
      sizeBytes: 10,
      createdAt: at,
    };
    expect(Value.Check(CompleteUploadResponse, { fileObject, scanStatus: 'pending' })).toBe(true);
    expect(Value.Check(CompleteUploadResponse, { fileObject, scanStatus: 'nope' })).toBe(false);
  });
});

describe('download url (proposal)', () => {
  const ok = {
    url: 'https://storage.example.com/o?X-Amz-Signature=abc',
    method: 'GET',
    expiresIn: 300,
    expiresAt: at,
  };
  it('expiresIn is capped at 300 s', () => {
    expect(MAX_PRESIGNED_GET_TTL_SECONDS).toBe(300);
    expect(Value.Check(DownloadUrlResponse, ok)).toBe(true);
    expect(Value.Check(DownloadUrlResponse, { ...ok, expiresIn: 301 })).toBe(false);
    expect(Value.Check(DownloadUrlResponse, { ...ok, expiresIn: 0 })).toBe(false);
    expect(Value.Check(DownloadUrlResponse, { ...ok, method: 'PUT' })).toBe(false);
  });
});

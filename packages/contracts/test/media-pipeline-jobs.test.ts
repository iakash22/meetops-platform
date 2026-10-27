import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AssembleRecordingSessionJobPayload,
  MEDIA_JOB_NAMES,
  MeetingProcessingFailedPayload,
  UploadScanJobPayload,
} from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('media pipeline job payloads', () => {
  it('names equal kinds', () => {
    expect(Object.values(MEDIA_JOB_NAMES).sort()).toEqual(
      ['assemble_recording_session', 'process_recording', 'process_upload'].sort(),
    );
  });
  it('validates process_upload and assemble_recording_session strictly', () => {
    const up = {
      jobVersion: 1,
      kind: 'process_upload',
      organizationId: ID,
      uploadId: ID,
      consentAttestationId: ID,
    };
    expect(Value.Check(UploadScanJobPayload, up)).toBe(true);
    expect(Value.Check(UploadScanJobPayload, { ...up, key: 'x' })).toBe(false);
    const as = {
      jobVersion: 1,
      kind: 'assemble_recording_session',
      organizationId: ID,
      meetingId: ID,
      sessionId: ID,
      consentAttestationId: ID,
      sourceExt: 'webm',
    };
    expect(Value.Check(AssembleRecordingSessionJobPayload, as)).toBe(true);
    expect(Value.Check(AssembleRecordingSessionJobPayload, { ...as, sourceExt: 'exe' })).toBe(
      false,
    );
  });
  it('processing_failed payload carries ids and a code only', () => {
    const p = {
      organizationId: ID,
      meetingId: ID,
      subjectType: 'recording',
      subjectId: ID,
      errorCode: 'media_processing_failed',
      failedAt: '2026-10-28T00:00:00.000Z',
    };
    expect(Value.Check(MeetingProcessingFailedPayload, p)).toBe(true);
    expect(Value.Check(MeetingProcessingFailedPayload, { ...p, key: 'organizations/x' })).toBe(
      false,
    );
    expect(Value.Check(MeetingProcessingFailedPayload, { ...p, errorCode: 'Bad Code' })).toBe(
      false,
    );
  });
});

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from '@meetops/media-core';
import {
  processUploadScan,
  type ScannableUpload,
  type UploadScanDeps,
} from '../src/media/upload-scan-job.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';
const MEET = '00000000-0000-4000-8000-000000000003';
const CONSENT = '00000000-0000-4000-8000-000000000004';
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>'.padEnd(64, ' '));
const probe: ProbeResult = {
  durationSeconds: 10,
  formatName: 'matroska,webm',
  streams: [{ index: 0, codecType: 'audio', sampleRate: 48000, channels: 1 }],
  hasAudio: true,
  hasVideo: false,
};
const job = (over: Record<string, unknown> = {}) => ({
  kind: 'process_upload',
  organizationId: ORG,
  jobVersion: 1,
  uploadId: ID,
  consentAttestationId: CONSENT,
  meetingId: MEET,
  ...over,
});

function deps(bytes: Buffer, row: Partial<ScannableUpload> | null = {}) {
  const setScanStatus = vi.fn<UploadScanDeps['setScanStatus']>().mockResolvedValue();
  const publishUploadStatus = vi.fn();
  const d: UploadScanDeps = {
    findUpload: vi.fn(async (o: string) =>
      row && o === ORG
        ? {
            id: ID,
            key: 'organizations/o/uploads/u/source',
            mimeType: 'audio/webm',
            scanStatus: 'pending' as const,
            ...row,
          }
        : null,
    ),
    setScanStatus,
    source: () => ({ size: async () => bytes.length, body: async () => Readable.from([bytes]) }),
    probe: async () => probe,
    publishUploadStatus,
    now: () => new Date('2026-10-28T00:00:00.000Z'),
  };
  return { d, setScanStatus, publishUploadStatus };
}

describe('processUploadScan (sets scanStatus from the #269 content check)', () => {
  it('marks a real webm clean and publishes verified', async () => {
    const { d, setScanStatus, publishUploadStatus } = deps(WEBM);
    expect(await processUploadScan(job(), d)).toMatchObject({ status: 'clean' });
    expect(setScanStatus).toHaveBeenCalledWith(ORG, ID, 'clean');
    expect(publishUploadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: ID, meetingId: MEET, status: 'verified' }),
    );
  });

  it('marks mismatched content rejected with the reason code', async () => {
    const { d, setScanStatus, publishUploadStatus } = deps(HTML);
    expect(await processUploadScan(job(), d)).toMatchObject({
      status: 'rejected',
      result: { code: 'content_type_mismatch' },
    });
    expect(setScanStatus).toHaveBeenCalledWith(ORG, ID, 'rejected');
    expect(publishUploadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'content_type_mismatch' }),
    );
  });

  it('skips invalid jobs, other-org or unknown uploads, and already-decided rows', async () => {
    const a = deps(WEBM);
    expect(await processUploadScan(job({ kind: 'process_recording' }), a.d)).toEqual({
      status: 'skipped',
      reason: 'invalid_job',
    });
    expect(await processUploadScan({ ...job(), extra: 1 }, a.d)).toMatchObject({
      reason: 'invalid_job',
    });
    const other = '00000000-0000-4000-8000-0000000000ff';
    expect(await processUploadScan(job({ organizationId: other }), a.d)).toMatchObject({
      reason: 'not_found',
    });
    const done = deps(WEBM, { scanStatus: 'rejected' });
    expect(await processUploadScan(job(), done.d)).toMatchObject({ reason: 'already_scanned' });
    expect(a.setScanStatus).not.toHaveBeenCalled();
    expect(done.setScanStatus).not.toHaveBeenCalled();
  });

  it('does not publish without a meeting (rooms are meeting-scoped)', async () => {
    const { d, publishUploadStatus } = deps(WEBM);
    const { meetingId: _m, ...noMeeting } = job();
    void _m;
    await processUploadScan(noMeeting, d);
    expect(publishUploadStatus).not.toHaveBeenCalled();
  });
});

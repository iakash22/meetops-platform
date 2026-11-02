import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { UploadProbeResult } from '../src/media/upload-scan.js';
import {
  processUploadScan,
  type ScannableUpload,
  type UploadScanDeps,
} from '../src/media/upload-scan-job.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';
const MEET = '00000000-0000-4000-8000-000000000003';
const CONSENT = '00000000-0000-4000-8000-000000000004';
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x80 | 54]),
  Buffer.from([0xec, 0x80 | 52]), // Segment = one zero-filled Void (no smuggled data)
  Buffer.alloc(52),
]);
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>'.padEnd(64, ' '));
const probe: UploadProbeResult = {
  durationSeconds: 10,
  measuredDurationSeconds: 10,
  timestampFaults: 0,
  formatName: 'matroska,webm',
  streams: [{ index: 0, codecType: 'audio', sampleRate: 48000, channels: 1 }],
  hasAudio: true,
  hasVideo: false,
};
const job = (over: Record<string, unknown> = {}) => ({
  kind: 'process_upload',
  organizationId: ORG,
  subjectType: 'upload',
  subjectId: ID,
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

  it('M-3: quarantines mismatched content with the reason code', async () => {
    const { d, setScanStatus, publishUploadStatus } = deps(HTML);
    expect(await processUploadScan(job(), d)).toMatchObject({
      status: 'quarantined',
      result: { code: 'content_type_mismatch' },
    });
    expect(setScanStatus).toHaveBeenCalledWith(ORG, ID, 'quarantined');
    expect(publishUploadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'content_type_mismatch' }),
    );
  });

  it('M-3: infra errors retry, and the final attempt quarantines (never pending forever)', async () => {
    const { d, setScanStatus, publishUploadStatus } = deps(WEBM);
    d.source = () => ({
      size: async () => {
        throw new Error('s3 down');
      },
      body: async () => Readable.from([]),
    });
    await expect(processUploadScan(job(), d, { isFinalAttempt: false })).rejects.toThrow('s3 down');
    expect(setScanStatus).not.toHaveBeenCalled();
    expect(await processUploadScan(job(), d, { isFinalAttempt: true })).toEqual({
      status: 'quarantined',
      result: { verdict: 'error', code: 'scan_unavailable' },
    });
    expect(setScanStatus).toHaveBeenCalledWith(ORG, ID, 'quarantined');
    expect(publishUploadStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'scan_unavailable' }),
    );
  });

  it('L-2: antivirus verdicts: infected quarantines, unreachable is fail-closed', async () => {
    const a = deps(WEBM);
    a.d.antivirus = {
      scanFile: async () => ({ infected: true, signature: 'Eicar-Test-Signature' }),
    };
    expect(await processUploadScan(job(), a.d)).toMatchObject({
      status: 'quarantined',
      result: { code: 'malware_detected' },
    });
    const b = deps(WEBM);
    b.d.antivirus = {
      scanFile: async () => {
        throw new Error('clamd unreachable');
      },
    };
    await expect(processUploadScan(job(), b.d, { isFinalAttempt: false })).rejects.toThrow(
      'clamd unreachable',
    );
    expect(b.setScanStatus).not.toHaveBeenCalledWith(ORG, ID, 'clean');
    expect(await processUploadScan(job(), b.d, { isFinalAttempt: true })).toMatchObject({
      status: 'quarantined',
    });
    const c = deps(WEBM);
    c.d.antivirus = { scanFile: async () => ({ infected: false }) };
    expect(await processUploadScan(job(), c.d)).toMatchObject({ status: 'clean' });
  });

  it('MAL-2: a clamd limit hit quarantines as scan_limit_exceeded (fail-closed), not malware_detected', async () => {
    const a = deps(WEBM);
    a.d.antivirus = {
      scanFile: async () => ({
        infected: true,
        signature: 'Heuristics.Limits.Exceeded.MaxScanTime',
        limitExceeded: true,
      }),
    };
    expect(await processUploadScan(job(), a.d)).toMatchObject({
      status: 'quarantined',
      result: { verdict: 'rejected', code: 'scan_limit_exceeded' },
    });
    expect(a.setScanStatus).toHaveBeenCalledWith(ORG, ID, 'quarantined');
    expect(a.setScanStatus).not.toHaveBeenCalledWith(ORG, ID, 'clean');
  });

  it('skips invalid jobs, other-org or unknown uploads, and already-decided rows', async () => {
    const a = deps(WEBM);
    expect(await processUploadScan(job({ subjectType: 'recording_session' }), a.d)).toEqual({
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

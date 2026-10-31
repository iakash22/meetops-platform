import { describe, expect, it, vi } from 'vitest';
import { antivirusFromEnv, buildUploadScanDeps, dispatchMediaJob } from '../src/media/index.js';

const org = '11111111-1111-4111-8111-111111111111';
const meeting = '22222222-2222-4222-8222-222222222222';
const store = { findUpload: vi.fn(), setScanStatus: vi.fn() };
const storage = { headUploadSource: vi.fn(), getUploadSource: vi.fn() };
const emitter = { to: () => ({ emit: () => undefined }) };

describe('media worker dispatch (#274 G-1)', () => {
  const handlers = () => ({
    recording: vi.fn(async () => ({ chunks: [] }) as never),
    upload: vi.fn(async () => ({ status: 'skipped', reason: 'not_found' }) as const),
    session: vi.fn(async () => ({ status: 'skipped', reason: 'not_found' }) as const),
  });

  it('routes process_upload to the upload scan with isFinalAttempt from BullMQ attempts', async () => {
    const h = handlers();
    const data = { kind: 'process_upload', organizationId: org, subjectId: 'x' };
    await dispatchMediaJob({ id: '1', attemptsMade: 2, opts: { attempts: 3 }, data }, h);
    expect(h.upload).toHaveBeenCalledWith(data, { isFinalAttempt: true });
    await dispatchMediaJob({ id: '2', attemptsMade: 0, opts: { attempts: 3 }, data }, h);
    expect(h.upload).toHaveBeenLastCalledWith(data, { isFinalAttempt: false });
    expect(h.recording).not.toHaveBeenCalled();
  });

  it('routes API process_recording_session jobs to session assembly with isFinalAttempt', async () => {
    const h = handlers();
    const data = { kind: 'process_recording_session', organizationId: org, subjectId: meeting };
    await dispatchMediaJob({ id: '4', attemptsMade: 2, opts: { attempts: 3 }, data }, h);
    expect(h.session).toHaveBeenCalledWith(data, { isFinalAttempt: true });
    expect(h.recording).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('routes every other job to processRecording', async () => {
    const h = handlers();
    const data = { kind: 'process_recording', organizationId: org, meetingId: meeting };
    await dispatchMediaJob({ id: '3', attemptsMade: 0, opts: { attempts: 1 }, data }, h);
    expect(h.recording).toHaveBeenCalledWith(data, { jobId: '3', isFinalAttempt: true });
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('wires antivirusFromEnv: off by default, on with UPLOAD_SCAN_CLAMAV=true', () => {
    const off = buildUploadScanDeps({ storage, emitter, maxDurationSeconds: 60, env: {}, store });
    expect(off.antivirus).toBeUndefined();
    expect(off.limits).toEqual({ maxDurationSeconds: 60 });
    expect(typeof off.probe).toBe('function');
    expect(typeof off.source).toBe('function');
    const on = buildUploadScanDeps({
      storage,
      emitter,
      maxDurationSeconds: 60,
      env: { UPLOAD_SCAN_CLAMAV: 'true', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '3310' },
      store,
    });
    expect(typeof on.antivirus?.scanFile).toBe('function');
  });

  it('rejects unknown UPLOAD_SCAN_CLAMAV values at startup instead of silently staying off', () => {
    expect(() => antivirusFromEnv({ UPLOAD_SCAN_CLAMAV: '1' })).toThrow(/UPLOAD_SCAN_CLAMAV/);
    expect(() => antivirusFromEnv({ UPLOAD_SCAN_CLAMAV: 'TRUE' })).toThrow(/UPLOAD_SCAN_CLAMAV/);
    expect(antivirusFromEnv({ UPLOAD_SCAN_CLAMAV: 'false' })).toBeUndefined();
  });
});

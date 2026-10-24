import { describe, it, expect } from 'vitest';
import { MAX_MEDIA_BYTES } from '@meetops/contracts';
import { DEFAULT_MEDIA_LIMITS, DEFAULT_WORK_TMP_BYTES, normalizedByteCap, peakScratchBytes } from '../src/media/processor.js';
import { loadMediaWorkerConfig } from '../src/media/worker.js';

describe('media size limits vs /tmp/work tmpfs', () => {
  it('source cap is single-sourced from contracts (1.4 GB)', () => {
    expect(DEFAULT_MEDIA_LIMITS.maxSourceBytes).toBe(MAX_MEDIA_BYTES);
    expect(MAX_MEDIA_BYTES).toBe(1_400_000_000);
  });
  it('default limits: source + normalized WAV + chunks fit the 3 GiB tmpfs', () => {
    const peak = peakScratchBytes(DEFAULT_MEDIA_LIMITS);
    expect(peak).toBe(MAX_MEDIA_BYTES + 2 * normalizedByteCap(4 * 3600));
    expect(peak).toBeLessThan(DEFAULT_WORK_TMP_BYTES);
    expect(loadMediaWorkerConfig({}).maxSourceBytes).toBe(MAX_MEDIA_BYTES);
  });
  it('fails fast when limits x concurrency exceed MEDIA_WORK_TMP_BYTES, and caps MEDIA_MAX_SOURCE_BYTES', () => {
    expect(() => loadMediaWorkerConfig({ MEDIA_WORKER_CONCURRENCY: '2' })).toThrow(/scratch/);
    expect(() => loadMediaWorkerConfig({ MEDIA_WORK_TMP_BYTES: String(2 * 1024 ** 3) })).toThrow(/scratch/);
    expect(() => loadMediaWorkerConfig({ MEDIA_MAX_SOURCE_BYTES: String(MAX_MEDIA_BYTES + 1) })).toThrow();
    expect(loadMediaWorkerConfig({ MEDIA_WORKER_CONCURRENCY: '2', MEDIA_MAX_SOURCE_BYTES: '500000000' }).concurrency).toBe(2);
  });
});

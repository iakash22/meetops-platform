import { describe, expect, it } from 'vitest';
import { LOCAL_RECORDING_CHUNK_BYTES } from '../src/lib/contract-limits.js';
import { estimateQuota, quotaLevel, requestPersistentStorage } from '../src/lib/storage-quota.js';

const MB = 1024 * 1024;

describe('quotaLevel', () => {
  it('ok / low / full thresholds', () => {
    expect(quotaLevel({ usage: 10 * MB, quota: 1000 * MB })).toBe('ok');
    expect(quotaLevel({ usage: 900 * MB, quota: 1000 * MB })).toBe('low');
    expect(
      quotaLevel({ usage: 1000 * MB - LOCAL_RECORDING_CHUNK_BYTES + 1, quota: 1000 * MB }),
    ).toBe('full');
  });
  it('unknown quota is not reported as full', () => {
    expect(quotaLevel({ usage: 0, quota: 0 })).toBe('ok');
  });
});

describe('estimateQuota / requestPersistentStorage', () => {
  it('throws without a storage manager (callers fail closed)', async () => {
    await expect(estimateQuota(undefined)).rejects.toThrow();
  });
  it('reads usage and quota', async () => {
    expect(await estimateQuota({ estimate: async () => ({ usage: 1, quota: 2 }) })).toEqual({
      usage: 1,
      quota: 2,
    });
  });
  it('persist is best effort', async () => {
    expect(await requestPersistentStorage(undefined)).toBe(false);
    expect(
      await requestPersistentStorage({
        estimate: async () => ({}),
        persist: () => Promise.reject(new Error('x')),
      }),
    ).toBe(false);
    expect(
      await requestPersistentStorage({ estimate: async () => ({}), persist: async () => true }),
    ).toBe(true);
  });
});

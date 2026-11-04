import * as contracts from '@meetops/contracts';
import { describe, expect, it } from 'vitest';
import * as limits from '../src/lib/contract-limits.js';

describe('contract-limits mirror', () => {
  it('equals the @meetops/contracts values', () => {
    expect(limits.CHUNK_UPLOAD_URL_TTL_SECONDS).toBe(contracts.CHUNK_UPLOAD_URL_TTL_SECONDS);
    expect(limits.UPLOAD_CHUNK_MAX_BYTES).toBe(contracts.MAX_CHUNK_BYTES);
    expect(limits.MAX_RECORDING_CHUNKS).toBe(contracts.MAX_RECORDING_CHUNKS);
    expect(limits.MAX_CHUNKS).toBe(contracts.MAX_CHUNKS);
  });
});

describe('MAX_DURATION_MS', () => {
  it('is the contracts value (4 h), not an extension-local limit', () => {
    expect(limits.MAX_DURATION_MS).toBe(contracts.MAX_DURATION_MS);
    expect(limits.MAX_DURATION_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe('chunk size limits', () => {
  it('keeps the local recording chunk (8 MiB) separate from the upload ceiling (64 MiB)', () => {
    expect(limits.LOCAL_RECORDING_CHUNK_BYTES).toBe(8 * 1024 * 1024);
    expect(limits.UPLOAD_CHUNK_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('local recording chunk never exceeds the contract upload ceiling', () => {
    expect(limits.LOCAL_RECORDING_CHUNK_BYTES).toBeLessThanOrEqual(limits.UPLOAD_CHUNK_MAX_BYTES);
    expect(limits.LOCAL_RECORDING_CHUNK_BYTES).toBeLessThanOrEqual(contracts.MAX_CHUNK_BYTES);
  });
});

import * as contracts from '@meetops/contracts';
import { describe, expect, it } from 'vitest';
import * as limits from '../src/lib/contract-limits.js';

describe('contract-limits mirror', () => {
  it('equals the @meetops/contracts values', () => {
    expect(limits.CHUNK_UPLOAD_URL_TTL_SECONDS).toBe(contracts.CHUNK_UPLOAD_URL_TTL_SECONDS);
    expect(limits.MAX_CHUNK_BYTES).toBe(contracts.MAX_CHUNK_BYTES);
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

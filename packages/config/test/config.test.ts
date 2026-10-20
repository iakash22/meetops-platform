import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src';

describe('config', () => {
  it('loads defaults without throwing', () => {
    const cfg = loadConfig({});
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.STORAGE_PROVIDER).toBe('minio');
  });
});

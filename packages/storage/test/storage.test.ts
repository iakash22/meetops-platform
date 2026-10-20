import { describe, it, expect } from 'vitest';
import type { StorageService } from '../src';

describe('storage interface', () => {
  it('shape is correct', () => {
    const methods: Array<keyof StorageService> = [
      'getPresignedUploadUrl',
      'getPresignedDownloadUrl',
      'headObject',
      'deleteObject'
    ];
    expect(methods.includes('deleteObject')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { DEFAULT_ALLOWED_HOSTS } from '../src/index.js';

describe('DEFAULT_ALLOWED_HOSTS', () => {
  it('does not allowlist api.deepgram.com (Deepgram is disabled)', () => {
    expect(DEFAULT_ALLOWED_HOSTS).toEqual([
      'generativelanguage.googleapis.com',
      'api.assemblyai.com',
      'api.openai.com',
    ]);
    expect(DEFAULT_ALLOWED_HOSTS).not.toContain('api.deepgram.com');
  });
});

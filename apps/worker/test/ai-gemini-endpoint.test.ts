import { describe, expect, it } from 'vitest';
import { ProviderError, isAllowedGeminiBase, loadGeminiConfig } from '../src/ai/index.js';

describe('GEMINI_BASE_URL allowlist', () => {
  it('accepts only the official Gemini host over https', () => {
    expect(isAllowedGeminiBase('https://generativelanguage.googleapis.com')).toBe(true);
    expect(isAllowedGeminiBase('https://generativelanguage.googleapis.com:443/')).toBe(true);
    for (const bad of [
      'http://generativelanguage.googleapis.com',
      'https://evil.example',
      'https://generativelanguage.googleapis.com.evil.example',
      'https://user:pw@generativelanguage.googleapis.com',
      'https://generativelanguage.googleapis.com:8443',
      'https://169.254.169.254',
      'not a url',
    ])
      expect(isAllowedGeminiBase(bad)).toBe(false);
  });
  it('loadGeminiConfig refuses arbitrary endpoints', () => {
    expect(() =>
      loadGeminiConfig({ GEMINI_API_KEY: 'k', GEMINI_BASE_URL: 'https://attacker.example' }),
    ).toThrow(ProviderError);
    expect(
      loadGeminiConfig({
        GEMINI_API_KEY: 'k',
        GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
      })?.baseUrl,
    ).toBe('https://generativelanguage.googleapis.com');
  });
});

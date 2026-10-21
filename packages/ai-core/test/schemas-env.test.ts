import { describe, it, expect } from 'vitest';
import { loadAIEnv, providerConfigSchema, retryPolicySchema, toPublicProviderConfig, createRegistryFromEnv } from '../src/index.js';
import { llmCfg } from './helpers.js';

describe('env validation', () => {
  it('applies defaults', () => {
    const { env, errors } = loadAIEnv({});
    expect(errors).toEqual([]);
    expect(env.AI_LLM_PROVIDER).toBe('gemini');
    expect(env.GEMINI_MODEL).toBe('gemini-2.5-flash-lite');
    expect(env.AI_STT_PROVIDER).toBe('assemblyai');
    expect(env.AI_ALLOW_PAID_FALLBACK).toBe(false);
    expect(env.AI_REQUIRE_PROVIDER_APPROVAL).toBe(true);
    expect(env.OLLAMA_ENABLED).toBe(false);
  });
  it('missing credentials => unavailable with clear reason, no crash', () => {
    const { availability } = loadAIEnv({ GEMINI_API_KEY: '' });
    expect(availability.find((a) => a.provider === 'gemini')).toEqual({ provider: 'gemini', available: false, reason: 'GEMINI_API_KEY is not set' });
    expect(availability.find((a) => a.provider === 'assemblyai')?.available).toBe(false);
  });
  it('bad values reported, defaults used', () => {
    const { env, errors } = loadAIEnv({ OLLAMA_BASE_URL: 'not a url' });
    expect(errors.length).toBe(1);
    expect(env.OLLAMA_BASE_URL).toBe('http://localhost:11434');
  });
  it('registry from env marks missing-key providers unavailable', () => {
    const { env } = loadAIEnv({});
    const reg = createRegistryFromEnv(env, {});
    expect(reg.availability('gemini')).toEqual({ available: false, reason: 'Missing credential env:GEMINI_API_KEY for gemini' });
    expect(() => reg.get('gemini')).toThrow(/Missing credential/);
    expect(reg.availability('ollama').available).toBe(false);
    expect(reg.availability('deepgram').available).toBe(false);
  });
});

describe('provider config schema', () => {
  it('rejects raw keys as credentialRef', () => {
    expect(() => providerConfigSchema.parse(llmCfg('x', { credentialRef: 'AIzaSyRAWKEY' }))).toThrow();
    expect(providerConfigSchema.parse(llmCfg('x', { credentialRef: 'env:X_KEY' })).credentialRef).toBe('env:X_KEY');
  });
  it('bounds retries (no infinite)', () => {
    expect(() => retryPolicySchema.parse({ maxAttempts: 100 })).toThrow();
    expect(() => retryPolicySchema.parse({ maxAttempts: Infinity })).toThrow();
  });
  it('public config never contains credentialRef', () => {
    const pub = toPublicProviderConfig(providerConfigSchema.parse(llmCfg('x', { credentialRef: 'env:X_KEY' })));
    expect(JSON.stringify(pub)).not.toContain('X_KEY');
    expect(pub.hasCredential).toBe(true);
  });
});

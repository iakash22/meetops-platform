import { describe, it, expect } from 'vitest';
import { loadAIEnv, providerConfigSchema, retryPolicySchema, toPublicProviderConfig, createRegistryFromEnv, createCredentialResolver, InMemoryAuditSink, endpointPolicyFromEnv } from '../src/index.js';
import { SYSTEM, llmCfg } from './helpers.js';

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
  it('registry from env: missing platform key -> clear MISSING_CREDENTIALS at call time, no crash', async () => {
    const { env } = loadAIEnv({});
    const resolveCredential = createCredentialResolver({ env: () => undefined, secret: async () => undefined }, async () => ({ platformKeys: true }));
    const reg = await createRegistryFromEnv(env, { audit: new InMemoryAuditSink(), resolveCredential, system: SYSTEM, production: false });
    expect(reg.availability('gemini').available).toBe(true);
    await expect(reg.instantiate('gemini', { orgId: '00000000-0000-4000-8000-00000000000e' })).rejects.toMatchObject({ code: 'MISSING_CREDENTIALS' });
    expect(reg.availability('ollama').available).toBe(false);
    expect(reg.availability('deepgram').available).toBe(false);
  });
  it('fails fast on invalid env in production (names vars, never values)', () => {
    expect(() => loadAIEnv({ OLLAMA_BASE_URL: 'not a url', NODE_ENV: 'production' })).toThrow(/OLLAMA_BASE_URL/);
    expect(() => loadAIEnv({ GEMINI_MODEL: '' }, { production: true })).toThrow();
  });
  it('blocks local origins in production at startup', () => {
    expect(() => endpointPolicyFromEnv(loadAIEnv({ OLLAMA_ENABLED: 'true' }).env, { production: true })).toThrow(/not allowed in production/);
    expect(() => endpointPolicyFromEnv(loadAIEnv({ LOCAL_STT_ENABLED: 'true' }).env, { production: true })).toThrow();
    expect(endpointPolicyFromEnv(loadAIEnv({}).env, { production: true }).allowedLocalOrigins).toEqual([]);
  });
});

describe('provider config schema', () => {
  it('cost tier and platformBilled are REQUIRED', () => {
    const rest: Record<string, unknown> = { ...llmCfg('x') };
    delete rest.cost;
    delete rest.platformBilled;
    expect(providerConfigSchema.safeParse(rest).success).toBe(false);
    expect(providerConfigSchema.safeParse({ ...rest, cost: { tier: 'free' } }).success).toBe(false);
  });
  it('platform-billed free providers must declare quotas', () => {
    expect(providerConfigSchema.safeParse(llmCfg('x', { platformBilled: true })).success).toBe(false);
    expect(providerConfigSchema.safeParse(llmCfg('x', { platformBilled: true, usage: { dailyRequestLimit: 10 } })).success).toBe(true);
  });
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

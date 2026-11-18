import { describe, it, expect } from 'vitest';
import {
  assertProductionProviderDataTiers,
  assessEnabledProviderDataTiers,
  createCredentialResolver,
  createRegistryFromEnv,
  dataTierEnvName,
  defaultProviderConfigs,
  InMemoryAuditSink,
  loadAIEnv,
  ProductionProviderDataTierError,
} from '../src/index.js';
import { SYSTEM } from './helpers.js';

const geminiAndAssemblyFree = defaultProviderConfigs(loadAIEnv({}).env);

describe('production provider data-tier guard', () => {
  it('maps provider names to AI_PROVIDER_DATA_TIER_* env names', () => {
    expect(dataTierEnvName('gemini')).toBe('AI_PROVIDER_DATA_TIER_GEMINI');
    expect(dataTierEnvName('assemblyai')).toBe('AI_PROVIDER_DATA_TIER_ASSEMBLYAI');
    expect(dataTierEnvName('faster-whisper')).toBe('AI_PROVIDER_DATA_TIER_FASTER_WHISPER');
  });

  it('refuses enabled free-tier LLM/STT providers in production', () => {
    expect(() =>
      assertProductionProviderDataTiers(geminiAndAssemblyFree, {}, { production: true }),
    ).toThrow(ProductionProviderDataTierError);
    expect(() =>
      assertProductionProviderDataTiers(geminiAndAssemblyFree, { NODE_ENV: 'production' }),
    ).toThrow(/AI_PROVIDER_DATA_TIER_GEMINI/);
  });

  it('allows production when cost.tier is paid or an env declaration is set', () => {
    const paid = [
      {
        name: 'openai',
        type: 'llm' as const,
        enabled: true,
        cost: { tier: 'paid' },
      },
    ];
    expect(() => assertProductionProviderDataTiers(paid, {}, { production: true })).not.toThrow();

    expect(() =>
      assertProductionProviderDataTiers(
        geminiAndAssemblyFree,
        {
          AI_PROVIDER_DATA_TIER_GEMINI: 'paid',
          AI_PROVIDER_DATA_TIER_ASSEMBLYAI: 'no-training',
        },
        { production: true },
      ),
    ).not.toThrow();
  });

  it('relaxes the guard only for development and test', () => {
    expect(() =>
      assertProductionProviderDataTiers(geminiAndAssemblyFree, { NODE_ENV: 'development' }),
    ).not.toThrow();
    expect(() =>
      assertProductionProviderDataTiers(geminiAndAssemblyFree, { NODE_ENV: 'test' }),
    ).not.toThrow();
    expect(() =>
      assertProductionProviderDataTiers(
        geminiAndAssemblyFree,
        { NODE_ENV: 'test' },
        { production: false },
      ),
    ).not.toThrow();
    const assessments = assessEnabledProviderDataTiers(geminiAndAssemblyFree, {});
    expect(
      assessments
        .filter((a) => !a.ok)
        .map((a) => a.provider)
        .sort(),
    ).toEqual(['assemblyai', 'gemini']);
  });

  it('fails closed for typo, staging, and unset NODE_ENV', () => {
    expect(() =>
      assertProductionProviderDataTiers(geminiAndAssemblyFree, { NODE_ENV: 'produciton' }),
    ).toThrow(ProductionProviderDataTierError);
    expect(() =>
      assertProductionProviderDataTiers(geminiAndAssemblyFree, { NODE_ENV: 'staging' }),
    ).toThrow(ProductionProviderDataTierError);
    expect(() => assertProductionProviderDataTiers(geminiAndAssemblyFree, {})).toThrow(
      ProductionProviderDataTierError,
    );
    expect(() =>
      assertProductionProviderDataTiers(geminiAndAssemblyFree, { NODE_ENV: undefined }),
    ).toThrow(ProductionProviderDataTierError);
  });

  it('skips disabled providers and rejects an invalid declaration in production', () => {
    const disabledFree = [
      { name: 'deepgram', type: 'stt', enabled: false, cost: { tier: 'paid' } },
      { name: 'gemini', type: 'llm', enabled: true, cost: { tier: 'free' } },
    ];
    expect(() => assertProductionProviderDataTiers(disabledFree, {}, { production: true })).toThrow(
      /GEMINI/,
    );
    expect(() =>
      assertProductionProviderDataTiers(
        disabledFree,
        { AI_PROVIDER_DATA_TIER_GEMINI: 'free' },
        { production: true },
      ),
    ).toThrow(/must be paid or no-training/);
  });

  it('createRegistryFromEnv fails closed in production without declarations', async () => {
    const { env } = loadAIEnv({});
    const deps = {
      audit: new InMemoryAuditSink(),
      resolveCredential: createCredentialResolver(
        { env: () => undefined, secret: async () => undefined },
        async () => ({ platformKeys: true }),
      ),
      system: SYSTEM,
      production: true as const,
      processEnv: {},
    };
    await expect(createRegistryFromEnv(env, deps)).rejects.toThrow(ProductionProviderDataTierError);
    await expect(
      createRegistryFromEnv(env, {
        ...deps,
        processEnv: {
          AI_PROVIDER_DATA_TIER_GEMINI: 'paid',
          AI_PROVIDER_DATA_TIER_ASSEMBLYAI: 'paid',
        },
      }),
    ).resolves.toBeDefined();
  });

  it('createRegistryFromEnv in development is unchanged without declarations', async () => {
    const { env } = loadAIEnv({});
    const reg = await createRegistryFromEnv(env, {
      audit: new InMemoryAuditSink(),
      resolveCredential: createCredentialResolver(
        { env: () => undefined, secret: async () => undefined },
        async () => ({ platformKeys: true }),
      ),
      system: SYSTEM,
      production: false,
    });
    expect(reg.availability('gemini').available).toBe(true);
    expect(reg.availability('assemblyai').available).toBe(true);
  });
});

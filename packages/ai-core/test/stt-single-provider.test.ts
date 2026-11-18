import { describe, expect, it } from 'vitest';
import { loadAIEnv } from '../src/env.js';
import { InMemoryOrgConfigStore, ModelRouter, orgAIConfigSchema } from '../src/router.js';
import { AIError } from '../src/errors.js';
import { admin } from './helpers.js';

const ORG = '00000000-0000-4000-8000-0000000000a9';
const SECRET_REF = `secret:org/${ORG}/assemblyai-key`;
const audit = { emit: async () => {} };

const make = () => {
  const store = new InMemoryOrgConfigStore();
  const warnings: Array<{ msg: string; meta: Record<string, unknown> }> = [];
  const router = new ModelRouter(loadAIEnv({ NODE_ENV: 'test' }).env, store, audit, (msg, meta) =>
    warnings.push({ msg, meta }),
  );
  return { store, router, warnings };
};

describe('one STT provider per organization (ADR-009)', () => {
  it('setOrgConfig rejects STT fallbacks (defaults and STT features) with a clear error', async () => {
    const { router, store } = make();
    for (const input of [
      {
        organizationId: ORG,
        defaults: { stt: { provider: 'assemblyai', fallbacks: ['faster-whisper'] } },
      },
      {
        organizationId: ORG,
        features: { transcription: { provider: 'assemblyai', fallbacks: ['faster-whisper'] } },
      },
    ]) {
      const err = await router.setOrgConfig(input, admin(ORG)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AIError);
      expect((err as AIError).code).toBe('CONFIG_INVALID');
      expect((err as AIError).message).toMatch(/speech-to-text fallbacks are not allowed/);
    }
    expect(await store.get(ORG)).toBeUndefined();
  });

  it('allows an STT primary without fallbacks, and LLM fallbacks still work', async () => {
    const { router } = make();
    await router.setOrgConfig(
      {
        organizationId: ORG,
        defaults: {
          stt: { provider: 'faster-whisper', fallbacks: [] },
          llm: { provider: 'gemini', fallbacks: ['openai'] },
        },
      },
      admin(ORG),
    );
    expect((await router.resolve(ORG, 'transcription')).provider).toBe('faster-whisper');
    expect((await router.resolve(ORG, 'summary')).fallbacks).toEqual(['openai']);
  });

  it('ignores STT fallbacks on a pre-existing stored row and warns without secrets', async () => {
    const { router, store, warnings } = make();
    // Legacy row written before the validation existed (bypasses setOrgConfig).
    await store.put(
      orgAIConfigSchema.parse({
        organizationId: ORG,
        defaults: { stt: { provider: 'assemblyai', fallbacks: ['faster-whisper'] } },
        credentialRefs: { assemblyai: SECRET_REF },
      }),
    );
    const r = await router.resolve(ORG, 'transcription');
    expect(r.provider).toBe('assemblyai');
    expect(r.fallbacks).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.meta).toMatchObject({
      organizationId: ORG,
      feature: 'transcription',
      ignoredFallbackCount: 1,
    });
    expect(JSON.stringify(warnings)).not.toContain('secret:');
  });
});

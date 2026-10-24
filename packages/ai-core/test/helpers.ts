import type { z } from 'zod';
import {
  AIExecutor, InMemoryAuditSink, createCredentialResolver, roleAbility, type TenantContext, type SystemContext, InMemoryIdempotencyStore, InMemoryOrgConfigStore, InMemoryUsageTracker, ModelRouter, ProviderRegistry,
  UsageQuotaManager, aiEnvSchema, type AnyProvider, type LLMProvider, type ProviderConfigInput, type TranscriptionProvider,
} from '../src/index.js';

export function fakeLLM(id: string, impl: (prompt: string) => Promise<string> | string = () => '{"ok":true}'): LLMProvider & { calls: number } {
  const p = {
    providerId: id,
    kind: 'llm' as const,
    calls: 0,
    async listModels() { return ['m']; },
    async generateText({ prompt }: { prompt: string }) {
      p.calls++;
      return { text: await impl(prompt), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
    async generateStructured<S extends z.ZodType>({ prompt, schema }: { prompt: string; schema: S }) {
      p.calls++;
      const raw = await impl(prompt);
      return { value: schema.parse(JSON.parse(raw)), rawText: raw, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
    async healthCheck() { return { ok: true, timestamp: 'now' }; },
  };
  return p;
}

export function fakeSTT(id: string): TranscriptionProvider {
  return {
    providerId: id,
    kind: 'stt',
    async transcribe() { return { text: 'hi', segments: [], durationSec: 60 }; },
    async getCapabilities() { return { batch: true, streaming: false, diarization: false, languages: ['en'] }; },
    async healthCheck() { return { ok: true, timestamp: 'now' }; },
  };
}

export const llmCfg = (name: string, extra: Partial<ProviderConfigInput> = {}): ProviderConfigInput => ({
  name, type: 'llm', adapter: name, model: `${name}-model`, enabled: true,
  capabilities: ['text-generation', 'structured-output'], retryPolicy: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
  timeoutMs: 200, cost: { tier: 'free' }, platformBilled: false, ...extra,
});

export const SYSTEM: SystemContext = { system: true, userId: 'platform-admin' };
export const admin = (organizationId: string, userId = `admin@${organizationId}`): TenantContext => ({ organizationId, userId, ability: roleAbility('admin') });
export const member = (organizationId: string): TenantContext => ({ organizationId, userId: `member@${organizationId}`, ability: roleAbility('member') });

export async function setup(opts: {
  providers: Record<string, AnyProvider>;
  configs: ProviderConfigInput[];
  env?: Record<string, string>;
  credentials?: Record<string, string>;
  secrets?: Record<string, string>;
  platformKeys?: boolean;
}) {
  const env = aiEnvSchema.parse(opts.env ?? {});
  const factories = Object.fromEntries(Object.entries(opts.providers).map(([k, v]) => [k, () => v]));
  const audit = new InMemoryAuditSink();
  const keysSeen: Array<string | undefined> = [];
  const resolveCredential = createCredentialResolver(
    { env: (n) => opts.credentials?.[n], secret: async (p) => opts.secrets?.[p] },
    async () => ({ platformKeys: opts.platformKeys ?? true }),
  );
  const wrapped = Object.fromEntries(Object.entries(factories).map(([k, f]) => [k, (c: never, key: string | undefined) => (keysSeen.push(key), f())]));
  const registry = new ProviderRegistry(wrapped, resolveCredential, audit);
  for (const c of opts.configs) await registry.register(c, SYSTEM);
  const orgStore = new InMemoryOrgConfigStore();
  const router = new ModelRouter(env, orgStore, audit);
  const usage = new InMemoryUsageTracker();
  const notified: unknown[] = [];
  const executor = new AIExecutor({
    registry, router, usage, quota: new UsageQuotaManager(usage), idempotency: new InMemoryIdempotencyStore(),
    notify: (e) => { notified.push(e); }, sleep: async () => {},
  });
  return { env, registry, router, orgStore, usage, executor, notified, audit, keysSeen };
}

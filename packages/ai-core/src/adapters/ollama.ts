import { z } from 'zod';
import type { LLMGenerateStructuredParams, LLMGenerateTextParams, LLMProvider, LLMStructuredResult, LLMTextResult, ProviderHealth } from '../types.js';
import { toAIError } from '../errors.js';
import { guardedFetch, type HttpOpts } from './http.js';
import { parseStructured } from './gemini.js';

type OllamaChat = { message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };

/**
 * Ollama native REST API: POST /api/chat (stream:false), GET /api/tags, structured outputs via `format: <JSON schema>`.
 * Local/self-hosted, free. Disabled by default (OLLAMA_ENABLED=false).
 */
export class OllamaProvider implements LLMProvider {
  readonly kind = 'llm' as const;
  constructor(private readonly http: Omit<HttpOpts, 'provider'>, readonly providerId = 'ollama') {}
  private o(): HttpOpts {
    return { ...this.http, provider: this.providerId, headers: { 'content-type': 'application/json' } };
  }

  private async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<OllamaChat> {
    try {
      const res = await guardedFetch(this.o(), 'api/chat', { method: 'POST', body: JSON.stringify({ ...body, stream: false }), ...(signal ? { signal } : {}) });
      return (await res.json()) as OllamaChat;
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
  }

  private msgs(p: { system?: string | undefined; prompt: string }) {
    return [...(p.system ? [{ role: 'system', content: p.system }] : []), { role: 'user', content: p.prompt }];
  }
  private opts(p: { temperature?: number | undefined; maxTokens?: number | undefined; stopSequences?: string[] | undefined }) {
    return { temperature: p.temperature, num_predict: p.maxTokens, stop: p.stopSequences };
  }

  async listModels(): Promise<string[]> {
    const res = await guardedFetch(this.o(), 'api/tags');
    const j = (await res.json()) as { models?: Array<{ name: string }> };
    return (j.models ?? []).map((m) => m.name);
  }

  async generateText(p: LLMGenerateTextParams): Promise<LLMTextResult> {
    const j = await this.chat({ model: p.model, messages: this.msgs(p), options: this.opts(p) }, p.signal);
    return { text: j.message?.content ?? '', finishReason: j.done_reason, usage: usage(j) };
  }

  async generateStructured<S extends z.ZodType>(p: LLMGenerateStructuredParams<S>): Promise<LLMStructuredResult<z.infer<S>>> {
    const j = await this.chat({ model: p.model, messages: this.msgs(p), format: z.toJSONSchema(p.schema), options: this.opts(p) }, p.signal);
    const raw = j.message?.content ?? '';
    return { value: parseStructured(p.schema, raw, this.providerId), rawText: raw, usage: usage(j) };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t = Date.now();
    try {
      await this.listModels();
      return { ok: true, latencyMs: Date.now() - t, timestamp: new Date().toISOString() };
    } catch (e) {
      return { ok: false, message: toAIError(e, this.providerId).message, timestamp: new Date().toISOString() };
    }
  }
}

const usage = (j: OllamaChat) => ({
  inputTokens: j.prompt_eval_count,
  outputTokens: j.eval_count,
  totalTokens: (j.prompt_eval_count ?? 0) + (j.eval_count ?? 0),
});

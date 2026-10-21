import { z } from 'zod';
import type { LLMGenerateStructuredParams, LLMGenerateTextParams, LLMProvider, LLMStructuredResult, LLMTextResult, ProviderHealth } from '../types.js';
import { toAIError } from '../errors.js';
import { guardedFetch, requireOk, type HttpOpts } from './http.js';
import { parseStructured } from './gemini.js';

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

/**
 * OpenAI-compatible Chat Completions adapter (POST {baseUrl}/chat/completions, GET {baseUrl}/models).
 * Works with OpenAI and other compatible servers. Disabled by default (OPENAI_ENABLED=false).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly kind = 'llm' as const;
  constructor(private readonly http: Omit<HttpOpts, 'provider'> & { apiKey?: string | undefined }, readonly providerId = 'openai') {}

  private opts(): HttpOpts {
    return {
      ...this.http,
      provider: this.providerId,
      headers: { 'content-type': 'application/json', ...(this.http.apiKey ? { authorization: `Bearer ${this.http.apiKey}` } : {}) },
    };
  }

  private async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatResponse> {
    try {
      const res = await guardedFetch(this.opts(), 'chat/completions', { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      return res.json<ChatResponse>();
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
  }

  private messages(p: { system?: string | undefined; prompt: string }) {
    return [...(p.system ? [{ role: 'system', content: p.system }] : []), { role: 'user', content: p.prompt }];
  }

  async listModels(): Promise<string[]> {
    const res = await guardedFetch(this.opts(), 'models');
    const j = res.json<{ data?: Array<{ id: string }> }>();
    return (j.data ?? []).map((m) => m.id);
  }

  async generateText(p: LLMGenerateTextParams): Promise<LLMTextResult> {
    const j = await this.chat(
      { model: p.model, messages: this.messages(p), temperature: p.temperature, max_tokens: p.maxTokens, stop: p.stopSequences },
      p.signal,
    );
    const c = j.choices?.[0];
    requireOk(c?.message, this.providerId, 'no choices in response');
    return { text: c.message.content ?? '', finishReason: c.finish_reason, usage: usage(j) };
  }

  async generateStructured<S extends z.ZodType>(p: LLMGenerateStructuredParams<S>): Promise<LLMStructuredResult<z.infer<S>>> {
    const j = await this.chat(
      {
        model: p.model,
        messages: this.messages(p),
        temperature: p.temperature,
        max_tokens: p.maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: p.schemaName, schema: z.toJSONSchema(p.schema), strict: true } },
      },
      p.signal,
    );
    const raw = j.choices?.[0]?.message?.content ?? '';
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

const usage = (j: ChatResponse) => ({
  inputTokens: j.usage?.prompt_tokens,
  outputTokens: j.usage?.completion_tokens,
  totalTokens: j.usage?.total_tokens,
});

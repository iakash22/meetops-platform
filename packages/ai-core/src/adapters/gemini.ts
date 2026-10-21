import { z } from 'zod';
import type { LLMGenerateStructuredParams, LLMGenerateTextParams, LLMProvider, LLMStructuredResult, LLMTextResult, ProviderHealth } from '../types.js';
import { AIError, toAIError } from '../errors.js';
import { guardedFetch, type HttpOpts } from './http.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type GenerateContentResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  promptFeedback?: { blockReason?: string };
};

const mapUsage = (u: GenerateContentResponse['usageMetadata']) => ({
  inputTokens: u?.promptTokenCount,
  outputTokens: u?.candidatesTokenCount,
  totalTokens: u?.totalTokenCount,
});

const MODEL_RE = /^[a-z0-9.-]+$/;

/**
 * Gemini Developer API over REST (no SDK), via guardedFetch:
 *   POST {base}/models/{model}:generateContent   header `x-goog-api-key`
 *   GET  {base}/models
 * Structured output: generationConfig.responseMimeType=application/json + responseJsonSchema (z.toJSONSchema),
 * then strict zod validation of the returned text.
 */
export class GeminiProvider implements LLMProvider {
  readonly kind = 'llm' as const;
  constructor(
    private readonly http: Omit<HttpOpts, 'provider' | 'baseUrl'> & { apiKey?: string | undefined; baseUrl?: string | undefined },
    readonly providerId = 'gemini',
  ) {
    if (!http.apiKey) throw new AIError('MISSING_CREDENTIALS', 'Gemini credential is required', { provider: providerId, retryable: false });
  }

  private o(): HttpOpts {
    return {
      ...this.http,
      baseUrl: this.http.baseUrl ?? GEMINI_BASE_URL,
      provider: this.providerId,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.http.apiKey ?? '' },
    };
  }

  private async generate(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<GenerateContentResponse> {
    if (!MODEL_RE.test(model)) throw new AIError('CONFIG_INVALID', 'invalid model id', { provider: this.providerId, retryable: false });
    try {
      const res = await guardedFetch(this.o(), `models/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      return res.json<GenerateContentResponse>();
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
  }

  private body(p: LLMGenerateTextParams, extra: Record<string, unknown> = {}) {
    return {
      contents: [{ role: 'user', parts: [{ text: p.prompt }] }],
      ...(p.system !== undefined ? { systemInstruction: { parts: [{ text: p.system }] } } : {}),
      generationConfig: {
        ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        ...(p.maxTokens !== undefined ? { maxOutputTokens: p.maxTokens } : {}),
        ...(p.stopSequences ? { stopSequences: p.stopSequences } : {}),
        ...extra,
      },
    };
  }

  private text(r: GenerateContentResponse): string {
    if (r.promptFeedback?.blockReason) throw new AIError('MODEL_ERROR', 'prompt blocked by provider safety filter', { provider: this.providerId, retryable: false });
    return (r.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? '').join('');
  }

  async listModels(): Promise<string[]> {
    const res = await guardedFetch(this.o(), 'models');
    const j = res.json<{ models?: Array<{ name?: string }> }>();
    return (j.models ?? []).flatMap((m) => (m.name ? [m.name.replace(/^models\//, '')] : []));
  }

  async generateText(p: LLMGenerateTextParams): Promise<LLMTextResult> {
    const r = await this.generate(p.model, this.body(p), p.signal);
    return { text: this.text(r), finishReason: r.candidates?.[0]?.finishReason, usage: mapUsage(r.usageMetadata) };
  }

  async generateStructured<S extends z.ZodType>(p: LLMGenerateStructuredParams<S>): Promise<LLMStructuredResult<z.infer<S>>> {
    const r = await this.generate(p.model, this.body(p, { responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(p.schema) }), p.signal);
    const raw = this.text(r);
    return { value: parseStructured(p.schema, raw, this.providerId), rawText: raw, usage: mapUsage(r.usageMetadata) };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t = Date.now();
    try {
      await this.listModels();
      return { ok: true, latencyMs: Date.now() - t, timestamp: new Date().toISOString() };
    } catch (e) {
      return { ok: false, message: toAIError(e, this.providerId).code, timestamp: new Date().toISOString() };
    }
  }
}

export function parseStructured<S extends z.ZodType>(schema: S, raw: string, provider: string): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new AIError('INVALID_OUTPUT', 'Model returned non-JSON output', { provider, retryable: false, cause: e });
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new AIError('INVALID_OUTPUT', `Output failed schema validation: ${r.error.message}`, { provider, retryable: false });
  return r.data;
}

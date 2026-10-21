import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { LLMGenerateStructuredParams, LLMGenerateTextParams, LLMProvider, LLMStructuredResult, LLMTextResult, ProviderHealth } from '../types.js';
import { AIError, toAIError } from '../errors.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';

/** Subset of the @google/genai `ai.models` surface we use (lets tests inject a fake). */
export type GeminiModelsClient = Pick<GoogleGenAI['models'], 'generateContent' | 'list' | 'get'>;

type UsageMeta = { promptTokenCount?: number | undefined; candidatesTokenCount?: number | undefined; totalTokenCount?: number | undefined } | undefined;
const mapUsage = (u: UsageMeta) => ({
  inputTokens: u?.promptTokenCount,
  outputTokens: u?.candidatesTokenCount,
  totalTokens: u?.totalTokenCount,
});

/**
 * Gemini via the official @google/genai SDK (Gemini Developer API, API key auth).
 * Structured output: zod -> JSON Schema (z.toJSONSchema) sent as `responseJsonSchema` with
 * `responseMimeType: "application/json"`; the response is then validated again with zod.
 */
export class GeminiProvider implements LLMProvider {
  readonly kind = 'llm' as const;
  private readonly models: GeminiModelsClient;
  constructor(
    opts: { apiKey?: string | undefined; client?: GeminiModelsClient | undefined },
    readonly providerId = 'gemini',
  ) {
    if (opts.client) this.models = opts.client;
    else {
      if (!opts.apiKey) throw new AIError('MISSING_CREDENTIALS', 'GEMINI_API_KEY is required', { provider: providerId, retryable: false });
      this.models = new GoogleGenAI({ apiKey: opts.apiKey }).models;
    }
  }

  async listModels(): Promise<string[]> {
    const out: string[] = [];
    const pager = await this.models.list();
    for await (const m of pager) if (m.name) out.push(m.name.replace(/^models\//, ''));
    return out;
  }

  async generateText(p: LLMGenerateTextParams): Promise<LLMTextResult> {
    try {
      const res = await this.models.generateContent({
        model: p.model,
        contents: p.prompt,
        config: {
          ...(p.system !== undefined ? { systemInstruction: p.system } : {}),
          ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
          ...(p.maxTokens !== undefined ? { maxOutputTokens: p.maxTokens } : {}),
          ...(p.stopSequences ? { stopSequences: p.stopSequences } : {}),
          ...(p.signal ? { abortSignal: p.signal } : {}),
        },
      });
      return { text: res.text ?? '', finishReason: res.candidates?.[0]?.finishReason, usage: mapUsage(res.usageMetadata) };
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
  }

  async generateStructured<S extends z.ZodType>(p: LLMGenerateStructuredParams<S>): Promise<LLMStructuredResult<z.infer<S>>> {
    let res;
    try {
      res = await this.models.generateContent({
        model: p.model,
        contents: p.prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: z.toJSONSchema(p.schema),
          ...(p.system !== undefined ? { systemInstruction: p.system } : {}),
          ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
          ...(p.maxTokens !== undefined ? { maxOutputTokens: p.maxTokens } : {}),
          ...(p.signal ? { abortSignal: p.signal } : {}),
        },
      });
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
    const raw = res.text ?? '';
    return { value: parseStructured(p.schema, raw, this.providerId), rawText: raw, usage: mapUsage(res.usageMetadata) };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t = Date.now();
    try {
      await this.models.get({ model: GEMINI_DEFAULT_MODEL });
      return { ok: true, latencyMs: Date.now() - t, timestamp: new Date().toISOString() };
    } catch (e) {
      return { ok: false, message: toAIError(e, this.providerId).code, latencyMs: Date.now() - t, timestamp: new Date().toISOString() };
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

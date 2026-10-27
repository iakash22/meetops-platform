import { ProviderError, providerFetch, readJson, type FetchLike } from './errors.js';
import type { LlmJsonRequest, LlmJsonResult, LlmProvider } from './llm-provider.js';

export type GeminiConfig = {
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  requestTimeoutMs?: number | undefined;
  fetch?: FetchLike | undefined;
};

const ID = 'gemini';
const MODEL_RE = /^[A-Za-z0-9._-]{1,80}$/;

type GeminiBody = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: unknown }>;
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
  modelVersion?: unknown;
};
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export class GeminiLlmProvider implements LlmProvider {
  readonly id = ID;
  readonly model: string;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeout: number;

  constructor(private readonly cfg: GeminiConfig) {
    if (!cfg.apiKey) throw new ProviderError(ID, 'auth');
    this.model = cfg.model ?? 'gemini-2.5-flash-lite';
    if (!MODEL_RE.test(this.model)) throw new ProviderError(ID, 'invalid_request');
    this.base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
    this.timeout = cfg.requestTimeoutMs ?? 120_000;
  }

  async generateJson(req: LlmJsonRequest): Promise<LlmJsonResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: req.maxOutputTokens,
        candidateCount: 1,
      },
    };
    // Key goes in a header, never in the URL (URLs end up in proxy/access logs).
    const res = await providerFetch(
      ID,
      this.fetchImpl,
      `${this.base}/v1beta/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.apiKey },
        body: JSON.stringify(body),
      },
      this.timeout,
      req.signal,
    );
    const out = (await readJson(ID, res)) as GeminiBody;
    if (out?.promptFeedback?.blockReason) throw new ProviderError(ID, 'provider_failed');
    const cand = out?.candidates?.[0];
    const finish = cand?.finishReason;
    if (
      finish === 'SAFETY' ||
      finish === 'RECITATION' ||
      finish === 'BLOCKLIST' ||
      finish === 'PROHIBITED_CONTENT'
    )
      throw new ProviderError(ID, 'provider_failed');
    if (finish === 'MAX_TOKENS') throw new ProviderError(ID, 'bad_response');
    const text = (cand?.content?.parts ?? [])
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join('');
    if (!text) throw new ProviderError(ID, 'bad_response');
    const u = out.usageMetadata;
    return {
      provider: ID,
      model:
        typeof out.modelVersion === 'string' && MODEL_RE.test(out.modelVersion)
          ? out.modelVersion
          : this.model,
      text,
      usage: {
        inputTokens: n(u?.promptTokenCount),
        outputTokens: n(u?.candidatesTokenCount),
        totalTokens: n(u?.totalTokenCount),
      },
    };
  }
}

/** Reads Gemini settings from env. Undefined when no key is set. */
/** Operators may only point at the official Gemini host (no arbitrary/SSRF-able endpoints, ADR-009). */
export const GEMINI_ALLOWED_HOSTS: readonly string[] = ['generativelanguage.googleapis.com'];

export function isAllowedGeminiBase(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    (u.port === '' || u.port === '443') &&
    GEMINI_ALLOWED_HOSTS.includes(u.hostname.toLowerCase())
  );
}

export function loadGeminiConfig(env: NodeJS.ProcessEnv = process.env): GeminiConfig | undefined {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const base = env.GEMINI_BASE_URL?.trim();
  if (base && !isAllowedGeminiBase(base)) throw new ProviderError(ID, 'invalid_request');
  const t = env.AI_SUMMARY_REQUEST_TIMEOUT_MS;
  const timeout =
    t && /^[0-9]{1,7}$/.test(t) ? Math.min(600_000, Math.max(1_000, Number(t))) : 120_000;
  return {
    apiKey,
    model: env.GEMINI_MODEL?.trim() || undefined,
    baseUrl: base || undefined,
    requestTimeoutMs: timeout,
  };
}

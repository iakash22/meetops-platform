import { timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_ASSEMBLYAI_SPEECH_MODELS,
  parseAssemblyAiSpeechModels,
  assemblyAiSpeechModelsFromEnv,
  InvalidAssemblyAiSpeechModelsError,
} from '@meetops/ai-core';
import { ProviderError, providerFetch, readJson, type FetchLike } from './errors.js';
import type {
  TranscribeRequest,
  TranscribeResult,
  TranscribedSegment,
  TranscriptionProvider,
} from './transcription-provider.js';

export type AssemblyAiConfig = {
  apiKey: string;
  baseUrl?: string | undefined;
  /** Per-HTTP-request timeout. */
  requestTimeoutMs?: number | undefined;
  /** Overall budget for submit + polling. */
  totalTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  /** Pre-recorded `speech_models` list. Defaults to the proposed `assemblyai-stt-3-7`. */
  speechModels?: readonly string[] | undefined;
  /** @deprecated Use `speechModels`. Treated as a single-value list when `speechModels` is omitted. */
  speechModel?: string | undefined;
  /** If set, AssemblyAI calls this URL on completion with `webhookAuthHeader` (webhook mode). */
  webhookUrl?: string | undefined;
  webhookSecret?: string | undefined;
  fetch?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
};

export const ASSEMBLYAI_WEBHOOK_HEADER = 'x-meetops-webhook-auth';
const ID = 'assemblyai';
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

type AaiWord = { start?: unknown; end?: unknown };
type AaiUtterance = {
  speaker?: unknown;
  start?: unknown;
  end?: unknown;
  text?: unknown;
  confidence?: unknown;
};
type AaiTranscript = {
  id?: unknown;
  status?: unknown;
  text?: unknown;
  language_code?: unknown;
  audio_duration?: unknown;
  speech_model?: unknown;
  speech_model_used?: unknown;
  utterances?: unknown;
  words?: unknown;
  confidence?: unknown;
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Map a completed AssemblyAI transcript to provider-neutral segments (utterances when diarized, else one segment). */
export function mapAssemblyAiTranscript(
  body: AaiTranscript,
  fallbackModel: string,
): TranscribeResult {
  const id = str(body.id);
  if (!id) throw new ProviderError(ID, 'bad_response');
  const text = str(body.text) ?? '';
  const segments: TranscribedSegment[] = [];
  if (Array.isArray(body.utterances)) {
    for (const u of body.utterances as AaiUtterance[]) {
      const t = str(u?.text);
      const start = num(u?.start);
      const end = num(u?.end);
      if (!t || start === null || end === null) continue;
      segments.push({
        speaker: str(u.speaker),
        startMs: Math.round(start),
        endMs: Math.max(Math.round(start), Math.round(end)),
        text: t,
        confidence: num(u.confidence),
      });
    }
  }
  if (segments.length === 0 && text) {
    const words = Array.isArray(body.words) ? (body.words as AaiWord[]) : [];
    const start = num(words[0]?.start) ?? 0;
    const end = num(words.at(-1)?.end) ?? Math.round((num(body.audio_duration) ?? 0) * 1000);
    segments.push({
      speaker: null,
      startMs: start,
      endMs: Math.max(start, end),
      text,
      confidence: num(body.confidence),
    });
  }
  const dur = num(body.audio_duration);
  return {
    provider: ID,
    model: str(body.speech_model_used) ?? str(body.speech_model) ?? fallbackModel,
    providerJobId: id,
    language: str(body.language_code),
    durationMs: dur === null ? null : Math.round(dur * 1000),
    text,
    segments,
  };
}

/** Constant-time check of the shared webhook header AssemblyAI echoes back. */
export function verifyAssemblyAiWebhook(
  headerValue: string | string[] | undefined,
  secret: string,
): boolean {
  if (!secret || typeof headerValue !== 'string') return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Parse a webhook body: `{ transcript_id, status }`. Returns undefined for anything else. */
export function parseAssemblyAiWebhook(
  body: unknown,
): { transcriptId: string; status: 'completed' | 'error' } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { transcript_id: id, status } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
  if (status !== 'completed' && status !== 'error') return undefined;
  return { transcriptId: id, status };
}

export class AssemblyAiTranscriptionProvider implements TranscriptionProvider {
  readonly id = ID;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly reqTimeout: number;
  private readonly totalTimeout: number;
  private readonly pollMs: number;
  private readonly models: readonly string[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly cfg: AssemblyAiConfig) {
    if (!cfg.apiKey) throw new ProviderError(ID, 'auth');
    this.base = (cfg.baseUrl ?? 'https://api.assemblyai.com').replace(/\/+$/, '');
    this.fetchImpl = cfg.fetch ?? ((u, i) => fetch(u, i));
    this.reqTimeout = cfg.requestTimeoutMs ?? 30_000;
    this.totalTimeout = cfg.totalTimeoutMs ?? 30 * 60_000;
    this.pollMs = cfg.pollIntervalMs ?? 5_000;
    this.models = resolveSpeechModels(cfg);
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = cfg.now ?? Date.now;
  }

  private call(path: string, init: RequestInit, signal?: AbortSignal) {
    const headers = {
      authorization: this.cfg.apiKey,
      ...(init.headers as Record<string, string> | undefined),
    };
    return providerFetch(
      ID,
      this.fetchImpl,
      `${this.base}${path}`,
      { ...init, headers },
      this.reqTimeout,
      signal,
    );
  }

  private async upload(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES)
      throw new ProviderError(ID, 'invalid_request');
    const res = await this.call(
      '/v2/upload',
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as unknown as BodyInit,
      },
      signal,
    );
    const url = str(((await readJson(ID, res)) as { upload_url?: unknown })?.upload_url);
    if (!url) throw new ProviderError(ID, 'bad_response');
    return url;
  }

  /** Submit a transcription job; returns the provider job id. */
  async submit(req: TranscribeRequest): Promise<string> {
    const audioUrl =
      req.audio.kind === 'url' ? req.audio.url : await this.upload(req.audio.bytes, req.signal);
    if (!/^https:\/\//.test(audioUrl)) throw new ProviderError(ID, 'invalid_request');
    const body: Record<string, unknown> = {
      audio_url: audioUrl,
      speaker_labels: req.speakerLabels,
      speech_models: [...this.models],
      ...(req.language ? { language_code: req.language } : { language_detection: true }),
    };
    if (this.cfg.webhookUrl && this.cfg.webhookSecret) {
      body.webhook_url = this.cfg.webhookUrl;
      body.webhook_auth_header_name = ASSEMBLYAI_WEBHOOK_HEADER;
      body.webhook_auth_header_value = this.cfg.webhookSecret;
    }
    const res = await this.call(
      '/v2/transcript',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      req.signal,
    );
    const id = str(((await readJson(ID, res)) as AaiTranscript)?.id);
    if (!id) throw new ProviderError(ID, 'bad_response');
    return id;
  }

  async fetchResult(
    providerJobId: string,
    signal?: AbortSignal,
  ): Promise<TranscribeResult | { status: 'pending' }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerJobId))
      throw new ProviderError(ID, 'invalid_request');
    const res = await this.call(`/v2/transcript/${providerJobId}`, { method: 'GET' }, signal);
    const body = (await readJson(ID, res)) as AaiTranscript;
    if (body?.status === 'completed') return mapAssemblyAiTranscript(body, this.models[0]!);
    if (body?.status === 'error') throw new ProviderError(ID, 'provider_failed');
    if (body?.status === 'queued' || body?.status === 'processing') return { status: 'pending' };
    throw new ProviderError(ID, 'bad_response');
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    const deadline = this.now() + this.totalTimeout;
    const id = await this.submit(req);
    for (;;) {
      const out = await this.fetchResult(id, req.signal);
      if ('providerJobId' in out) return out;
      if (this.now() + this.pollMs > deadline) throw new ProviderError(ID, 'timeout');
      if (req.signal?.aborted) throw new ProviderError(ID, 'timeout');
      await this.sleep(this.pollMs);
    }
  }
}

function resolveSpeechModels(cfg: AssemblyAiConfig): readonly string[] {
  try {
    if (cfg.speechModels && cfg.speechModels.length > 0) {
      return parseAssemblyAiSpeechModels(cfg.speechModels.join(','));
    }
    if (cfg.speechModel?.trim()) return parseAssemblyAiSpeechModels(cfg.speechModel);
    return [...DEFAULT_ASSEMBLYAI_SPEECH_MODELS];
  } catch (e) {
    if (e instanceof InvalidAssemblyAiSpeechModelsError)
      throw new ProviderError(ID, 'invalid_request');
    throw e;
  }
}

function loadSpeechModels(
  env: NodeJS.ProcessEnv,
): ReturnType<typeof assemblyAiSpeechModelsFromEnv> {
  try {
    return assemblyAiSpeechModelsFromEnv(env);
  } catch (e) {
    if (e instanceof InvalidAssemblyAiSpeechModelsError)
      throw new ProviderError(ID, 'invalid_request');
    throw e;
  }
}

const intEnv = (v: string | undefined, def: number, min: number, max: number) => {
  const n = v && /^[0-9]{1,9}$/.test(v) ? Number(v) : def;
  return Math.min(max, Math.max(min, n));
};

/** Reads AssemblyAI settings from env. Returns undefined when no key is set (provider not configured). */
export function loadAssemblyAiConfig(
  env: NodeJS.ProcessEnv = process.env,
): AssemblyAiConfig | undefined {
  const apiKey = env.ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const base = env.ASSEMBLYAI_BASE_URL?.trim();
  if (base && !/^https:\/\//.test(base)) throw new ProviderError(ID, 'invalid_request');
  return {
    apiKey,
    baseUrl: base || undefined,
    speechModels: loadSpeechModels(env),
    requestTimeoutMs: intEnv(env.AI_TRANSCRIPTION_REQUEST_TIMEOUT_MS, 30_000, 1_000, 300_000),
    totalTimeoutMs: intEnv(env.AI_TRANSCRIPTION_TIMEOUT_MS, 30 * 60_000, 10_000, 4 * 3_600_000),
    pollIntervalMs: intEnv(env.AI_TRANSCRIPTION_POLL_INTERVAL_MS, 5_000, 500, 60_000),
    webhookUrl: env.ASSEMBLYAI_WEBHOOK_URL?.trim() || undefined,
    webhookSecret: env.ASSEMBLYAI_WEBHOOK_SECRET?.trim() || undefined,
  };
}

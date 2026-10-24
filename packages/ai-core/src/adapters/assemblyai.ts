import type { ProviderHealth, TranscriptionCapabilities, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from '../types.js';
import { AIError, toAIError } from '../errors.js';
import { guardedFetch, type HttpOpts } from './http.js';
import { realSleep, type Sleeper } from '../retry.js';

export const ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com';

type Transcript = {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string | null;
  error?: string;
  audio_duration?: number | null;
  language_code?: string | null;
  utterances?: Array<{ start: number; end: number; text: string; speaker: string; confidence: number }> | null;
};

/**
 * AssemblyAI pre-recorded STT over REST (no SDK), via guardedFetch. Header `authorization: <key>`.
 *   POST /v2/upload       (application/octet-stream, raw bytes) -> { upload_url }
 *   POST /v2/transcript   { audio_url, speaker_labels, language_code | language_detection } -> { id, status }
 *   GET  /v2/transcript/{id}  polled with bounded attempts until completed | error (honours AbortSignal)
 * Audio is always sent as BYTES (uploaded) so AssemblyAI never fetches our internal/presigned URLs.
 */
export class AssemblyAIProvider implements TranscriptionProvider {
  readonly kind = 'stt' as const;
  constructor(
    private readonly http: Omit<HttpOpts, 'provider' | 'baseUrl'> & {
      apiKey?: string | undefined;
      baseUrl?: string | undefined;
      pollIntervalMs?: number | undefined;
      maxPollAttempts?: number | undefined;
      sleep?: Sleeper | undefined;
      speechModels?: string[] | undefined;
    },
    readonly providerId = 'assemblyai',
  ) {
    if (!http.apiKey) throw new AIError('MISSING_CREDENTIALS', 'AssemblyAI credential is required', { provider: providerId, retryable: false });
  }

  private o(json = true): HttpOpts {
    return {
      ...this.http,
      baseUrl: this.http.baseUrl ?? ASSEMBLYAI_BASE_URL,
      provider: this.providerId,
      headers: { authorization: this.http.apiKey ?? '', ...(json ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream' }) },
    };
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (!input.bytes) throw new AIError('CAPABILITY_UNSUPPORTED', 'AssemblyAI adapter requires audio bytes (no remote URL fetch)', { provider: this.providerId, retryable: false });
    const signal = input.signal;
    const sig = signal ? { signal } : {};
    try {
      const up = (await guardedFetch(this.o(false), 'v2/upload', { method: 'POST', body: input.bytes, ...sig })).json<{ upload_url: string }>();
      if (!/^https:\/\/cdn\.assemblyai\.com\//.test(up.upload_url ?? '')) throw new AIError('INVALID_OUTPUT', 'unexpected upload_url', { provider: this.providerId, retryable: false });
      const created = (
        await guardedFetch(this.o(), 'v2/transcript', {
          method: 'POST',
          body: JSON.stringify({
            audio_url: up.upload_url,
            speaker_labels: input.diarize ?? true,
            ...(input.language ? { language_code: input.language } : { language_detection: true }),
            ...(this.http.speechModels ? { speech_models: this.http.speechModels } : {}),
          }),
          ...sig,
        })
      ).json<Transcript>();
      if (!/^[A-Za-z0-9-]+$/.test(created.id ?? '')) throw new AIError('INVALID_OUTPUT', 'unexpected transcript id', { provider: this.providerId, retryable: false });
      const t = await this.poll(created.id, signal);
      return {
        text: t.text ?? '',
        segments: (t.utterances ?? []).map((u) => ({ startSec: u.start / 1000, endSec: u.end / 1000, text: u.text, speaker: u.speaker, confidence: u.confidence })),
        language: t.language_code ?? undefined,
        durationSec: t.audio_duration ?? undefined,
        providerJobId: t.id,
      };
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
  }

  private async poll(id: string, signal?: AbortSignal): Promise<Transcript> {
    const max = Math.min(this.http.maxPollAttempts ?? 200, 1000);
    const sleep = this.http.sleep ?? realSleep;
    for (let i = 0; i < max; i++) {
      if (signal?.aborted) throw new AIError('TIMEOUT', 'polling aborted', { provider: this.providerId });
      const t = (await guardedFetch(this.o(), `v2/transcript/${id}`, signal ? { signal } : {})).json<Transcript>();
      if (t.status === 'completed') return t;
      if (t.status === 'error') throw new AIError('MODEL_ERROR', 'AssemblyAI transcription failed', { provider: this.providerId, retryable: false });
      await sleep(this.http.pollIntervalMs ?? 3000, signal);
    }
    throw new AIError('TIMEOUT', `transcript not ready after ${max} polls`, { provider: this.providerId });
  }

  async getCapabilities(): Promise<TranscriptionCapabilities> {
    return { batch: true, streaming: false, diarization: true, languages: ['en', 'hi', 'es', 'fr', 'de', 'auto'] };
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await guardedFetch(this.o(), 'v2/transcript?limit=1');
      return { ok: true, timestamp: new Date().toISOString() };
    } catch (e) {
      return { ok: false, message: toAIError(e, this.providerId).code, timestamp: new Date().toISOString() };
    }
  }
}

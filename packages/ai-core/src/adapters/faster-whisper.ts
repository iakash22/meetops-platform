import type { ProviderHealth, TranscriptionCapabilities, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from '../types.js';
import { AIError, toAIError } from '../errors.js';
import { guardedFetch, type HttpOpts } from './http.js';

type VerboseJson = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number }>;
};

/**
 * Local faster-whisper over an OpenAI-compatible HTTP API (e.g. speaches / faster-whisper-server):
 *   POST {LOCAL_STT_URL}/v1/audio/transcriptions  (multipart: file, model, response_format=verbose_json, language?)
 *   GET  {LOCAL_STT_URL}/health
 * Only raw bytes are supported (the server does not fetch URLs). No diarization.
 */
export class FasterWhisperProvider implements TranscriptionProvider {
  readonly kind = 'stt' as const;
  constructor(private readonly http: Omit<HttpOpts, 'provider'> & { model: string }, readonly providerId = 'faster-whisper') {}
  private o(): HttpOpts {
    return { ...this.http, provider: this.providerId };
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (!input.bytes) throw new AIError('CAPABILITY_UNSUPPORTED', 'faster-whisper adapter requires audio bytes', { provider: this.providerId, retryable: false });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType ?? 'application/octet-stream' }), 'audio');
    form.append('model', this.http.model);
    form.append('response_format', 'verbose_json');
    if (input.language) form.append('language', input.language);
    let j: VerboseJson;
    try {
      const res = await guardedFetch(this.o(), 'v1/audio/transcriptions', { method: 'POST', body: form, ...(input.signal ? { signal: input.signal } : {}) });
      j = res.json<VerboseJson>();
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
    return {
      text: j.text ?? '',
      segments: (j.segments ?? []).map((s) => ({ startSec: s.start, endSec: s.end, text: s.text.trim() })),
      language: j.language,
      durationSec: j.duration,
    };
  }

  async getCapabilities(): Promise<TranscriptionCapabilities> {
    return { batch: true, streaming: false, diarization: false, languages: ['auto'] };
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      await guardedFetch(this.o(), 'health');
      return { ok: true, timestamp: new Date().toISOString() };
    } catch (e) {
      return { ok: false, message: toAIError(e, this.providerId).message, timestamp: new Date().toISOString() };
    }
  }
}

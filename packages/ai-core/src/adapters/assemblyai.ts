import { AssemblyAI, type Transcript, type TranscribeParams } from 'assemblyai';
import type { ProviderHealth, TranscriptionCapabilities, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from '../types.js';
import { AIError, toAIError } from '../errors.js';

export type AssemblyAITranscriptsClient = Pick<AssemblyAI['transcripts'], 'transcribe' | 'list'>;

/**
 * AssemblyAI async (pre-recorded) transcription via the official `assemblyai` SDK.
 * `transcripts.transcribe()` submits and polls until completed/error.
 */
export class AssemblyAIProvider implements TranscriptionProvider {
  readonly kind = 'stt' as const;
  private readonly transcripts: AssemblyAITranscriptsClient;
  constructor(
    opts: { apiKey?: string | undefined; client?: AssemblyAITranscriptsClient | undefined; speechModels?: string[] | undefined },
    readonly providerId = 'assemblyai',
    private readonly speechModels: string[] | undefined = opts.speechModels,
  ) {
    if (opts.client) this.transcripts = opts.client;
    else {
      if (!opts.apiKey) throw new AIError('MISSING_CREDENTIALS', 'ASSEMBLYAI_API_KEY is required', { provider: providerId, retryable: false });
      this.transcripts = new AssemblyAI({ apiKey: opts.apiKey }).transcripts;
    }
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const audio = input.url ?? (input.bytes ? Buffer.from(input.bytes) : undefined);
    if (!audio) throw new AIError('CONFIG_INVALID', 'transcribe requires url or bytes', { provider: this.providerId, retryable: false });
    const params: TranscribeParams = {
      audio,
      speaker_labels: input.diarize ?? true,
      ...(input.language ? { language_code: input.language } : { language_detection: true }),
      ...(this.speechModels ? { speech_models: this.speechModels } : {}),
    };
    let t: Transcript;
    try {
      t = await this.transcripts.transcribe(params);
    } catch (e) {
      throw toAIError(e, this.providerId);
    }
    if (t.status === 'error') throw new AIError('MODEL_ERROR', t.error ?? 'AssemblyAI transcription failed', { provider: this.providerId, retryable: false });
    const segments = (t.utterances ?? []).map((u) => ({
      startSec: u.start / 1000,
      endSec: u.end / 1000,
      text: u.text,
      speaker: u.speaker,
      confidence: u.confidence,
    }));
    return {
      text: t.text ?? '',
      segments,
      language: t.language_code ?? undefined,
      durationSec: t.audio_duration ?? undefined,
      providerJobId: t.id,
    };
  }

  async getCapabilities(): Promise<TranscriptionCapabilities> {
    // Streaming exists in AssemblyAI (Universal-Streaming) but is not wired in this adapter yet.
    return { batch: true, streaming: false, diarization: true, languages: ['en', 'hi', 'es', 'fr', 'de', 'auto'] };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t = Date.now();
    try {
      await this.transcripts.list({ limit: 1 });
      return { ok: true, latencyMs: Date.now() - t, timestamp: new Date().toISOString() };
    } catch (e) {
      return { ok: false, message: toAIError(e, this.providerId).code, timestamp: new Date().toISOString() };
    }
  }
}

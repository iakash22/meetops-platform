import type { ProviderHealth, TranscriptionCapabilities, TranscriptionProvider, TranscriptionResult } from '../types.js';
import { AIError } from '../errors.js';

/** Placeholder for a future Deepgram adapter. Always disabled; every call fails clearly. */
export class DeepgramProvider implements TranscriptionProvider {
  readonly kind = 'stt' as const;
  readonly providerId = 'deepgram';
  async transcribe(): Promise<TranscriptionResult> {
    throw new AIError('PROVIDER_DISABLED', 'Deepgram adapter is not implemented yet', { provider: 'deepgram', retryable: false });
  }
  async getCapabilities(): Promise<TranscriptionCapabilities> {
    return { batch: false, streaming: false, diarization: false, languages: [] };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return { ok: false, message: 'not implemented', timestamp: new Date().toISOString() };
  }
}

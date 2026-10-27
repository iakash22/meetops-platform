/** Worker-side speech-to-text port. Adapters use plain fetch; no SDKs. */
export type TranscriptionAudio =
  | { kind: 'url'; url: string }
  | { kind: 'bytes'; bytes: Uint8Array; mimeType?: string | undefined };

export type TranscribeRequest = {
  audio: TranscriptionAudio;
  language?: string | undefined;
  speakerLabels: boolean;
  signal?: AbortSignal | undefined;
};

export type TranscribedSegment = {
  speaker: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
};

export type TranscribeResult = {
  provider: string;
  model: string;
  providerJobId: string;
  language: string | null;
  durationMs: number | null;
  text: string;
  segments: TranscribedSegment[];
};

export interface TranscriptionProvider {
  readonly id: string;
  /** Submit and wait (polling) for a finished transcript. Throws ProviderError. */
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
  /** Fetch a finished transcript by provider job id (webhook mode). Throws ProviderError. */
  fetchResult(
    providerJobId: string,
    signal?: AbortSignal,
  ): Promise<TranscribeResult | { status: 'pending' }>;
}

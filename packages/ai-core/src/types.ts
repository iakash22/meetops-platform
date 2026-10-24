import type { OutputStep } from './output-limits.js';
import type { z } from 'zod';

/** Provider kinds supported by the registry. */
export type ProviderKind = 'llm' | 'stt';

/** Individual capabilities a provider may (or may not) offer. Never assume uniformity. */
export const CAPABILITIES = [
  'text-generation',
  'structured-output',
  'batch-transcription',
  'streaming-transcription',
  'diarization',
  'embeddings',
  'audio-understanding',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type ProviderHealth = {
  ok: boolean;
  message?: string | undefined;
  latencyMs?: number | undefined;
  timestamp: string;
};

/** Usage recorded for every AI call. */
export type AIUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  audioSeconds?: number | undefined;
  /** Estimated cost in USD (0 for free-tier/local providers). */
  estimatedCostUsd: number;
};

/** Metadata attached to every AI result for provenance & auditability. */
export type AIResultMeta = {
  provider: string;
  model: string;
  promptVersion: string;
  usage: AIUsage;
  /** Revision of the transcript the result was derived from / produced, where applicable. */
  transcriptRevision?: number | undefined;
  idempotencyKey?: string | undefined;
  /** True when served from the idempotency store (no new provider call). */
  cached?: boolean | undefined;
};

export type LLMGenerateTextParams = {
  model: string;
  system?: string | undefined;
  prompt: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  /** Pipeline step (map/reduce) for step-specific default output caps; see output-limits.ts. */
  step?: OutputStep | undefined;
  stopSequences?: string[] | undefined;
  signal?: AbortSignal | undefined;
};

export type LLMTextResult = {
  text: string;
  finishReason?: string | undefined;
  usage: Omit<AIUsage, 'estimatedCostUsd'>;
};

export type LLMGenerateStructuredParams<S extends z.ZodType> = Omit<LLMGenerateTextParams, 'stopSequences'> & {
  schema: S;
  schemaName: string;
};

export type LLMStructuredResult<T> = {
  value: T;
  rawText?: string | undefined;
  usage: Omit<AIUsage, 'estimatedCostUsd'>;
};

export interface LLMProvider {
  readonly providerId: string;
  readonly kind: 'llm';
  listModels(): Promise<string[]>;
  generateText(params: LLMGenerateTextParams): Promise<LLMTextResult>;
  generateStructured<S extends z.ZodType>(
    params: LLMGenerateStructuredParams<S>,
  ): Promise<LLMStructuredResult<z.infer<S>>>;
  healthCheck(): Promise<ProviderHealth>;
}

export type TranscriptSegment = {
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string | undefined;
  confidence?: number | undefined;
};

export type TranscriptionInput = {
  /** Publicly reachable (or pre-signed) URL to the audio. */
  url?: string | undefined;
  bytes?: Uint8Array | undefined;
  mimeType?: string | undefined;
  language?: string | undefined;
  diarize?: boolean | undefined;
  signal?: AbortSignal | undefined;
};

export type TranscriptionResult = {
  text: string;
  segments: TranscriptSegment[];
  language?: string | undefined;
  durationSec?: number | undefined;
  providerJobId?: string | undefined;
};

export type TranscriptionCapabilities = {
  batch: boolean;
  streaming: boolean;
  diarization: boolean;
  languages: string[];
  maxFileDurationSec?: number | undefined;
  maxFileBytes?: number | undefined;
};

export interface TranscriptionProvider {
  readonly providerId: string;
  readonly kind: 'stt';
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
  getCapabilities(): Promise<TranscriptionCapabilities>;
  healthCheck(): Promise<ProviderHealth>;
}

/* ---------- Optional capability interfaces (detect, never assume) ---------- */

export interface StreamingTranscription {
  openStream(opts: { language?: string; sampleRate: number; encoding: 'pcm_s16le' | 'opus' }): Promise<{
    send(chunk: Uint8Array): void;
    onPartial(cb: (seg: TranscriptSegment) => void): void;
    onFinal(cb: (seg: TranscriptSegment) => void): void;
    close(): Promise<void>;
  }>;
}

export interface Diarization {
  diarize(input: TranscriptionInput): Promise<TranscriptSegment[]>;
}

export interface Embeddings {
  embed(params: { model: string; inputs: string[] }): Promise<{ vectors: number[][]; usage: Omit<AIUsage, 'estimatedCostUsd'> }>;
}

export interface AudioUnderstanding {
  understandAudio(params: { model: string; prompt: string; audio: TranscriptionInput }): Promise<LLMTextResult>;
}

export type AnyProvider = LLMProvider | TranscriptionProvider;

export const hasStreaming = (p: unknown): p is StreamingTranscription =>
  typeof (p as Partial<StreamingTranscription>)?.openStream === 'function';
export const hasDiarization = (p: unknown): p is Diarization =>
  typeof (p as Partial<Diarization>)?.diarize === 'function';
export const hasEmbeddings = (p: unknown): p is Embeddings => typeof (p as Partial<Embeddings>)?.embed === 'function';
export const hasAudioUnderstanding = (p: unknown): p is AudioUnderstanding =>
  typeof (p as Partial<AudioUnderstanding>)?.understandAudio === 'function';

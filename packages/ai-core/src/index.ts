export type ProviderHealth = {
  ok: boolean;
  message?: string;
  latencyMs?: number;
  timestamp: string;
};

export type LLMGenerateTextParams = {
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
};

export type LLMStructuredSchema<T> = {
  name: string;
  description?: string;
  schema: T; // Provider-specific JSON schema or zod shape in adapters
};

export interface LLMProvider {
  readonly providerId: string;
  listModels(): Promise<string[]>;
  generateText(params: LLMGenerateTextParams): Promise<{ text: string; finishReason?: string }>;
  generateStructured<T>(params: {
    model: string;
    schema: LLMStructuredSchema<unknown>;
    prompt: string;
    temperature?: number;
  }): Promise<{ value: T; rawText?: string }>;
  healthCheck(): Promise<ProviderHealth>;
}

export type TranscriptionResult = {
  text: string;
  segments?: Array<{
    startSec: number;
    endSec: number;
    text: string;
    speaker?: string;
    confidence?: number;
  }>;
  language?: string;
  durationSec?: number;
};

export type TranscriptionCapabilities = {
  speakerDiarization: boolean;
  languages: string[]; // BCP-47 codes
  maxFileDurationSec?: number;
  supportsStreaming?: boolean;
};

export interface TranscriptionProvider {
  readonly providerId: string;
  transcribe(input: { url?: string; bytes?: Uint8Array; language?: string }): Promise<TranscriptionResult>;
  getCapabilities(): Promise<TranscriptionCapabilities>;
  healthCheck(): Promise<ProviderHealth>;
}

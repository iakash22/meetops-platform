import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSEMBLYAI_SPEECH_MODELS,
  InvalidAssemblyAiSpeechModelsError,
  assemblyAiSpeechModelsFromEnv,
  defaultProviderConfigs,
  loadAIEnv,
  parseAssemblyAiSpeechModels,
} from '../src/index.js';

describe('AssemblyAI speech model config', () => {
  it('defaults to the proposed assemblyai-stt-3-7 list', () => {
    expect(parseAssemblyAiSpeechModels(undefined)).toEqual(['assemblyai-stt-3-7']);
    expect(parseAssemblyAiSpeechModels('')).toEqual(['assemblyai-stt-3-7']);
    expect(DEFAULT_ASSEMBLYAI_SPEECH_MODELS).toEqual(['assemblyai-stt-3-7']);
  });

  it('parses a comma-separated list, trims, and drops duplicates', () => {
    expect(
      parseAssemblyAiSpeechModels('assemblyai-stt-3-7, universal-2,assemblyai-stt-3-7'),
    ).toEqual(['assemblyai-stt-3-7', 'universal-2']);
  });

  it('rejects the legacy universal alias and unknown names', () => {
    expect(() => parseAssemblyAiSpeechModels('universal')).toThrow(
      InvalidAssemblyAiSpeechModelsError,
    );
    expect(() => parseAssemblyAiSpeechModels('nano')).toThrow(InvalidAssemblyAiSpeechModelsError);
  });

  it('prefers ASSEMBLYAI_SPEECH_MODELS over the singular alias', () => {
    expect(
      assemblyAiSpeechModelsFromEnv({
        ASSEMBLYAI_SPEECH_MODELS: 'universal-2',
        ASSEMBLYAI_SPEECH_MODEL: 'assemblyai-stt-3-7',
      }),
    ).toEqual(['universal-2']);
  });

  it('registers the proposed default on the AssemblyAI provider config', () => {
    const cfg = defaultProviderConfigs(loadAIEnv({}).env).find((c) => c.name === 'assemblyai');
    expect(cfg?.model).toBe('assemblyai-stt-3-7');
  });
});

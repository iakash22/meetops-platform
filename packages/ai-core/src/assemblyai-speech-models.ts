/**
 * Official AssemblyAI pre-recorded speech models (`speech_models` on POST /v2/transcript).
 *
 * Proposed default: `assemblyai-stt-3-7` ($0.21/h). This is a cost-setting choice that Akash
 * should confirm. See docs/09-ai/transcription.md for the justification and sources.
 */
export const ASSEMBLYAI_PRE_RECORDED_SPEECH_MODELS = ['assemblyai-stt-3-7', 'universal-2'] as const;
export type AssemblyAiSpeechModel = (typeof ASSEMBLYAI_PRE_RECORDED_SPEECH_MODELS)[number];

/** Proposed default (owner confirmation required): flagship model, $0.21/h list. */
export const DEFAULT_ASSEMBLYAI_SPEECH_MODELS = [
  'assemblyai-stt-3-7',
] as const satisfies readonly AssemblyAiSpeechModel[];

const ALLOWED = new Set<string>(ASSEMBLYAI_PRE_RECORDED_SPEECH_MODELS);

export class InvalidAssemblyAiSpeechModelsError extends Error {
  override readonly name = 'InvalidAssemblyAiSpeechModelsError';
  constructor() {
    super('Invalid ASSEMBLYAI_SPEECH_MODELS: allowed values are assemblyai-stt-3-7, universal-2');
  }
}

/** Parse a comma-separated model list. Empty/unset -> proposed default. Unknown tokens throw. */
export function parseAssemblyAiSpeechModels(raw: string | undefined): AssemblyAiSpeechModel[] {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [...DEFAULT_ASSEMBLYAI_SPEECH_MODELS];
  const out: AssemblyAiSpeechModel[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (!ALLOWED.has(p)) throw new InvalidAssemblyAiSpeechModelsError();
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p as AssemblyAiSpeechModel);
  }
  return out;
}

/**
 * `ASSEMBLYAI_SPEECH_MODELS` (comma-separated) wins when set; otherwise the legacy
 * singular `ASSEMBLYAI_SPEECH_MODEL` is accepted as a single-value alias.
 */
export function assemblyAiSpeechModelsFromEnv(
  source: Record<string, string | undefined>,
): AssemblyAiSpeechModel[] {
  const plural = source.ASSEMBLYAI_SPEECH_MODELS?.trim();
  const singular = source.ASSEMBLYAI_SPEECH_MODEL?.trim();
  return parseAssemblyAiSpeechModels(plural || singular || undefined);
}

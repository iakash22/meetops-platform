/** Worker-side LLM port. Adapters use plain fetch; no SDKs. Output is untrusted text the caller must validate. */
export type LlmJsonRequest = {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type LlmUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type LlmJsonResult = {
  provider: string;
  model: string;
  /** Raw model text that should contain one JSON object. Never trusted; never logged. */
  text: string;
  usage: LlmUsage;
};

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  generateJson(req: LlmJsonRequest): Promise<LlmJsonResult>;
}

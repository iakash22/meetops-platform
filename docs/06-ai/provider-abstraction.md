# AI provider abstraction (`@meetops/ai-core`)

## Contracts

- `LLMProvider`: `listModels()`, `generateText()`, `generateStructured({ schema: ZodType })`, `healthCheck()`.
- `TranscriptionProvider`: `transcribe()`, `getCapabilities()`, `healthCheck()`.
- Optional capability interfaces, detected at runtime (never assumed): `StreamingTranscription`, `Diarization`,
  `Embeddings`, `AudioUnderstanding` (`hasStreaming()`, `hasDiarization()`, `hasEmbeddings()`, `hasAudioUnderstanding()`).
  Routing also uses the declared `capabilities[]` in each provider config.

## Provider config (`providerConfigSchema`, zod)

`name, type (llm|stt), adapter, model, enabled, credentialRef, baseUrl, local, capabilities, languages, inputLimits,
concurrency, timeoutMs, retryPolicy, cost, usage, health, fallbackPriority`.

- `credentialRef` is `env:NAME` or `secret:path` — a raw key fails validation. Keys are resolved only inside the
  registry and are never stored in configs, audit events, or `toPublicProviderConfig()` output (safe for the frontend).
- `retryPolicy.maxAttempts` is 1–5 (schema), and `withRetry` additionally hard-caps at 5. Only retryable errors retry.
- `cost`: `{ tier: 'free' }` or `{ tier: 'paid', inputPer1MTokens, outputPer1MTokens, perAudioHour }`.

## Environment (`loadAIEnv`)

| Var                                                              | Default                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| AI_LLM_PROVIDER                                                  | gemini                                                       |
| GEMINI_MODEL                                                     | gemini-2.5-flash-lite                                        |
| GEMINI_API_KEY                                                   | –                                                            |
| AI_STT_PROVIDER                                                  | assemblyai                                                   |
| ASSEMBLYAI_API_KEY                                               | –                                                            |
| OLLAMA_ENABLED / OLLAMA_BASE_URL / OLLAMA_MODEL                  | false / http://localhost:11434 / llama3.2                    |
| LOCAL_STT_ENABLED / LOCAL_STT_URL / LOCAL_STT_MODEL              | false / http://localhost:8000 / Systran/faster-whisper-small |
| OPENAI_ENABLED / OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL | false / – / https://api.openai.com/v1 / gpt-4o-mini          |
| DEEPGRAM_ENABLED / DEEPGRAM_API_KEY                              | false (adapter is a stub)                                    |
| AI_ALLOW_PAID_FALLBACK                                           | false                                                        |
| AI_REQUIRE_PROVIDER_APPROVAL                                     | true                                                         |

`loadAIEnv()` never throws: missing keys mark the provider unavailable with a clear reason; malformed values are
reported in `errors` and replaced by defaults.

## Adapters

| Adapter           | Transport                                                                                                                                 | Default            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Gemini            | official `@google/genai` (`models.generateContent`, `responseMimeType: application/json` + `responseJsonSchema = z.toJSONSchema(schema)`) | enabled, needs key |
| AssemblyAI        | official `assemblyai` SDK (`transcripts.transcribe`, polls until done, `speaker_labels`)                                                  | enabled, needs key |
| Ollama            | REST `POST /api/chat` (`stream:false`, `format: <JSON schema>`), `GET /api/tags`                                                          | disabled           |
| OpenAI-compatible | REST `POST /chat/completions` (`response_format: json_schema`), `GET /models`                                                             | disabled           |
| faster-whisper    | OpenAI-compatible REST, see transcription.md                                                                                              | disabled           |
| Deepgram          | stub, always `PROVIDER_DISABLED`                                                                                                          | disabled           |

The SDK adapters talk only to fixed official hosts. The REST adapters go through `guardedFetch` (SSRF guard, pinned IP, no
redirects, 5 s connect timeout, 10 MB response cap).

## Security

- **Endpoint allowlist**: `endpointPolicyFromEnv()`. Remote hosts are backend-defined. A local origin is added only
  when its provider is enabled.
- **SSRF** (`assertSafeEndpoint`): remote calls are HTTPS-only, the host must be allowlisted, the URL may not carry
  userinfo, and DNS is resolved before the call. The request is rejected if ANY address is private or reserved: IPv4
  0/8, 10/8, 100.64/10, 127/8, 169.254/16 (metadata), 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4; IPv6
  ::1, ::, fc00::/7, fe80::/10, ff00::/8, all IPv4-mapped ::ffff:0:0/96, 64:ff9b::/96, fd00:ec2::254. The validated IP is
  **pinned** with an undici `Agent` `connect.lookup`, so SNI and Host stay the hostname (DNS-rebinding defence).
- **Audit**: `AuditSink` receives create/update/override events with redacted before/after values.
- **Prompt injection**: see `prompts.ts`. Transcripts are fenced in `<untrusted_transcript>`, delimiter sequences are
  escaped, and the system prompt tells the model to treat the block as data. Outputs go through `.strict()` zod schemas
  with a bounded repair loop (max 2). Action items are `status: 'draft'` (a literal) until a human approves them.

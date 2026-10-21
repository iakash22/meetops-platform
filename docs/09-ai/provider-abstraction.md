# Provider abstraction

Status: design. Phase 0 ships contracts only (`packages/ai-core`); registry and adapters come later (ADR-002).

## Contracts

- `LLMProvider`: text generation and structured output for reports, decisions and action extraction.
- `TranscriptionProvider`: audio to timestamped, speaker-attributed transcript.

Business modules depend only on these interfaces, never on a vendor SDK.

## Providers

| Role | Primary                                   | Optional (disabled by default)                                 |
| ---- | ----------------------------------------- | -------------------------------------------------------------- |
| LLM  | Gemini (`AI_LLM_PROVIDER=gemini`)         | Ollama (`OLLAMA_ENABLED`), OpenAI (`OPENAI_ENABLED`)           |
| STT  | AssemblyAI (`AI_STT_PROVIDER=assemblyai`) | Local STT (`LOCAL_STT_ENABLED`), Deepgram (`DEEPGRAM_ENABLED`) |

## Rules

- **No automatic paid fallback.** If the primary fails, the job fails or retries on the same provider. Switching to another paid provider needs explicit config (`AI_ALLOW_PAID_FALLBACK=true`) and approval (`AI_REQUIRE_PROVIDER_APPROVAL`). Both default to the safe value in `.env.example`.
- **Outbound allowlist.** Adapters may only call endpoints on a configured allowlist of provider hosts. Requests to any other host are rejected and logged.
- Transcripts are untrusted input to the LLM.
- API keys come from env vars only and are never logged.
- Tests mock providers at the contract boundary.

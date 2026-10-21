# AI

Canonical folder for AI docs (`@meetops/ai-core`), per Architecture's numbering. `docs/06-worker` covers the worker.

## Approved decisions

- **Gemini** is the primary LLM (`AI_LLM_PROVIDER=gemini`, model in `GEMINI_MODEL`).
- **AssemblyAI** is the primary speech-to-text provider (`AI_STT_PROVIDER=assemblyai`).
- **No automatic paid fallback.** Using another paid provider requires explicit config and approval: `AI_ALLOW_PAID_FALLBACK=false` and `AI_REQUIRE_PROVIDER_APPROVAL=true` by default. The contracts `FallbackPolicy` defaults to `allowPaidFallback: false` with no fallback routes (ADR-003, `@meetops/contracts`).
- **Outbound allowlist.** Provider endpoints are restricted to an allowlist; requests to other hosts are rejected.
- Transcripts are untrusted input to the LLM. API keys come from env vars only and are never logged.
- Optional providers are disabled by default: Ollama (`OLLAMA_ENABLED`), local STT (`LOCAL_STT_ENABLED`), OpenAI (`OPENAI_ENABLED`) and Deepgram (`DEEPGRAM_ENABLED`).

See also ADR-002 (provider interfaces) and ADR-003 (contracts).

## Detailed pages

Provider abstraction, model routing, transcription and cost-optimization pages are being added by the AI agent in **open PR #21** (`feat/ai-provider-registry`). #21 currently places them under `docs/06-ai`; they're due to move here, to `docs/09-ai`, before it merges.

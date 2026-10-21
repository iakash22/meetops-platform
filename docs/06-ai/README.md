# AI

Canonical folder for AI docs (`@meetops/ai-core`). It replaces `docs/09-ai`, which now only redirects here.

## Approved decisions

- **Gemini** is the primary LLM (`AI_LLM_PROVIDER=gemini`).
- **AssemblyAI** is the primary speech-to-text provider (`AI_STT_PROVIDER=assemblyai`).
- **No automatic paid fallback.** Using another paid provider requires explicit config and approval (`AI_ALLOW_PAID_FALLBACK=false`, `AI_REQUIRE_PROVIDER_APPROVAL=true` by default).
- **Outbound allowlist.** Provider endpoints are restricted to an allowlist.
- Transcripts are untrusted input to the LLM. API keys come from env vars only and are never logged.

See also ADR-002 (provider interfaces) and ADR-003 (contracts, including `FallbackPolicy`).

## Pages

These are added by the AI agent in **open PR #21** (`feat/ai-provider-registry`); the links resolve once it merges.

- [Provider abstraction](provider-abstraction.md): contracts, provider config, env, adapters, security
- [Model routing](model-routing.md): precedence, candidate planning, execution, idempotency
- [Transcription](transcription.md): AssemblyAI, local faster-whisper, results
- [Cost optimization](cost-optimization.md): quotas, budgets, no free→paid fallback

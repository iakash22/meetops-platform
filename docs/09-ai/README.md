# AI (`@meetops/ai-core`)

Canonical folder for AI docs. (`docs/06-ai/README.md` on integration/phase-1 is an older pointer; see the AI PRs.)

## Approved decisions

- **Gemini** is the primary LLM (`AI_LLM_PROVIDER=gemini`).
- **AssemblyAI** is the primary speech-to-text provider (`AI_STT_PROVIDER=assemblyai`).
- **No automatic paid fallback.** Using another paid provider requires explicit config and approval (`AI_ALLOW_PAID_FALLBACK=false`, `AI_REQUIRE_PROVIDER_APPROVAL=true` by default).
- **Outbound allowlist.** Provider endpoints are restricted to an allowlist.
- Transcripts are untrusted input to the LLM. API keys are never logged.

See also ADR-002 (provider interfaces) and ADR-003 (contracts, including `FallbackPolicy`).

## Pages

- [Provider abstraction](./provider-abstraction.md): contracts, config, env, adapters, security
- [Model routing](./model-routing.md): precedence, fallback, execution
- [Transcription](./transcription.md)
- [Cost optimization](./cost-optimization.md)

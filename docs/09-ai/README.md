# AI

Design docs for the AI layer (`packages/ai-core`). See also ADR-002.

- [Provider abstraction](provider-abstraction.md)
- [Model routing](model-routing.md)
- [Transcription](transcription.md)
- [Cost optimization](cost-optimization.md)

Approved decisions: Gemini is the primary LLM; AssemblyAI is the primary speech-to-text provider; there is no automatic paid fallback to another provider; outbound provider endpoints are restricted by an allowlist.

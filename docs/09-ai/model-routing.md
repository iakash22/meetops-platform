# Model routing

Status: design.

- The LLM provider is chosen by `AI_LLM_PROVIDER` (default `gemini`); the model by `GEMINI_MODEL` (`.env.example` sets `gemini-2.5-flash-lite`).
- Routing is config-driven: a task type (for example summary, decision extraction, action extraction) maps to a provider and model in config, not in business code.
- Routing never crosses to a different paid provider on its own. A failed call is retried on the same route with backoff; cross-provider routes are used only when explicitly configured and approved (`AI_ALLOW_PAID_FALLBACK`, `AI_REQUIRE_PROVIDER_APPROVAL`).
- Local providers (Ollama) are opt-in via `OLLAMA_ENABLED` and `OLLAMA_BASE_URL`.
- Every routed call goes through the outbound endpoint allowlist.
- Each call records provider, model and task type for audit and cost tracking.

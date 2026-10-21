# Cost optimization

- Defaults are free-tier: Gemini `gemini-2.5-flash-lite` and AssemblyAI. Ollama and faster-whisper are free local options.
- **No automatic free→paid fallback.** With `AI_ALLOW_PAID_FALLBACK=false` (the default), a paid provider is never tried
  after a free one fails. Even when the flag is true, a paid provider must be an explicit org fallback.
- **Per-provider quotas** (`usage.dailyRequestLimit`, `dailyTokenLimit`, `monthlyAudioSecondsLimit`) and a **per-org
  monthly budget** (`OrgAIConfig.monthlyBudgetUsd`, applied to paid providers) are checked _before_ each call.
  When a limit is hit, the job becomes `waiting` instead of spending money.
- Cost estimate: `estimateCost()` uses token and audio-hour rates from the provider config. Free providers cost 0.
- Idempotency keys stop duplicate AI calls on retries and redeliveries.
- Bounded retries (max 5) and bounded repair attempts (max 2) cap the worst-case spend per job.
- Usage records (`UsageTracker`) are per tenant, provider, model and feature, so they can drive dashboards and alerts.

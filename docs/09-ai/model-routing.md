# Model routing

## Precedence (lowest → highest)

1. **system** default (`SYSTEM_DEFAULTS`: llm=gemini/gemini-2.5-flash-lite, stt=assemblyai)
2. **env** (`AI_LLM_PROVIDER` + model var, `AI_STT_PROVIDER`)
3. **organization** default per kind (`OrgAIConfig.defaults.llm|stt`)
4. **feature/workflow** (`OrgAIConfig.features[feature]`)
5. **explicit per-request override**, which is accepted only with `authorized: true` (otherwise `UNAUTHORIZED_OVERRIDE`)

Features: transcription, live-transcription, summary, agenda, decisions, highlights, actions, employee-suggestions,
deadlines, reports, follow-ups. Each one maps to a kind (stt/llm) and a required capability (`FEATURE_CAPABILITY`).

## Resolution algorithm (`ModelRouter.resolve(organizationId, feature, override?)`)

```
kind = featureKind(feature)
org  = orgStore.get(organizationId)                # organization-scoped; nothing is shared between organizations
layers = [system, env, org.defaults[kind], org.features[feature], override]
chosen = last non-empty layer                      # highest precedence wins
provider = chosen.provider; model = chosen.model ?? providerConfig.model
fallbacks = chosen.fallbacks (or, for a request override, the org feature/default fallbacks)
```

Each call returns a `trace` of every layer for explainability.

## Candidate planning (`planCandidates`)

Order: primary → explicit fallbacks. **There is no implicit fallback** (ADR-009): enabled local providers (Ollama,
faster-whisper) are never appended automatically; they run only when chosen as the primary or listed as an explicit
LLM fallback. **Speech-to-text has one provider per organization and no fallback**: `setOrgConfig` rejects STT
fallback lists, and STT fallbacks already on a stored row are ignored at resolve time with a warning. A candidate is skipped (and the reason recorded) if:

- it is unknown, of the wrong kind, or missing the capability;
- it is disabled or its credential is missing;
- approval is required and it is not approved. The system or env primary and enabled local providers (when chosen as
  above, never added automatically) are implicitly approved. Anything else must appear in `approvedProviders`;
- it is **paid while the primary is free**, unless `AI_ALLOW_PAID_FALLBACK=true` AND the org did not opt out AND it is an
  explicitly configured fallback. Paid providers are never added implicitly.

## Execution (`AIExecutor.run`)

For each candidate: check the quota and org budget → `withTimeout` → bounded `withRetry` → record usage. The result
carries `{provider, model, promptVersion, usage{tokens|audioSeconds, estimatedCostUsd}, transcriptRevision, idempotencyKey, cached}`.
If every candidate fails, the status is:

- `waiting`: every attempt hit a quota or rate limit (or quota blocked all of them)
- `retryable`: a transient error (timeout, 5xx, model error)
- `failed`: nothing usable (missing credentials, not approved, unsupported)

The notify hook fires, and the original `request` comes back so the caller can persist and re-queue it (no data loss).

## Idempotency

The key is `organizationId:feature:idempotencyKey`. A stored success is returned with `cached: true`, and concurrent
duplicates share one in-flight promise. Only successes are stored.

## Job payload fallbacks

- **AI jobs:** when an `AiJobPayload` has no `fallback`, the request override carries `fallbacks: undefined`, so the
  org and feature fallbacks still apply. An explicit `fallback.fallbackRouteIds` (even `[]`) replaces them.
- **Transcription jobs:** a `TranscriptionJobPayload.fallback` holds LLM route ids, so it is ignored and only org and
  feature STT fallbacks apply. This stays a TODO until contracts define an STT fallback type.

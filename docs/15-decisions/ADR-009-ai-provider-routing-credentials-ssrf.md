# ADR-009: AI provider registry, model routing and fallback, credential refs and SSRF guard

- Status: Proposed
- Date: 2026-10-24
- Owner: Architecture Agent (ARCH), with the AI and Security (SEC) Agents
- Revised: 2026-11-03 (no automatic STT fallback, Deepgram disabled, pre-GA gaps, local origins). Acceptance is
  Akash's decision.
- Implementation: `packages/ai-core` on `integration/phase-1`
- Related: [ADR-002](./ADR-002-provider-interfaces.md), [ADR-003](./ADR-003-contracts-ownership.md),
  [AI docs](../06-ai/README.md) (`docs/09-ai` is only a redirect to `docs/06-ai`)

## Context

ADR-002 makes AI providers swappable. `packages/ai-core` must pick a provider and model per organization and feature,
fall back safely without surprise costs, use per-organization credentials without leaking them across organizations,
and call only safe outbound endpoints.

## Decision

1. **Registry** (`src/registry.ts`, `ProviderRegistry`): a platform-level set of provider configs. `register` needs a
   system context and an awaited audit event (the change is aborted if audit fails). `instantiate` builds an adapter
   per call with the credential resolved for that organization; there are no global key-bound clients.
2. **Routing** (`src/router.ts`, `ModelRouter.resolve`). Precedence, lowest to highest: system default
   (`gemini`/`gemini-2.5-flash-lite` for LLM, `assemblyai` for STT) < env (`AI_LLM_PROVIDER`, `AI_STT_PROVIDER` and the
   model vars) < organization default < feature override < per-request override. The highest layer naming a provider
   wins. A request override needs an actor in the same organization with the `override AIRoute` ability, and it is
   audited. `setOrgConfig` needs `manage ProviderConfig` in the same organization and is audited.
3. **Fallback** (`src/executor.ts`): candidates are the primary, then the route's explicit `fallbacks` (max 5), then
   enabled local providers with the capability, by `fallbackPriority`. A candidate is skipped if it is unapproved while
   `AI_REQUIRE_PROVIDER_APPROVAL=true` (default), or if it would go free → paid, unless `AI_ALLOW_PAID_FALLBACK=true`,
   the organization allows it, and it is an explicit fallback. Quota and `monthlyBudgetUsd` are checked before each
   call. The outcome is `succeeded`, `waiting` (all quota/rate-limited), `retryable` or `failed`.
   **Speech-to-text has no automatic fallback.** A transcription job runs on exactly one STT provider: the resolved
   primary. A provider failure is retried on the same provider (queue backoff), then the job is dead-lettered and the
   meeting is marked delayed; it never moves to another STT provider. `faster-whisper` (self-hosted) is used only when an
   organization (or a self-hosted deployment) explicitly chooses it as its primary STT provider. The implicit
   local-provider fallback above applies to LLM routes only.
4. **Credential refs** (`src/credential-ref.ts`, `src/credentials.ts`):
   - `env:NAME` (`^[A-Z0-9_]+$`) is a platform key, resolved only if the organization's server-side plan grants
     `platformKeys`.
   - `secret:org/<organizationId>/<name>...` is a BYO key. Every segment must match `^[A-Za-z0-9_-]+$`, with no
     decoding, so `..`, `%2e`, empty segments and backslashes are rejected. The owner segment must exactly equal the
     calling `organizationId`, checked in `setOrgConfig` and again at resolve time.
   - Any other ref is rejected. A failing BYO ref never falls back to the platform key.
5. **SSRF guard** (`src/security/ssrf.ts`, `src/adapters/http.ts`): `assertSafeEndpoint` requires https, an exact
   host allowlist (`DEFAULT_ALLOWED_HOSTS`), no URL credentials, and that every resolved address is public. It blocks
   private, loopback, link-local, CGNAT, multicast, reserved, documentation, NAT64, 6to4, Teredo, IPv4-mapped and AWS
   IMDS ranges. `guardedFetch` pins the TCP connection to the validated IP (DNS-rebinding defence) and never follows
   redirects. The only exception is exact `allowedLocalOrigins` for enabled self-hosted providers (`OLLAMA_BASE_URL`,
   `LOCAL_STT_URL`), which may use http and private addresses. `allowedLocalOrigins` is for **development and
   self-hosted deployments only**: in the multi-tenant production deployment (`NODE_ENV=production`) it must be empty,
   so no tenant traffic can reach a private address. This is enforced today: `endpointPolicyFromEnv`
   (`src/bootstrap.ts`) refuses to start when `OLLAMA_ENABLED` or `LOCAL_STT_ENABLED` is set in production. A
   self-hosted production install therefore needs an explicit, documented opt-in before local providers can run there;
   until that exists, faster-whisper is a dev and self-host option only.
6. **Deepgram** is removed from routing. `DeepgramProvider` stays a disabled stub that always fails with
   `PROVIDER_DISABLED` (non-retryable) and reports unhealthy; it must not be selected as a primary, and there is no
   fallback that could reach it.

## Consequences

- Key env vars, named only: `GEMINI_API_KEY`, `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, plus the
  `*_ENABLED`, `*_MODEL` and `*_URL` toggles.
- `DEEPGRAM_API_KEY` / `DEEPGRAM_ENABLED` are inert while Deepgram is disabled.
- An STT provider outage delays transcription (retry, then dead-letter and a "transcription delayed" status) instead
  of silently switching providers or spending on a second provider.
- The secret-manager backing `SecretSource.secret` is supplied by the host app and not defined here (ADR-016).

### Required before GA

1. **Durable org AI config.** `InMemoryOrgConfigStore` is the only `OrgConfigStore`, and the transcription worker uses
   it (`apps/worker/src/ai/bootstrap.ts`, `new ModelRouter(env, new InMemoryOrgConfigStore(), auditSink)`), so org
   routes, approvals, budgets and credential refs are lost on restart and not shared between processes. Replace it with
   a durable Postgres store scoped by `organizationId` under forced RLS (ADR-010), used by both API and worker.
2. **Self-host opt-in.** Keep the production refusal for the hosted service. If self-hosted production installs are
   supported, add an explicit opt-in (not `NODE_ENV` alone) with its own tests and docs.

# ADR-009: AI provider registry, model routing and fallback, credential refs and SSRF guard

- Status: Proposed
- Date: 2026-10-24
- Owner: Architecture Agent (ARCH), with the AI and Security (SEC) Agents
- Implementing PR: #21 (`feat(ai-core): provider registry, model router, fallback policy, SSRF guard and adapters
(P1-AI)`), **open and unmerged**, verified at head `57f6b8723d729d371e5912d34f0b61bb59fee836`
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
   `LOCAL_STT_URL`), which may use http and private addresses.

## Consequences

- Key env vars, named only: `GEMINI_API_KEY`, `ASSEMBLYAI_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, plus the
  `*_ENABLED`, `*_MODEL` and `*_URL` toggles.
- Open: `InMemoryOrgConfigStore` is the only `OrgConfigStore`; the backend must supply a durable, organization-scoped
  store. The secret-manager backing `SecretSource.secret` is supplied by the host app and not defined here. The
  Deepgram adapter is a stub, reported unavailable.

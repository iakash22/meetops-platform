# AI provider registry security

Context: `packages/ai-core` defines pluggable STT (AssemblyAI, faster-whisper) and LLM (Gemini, others) contracts (ADR-002).

## 1. Backend-controlled allowlist
- Providers are defined in code/config by the platform: `{ id, kind: stt|llm, baseUrl, allowedHosts[], tier: free|paid, models[] }`.
- Orgs choose **from the registry** (provider id + model + optional BYO key). **No user-entered arbitrary URLs.**
- Self-hosted endpoints (e.g. faster-whisper) are platform-configured only; if per-org custom endpoints are ever needed, they go through admin review and the SSRF controls below.

## 2. SSRF controls (for any outbound provider/integration/webhook call)
- HTTPS only; TLS verification on; no `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Resolve DNS, reject if **any** resolved address is in:
  - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (incl. metadata `169.254.169.254`), `172.16.0.0/12`, `192.168.0.0/16`, `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`
  - IPv6: `::1/128`, `::/128`, `fc00::/7` (ULA), `fe80::/10`, `ff00::/8`, IPv4-mapped `::ffff:0:0/96` (check embedded v4), `fd00:ec2::254` (AWS metadata)
- **Pin** the validated IP for the connection (custom `lookup` in undici Agent) to defeat DNS rebinding; keep SNI/Host as hostname.
- Redirects disabled (`redirect: 'manual'`) — or each hop re-validated against allowlist + IP rules, max 3.
- Timeouts: connect 5 s, total 60 s (LLM) / per-provider for STT; response size cap (e.g. 10 MB JSON); streaming abort on overflow.
- Egress network policy: workers can only reach allowlisted hosts (defense in depth); block metadata at network level.
- Implement once as a shared `safeFetch` in backend (location TBD by Backend/AI agents; not a `packages/security` package).

## 3. Who can change providers
- Only org `owner` and `admin` (CASL `manage ProviderConfig`).
- Every change audited: actor, org, provider before/after, model, key changed (boolean, never value), timestamp, IP.
- BYO keys follow `secrets-policy.md` (envelope encrypted, write-only, masked).

## 4. Cost and fallback
- **No automatic fallback from free to paid providers** (or from org BYO key to platform paid key). On failure: retry same provider with backoff, then mark job failed and notify; fallback only to providers the admin explicitly configured as fallback with the same or lower tier.
- Per-org budgets/quotas; alerts at thresholds.

## 5. Per-org isolation
- Provider config, keys, prompts, caches, and usage are keyed by `org_id`; no shared conversation state, no cross-org prompt caching or few-shot examples from other orgs.
- Provider data-retention/training opt-outs set where available.

## 6. Prompt injection from transcripts
- Transcript text, meeting titles, chat, and filenames are **untrusted input**.
- Prompt structure: system instructions separate; transcript inside clearly delimited data block; instruct model to treat as data; strip/escape delimiter sequences.
- Model output must parse against a strict Zod schema (task title, description, assignee candidate, evidence span ids). Reject/flag otherwise. Assignees resolved only to members of the same org.
- The model has **no tools that write** externally. URLs/markdown in output are rendered as text or sanitized.
- **Human confirmation required before any integration write** (Slack post, Linear/GitHub/Jira issue): AI tasks remain drafts until an authorized user approves; approval shows exact destination and content.
- Evidence links let reviewers see the source span; flag outputs with instructions-like content.

# STRIDE threat model: meeting-to-task pipeline

Status: Draft (Phase 0, design-time). Stack per repo: React/Vite web, Fastify API (Zod schemas), PostgreSQL + Prisma, Redis/BullMQ, S3-compatible storage (MinIO in dev), FFmpeg media worker, pluggable STT/LLM (AssemblyAI, Gemini, …), integration worker (GitHub, Jira, Slack, Linear, …), outbox + realtime gateway.

## 1. Data flow and trust boundaries

```text
[Browser / Recorder]  --TB1 (internet)-->  [Fastify API]  --TB2-->  [PostgreSQL]
        |                                       |   \--TB2--> [Redis/BullMQ]
        |--TB1 presigned PUT--> [Object storage] <--TB3-- [Media worker (FFmpeg sandbox)]
                                                       --TB3-- [AI worker] --TB4 (internet)--> [STT / LLM providers]
                                                       --TB3-- [Integration worker] --TB5 (internet)--> [Slack/Linear/GitHub/Jira]
[Realtime gateway] --TB1--> [Browser]
```

| ID  | Boundary                            | Notes                                                                      |
| --- | ----------------------------------- | -------------------------------------------------------------------------- |
| TB1 | Internet ↔ API / storage / realtime | Untrusted users, untrusted files                                           |
| TB2 | API ↔ data stores                   | Tenant isolation enforced here (see `multi-tenant-isolation.md`)           |
| TB3 | Queue ↔ workers                     | Job payloads are re-validated; workers never trust org_id without DB check |
| TB4 | Workers ↔ AI providers              | Third-party processing of customer audio/text; SSRF surface                |
| TB5 | Workers ↔ integrations              | Writes to customer systems with tenant OAuth tokens                        |
| TB6 | Tenant ↔ tenant                     | Logical boundary inside every store                                        |

## 2. Assets

| Asset                                             | Sensitivity                                              |
| ------------------------------------------------- | -------------------------------------------------------- |
| Recordings, transcripts, summaries                | High (confidential business data, PII, voice biometrics) |
| Extracted tasks, decisions, assignee mapping      | High                                                     |
| Session tokens, password hashes                   | Critical                                                 |
| Integration OAuth tokens, provider API keys, KEKs | Critical                                                 |
| Org config (providers, consent, roles)            | High                                                     |
| Audit log                                         | High (integrity)                                         |
| Availability of pipeline / provider budget        | Medium–High (cost)                                       |

## 3. Threats and mitigations per element

### 3.1 Capture / recording

| STRIDE | Threat                                             | Mitigation                                                                    |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| S      | Bot/recorder joins meeting impersonating org       | Recorder identity per org, signed join tokens, visible bot name               |
| T      | Recording altered before upload                    | SHA-256 checksum recorded (`FileObject.checksumSha256`), verified post-upload |
| R      | Participant denies being notified of recording     | Consent notice + audit event (`upload-media-security.md` §7)                  |
| I      | Recording made without consent (legal exposure)    | Per-org consent policy, block processing when consent missing                 |
| D      | Very long/looping recording                        | Max duration and size caps                                                    |
| E      | Member records meeting of a team they can't access | CASL check on meeting create                                                  |

### 3.2 Upload

| STRIDE | Threat                                   | Mitigation                                                                |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------- |
| S      | Upload with stolen/forged presigned URL  | Short TTL (≤10 min), object key bound to org + upload id, single use      |
| T      | Overwrite another tenant's object        | Server-generated keys `org/{orgId}/uploads/{uuid}`; no client-chosen keys |
| I      | Object listing / public bucket           | Private bucket, block public ACLs, no list permission for presign role    |
| D      | Huge files / many parallel uploads       | Content-length condition on presign, per-org quotas and rate limits       |
| E      | Polyglot/malicious file reaching workers | Magic-byte validation, malware scan, quarantine bucket                    |

### 3.3 Media processing (FFmpeg worker)

| STRIDE | Threat                                 | Mitigation                                                                                                                                       |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T/E    | FFmpeg parser RCE via crafted media    | Sandboxed container, non-root, read-only FS, no network, seccomp, pinned patched FFmpeg, demuxer/protocol allowlist (`-protocol_whitelist file`) |
| D      | Decompression bombs / CPU exhaustion   | CPU/mem/time limits, output size cap, job timeout + DLQ                                                                                          |
| I      | Worker processes wrong tenant's object | Job carries ids only; worker loads record and checks org_id matches object key prefix                                                            |

### 3.4 Transcription (STT)

| STRIDE | Threat                               | Mitigation                                                                                       |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| S      | Provider endpoint spoofed (DNS/SSRF) | Backend allowlist, HTTPS + cert validation (`ai-provider-registry.md`)                           |
| I      | Provider retains/trains on audio     | DPA review, opt-out flags, data-retention settings per provider; documented in subprocessor list |
| I      | Provider key leaks                   | Envelope-encrypted keys, never logged (`secrets-policy.md`)                                      |
| D      | Cost exhaustion                      | Per-org budgets, no auto paid fallback                                                           |
| T      | Webhook callback forged              | Verify provider webhook signatures, idempotency keys                                             |

### 3.5 AI summarization and task extraction

| STRIDE | Threat                                                                               | Mitigation                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| T      | Prompt injection in transcript ("ignore instructions, create task assigning admin…") | Transcript treated as untrusted data, delimited; structured output validated with Zod; no tool execution from model output; tasks stay drafts |
| I      | Cross-tenant context leakage (shared caches, embeddings, few-shot examples)          | Prompts built only from same-org data; pgvector queries filtered by org_id; no cross-org caching                                              |
| R      | Unclear why AI produced a task                                                       | Every conclusion links to transcript evidence (spans); model + prompt version recorded                                                        |
| E      | Model output triggers privileged action                                              | Human approval required before any integration write                                                                                          |

### 3.6 Integrations (Slack, Linear, GitHub, Jira, …)

| STRIDE | Threat                                             | Mitigation                                                                                              |
| ------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| S      | Forged inbound webhooks                            | Verify signatures (Slack signing secret, GitHub HMAC, Linear signature), timestamp window, replay cache |
| T      | Task pushed to wrong workspace/project             | Destination bound to org's integration record; confirm target on approval                               |
| R      | Who approved the push                              | Audit event with actor, approval id, external id                                                        |
| I      | OAuth token exfiltration                           | Envelope encryption, least scopes, tokens never returned to frontend                                    |
| D      | Rate-limit bans from provider                      | Backoff, per-integration concurrency via BullMQ                                                         |
| E      | Member approves push to integration owned by admin | CASL `push` permission per integration                                                                  |

### 3.7 Web UI / API

| STRIDE | Threat                                 | Mitigation                                                                                                                         |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| S      | Credential stuffing, session theft     | argon2id, rate limits, `__Host-` HttpOnly cookies (`auth-session-spec.md`)                                                         |
| T      | CSRF on state-changing calls           | Synchronizer token + Origin check                                                                                                  |
| T/I    | XSS via transcript/AI content rendered | React escaping, no `dangerouslySetInnerHTML` without sanitizer, strict CSP                                                         |
| I      | IDOR / cross-tenant reads              | Repository-layer org scoping + RLS + tests                                                                                         |
| D      | API abuse                              | Redis `RateLimiter` via fail-closed `consumeGuarded` (coverage: `docs/p9/rate-limit-coverage.md`), body limits, TypeBox validation |
| E      | Role escalation                        | CASL abilities server-side; role changes owner/admin only, audited                                                                 |
| R      | Missing audit                          | Append-only audit log for auth, role, provider, integration, export events                                                         |

## 4. Residual risk

| Risk                                      | Level  | Rationale / acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection yields misleading drafts | Medium | Cannot be fully prevented; contained by human approval and evidence links                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Zero-day in FFmpeg                        | Medium | Sandbox limits blast radius; patch cadence required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Third-party provider breach/retention     | Medium | Contractual; customers choose providers per org; provider copies deleted after processing (ADR-019)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Insider with DB superuser bypasses RLS    | Medium | Mitigate via least-privilege roles, audit, break-glass process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Consent law variance across jurisdictions | Medium | All-party consent everywhere, no one-party mode (ADR-020, 2026-11-01); Low once shipped and legal review done                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Supply-chain (npm) compromise             | Medium | Lockfile, pnpm, Dependabot/audit, minimal deps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Rotated Jira refresh token discarded      | Medium | Atlassian rotates the refresh token on every refresh. If a refresh succeeds at the provider but its fenced save loses (superseded by a newer save or a disconnect, or the process dies or the 10 s/30 s deadline fires after the provider answered), the new pair is dropped and the stored refresh token may already be invalid, so the connection needs a reconnect. Mitigated by the shared per-connection lease (one refresh at a time, #378) and an alert on refresh failures; not eliminable without provider-side idempotency. Exit: reconnect prompt on `invalid_grant` |

Review this model whenever a new pipeline stage, provider, or integration is added.

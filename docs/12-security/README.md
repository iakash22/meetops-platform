# 09 — Security

Security design docs for MeetOps AI. Status: Draft, Phase 0 (no features implemented yet; these are requirements for implementation).

> Note: This folder replaces the former empty `docs/12-security/` placeholder (moved from `docs/09-security/`).

| Doc                                                            | Purpose                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| [threat-model.md](threat-model.md)                             | STRIDE threat model of the meeting-to-task pipeline        |
| [multi-tenant-isolation.md](multi-tenant-isolation.md)         | org_id scoping, repository layer, Postgres RLS, tests      |
| [auth-session-spec.md](auth-session-spec.md)                   | Passwords, sessions, cookies, CSRF, rate limits            |
| [../p9/rate-limit-coverage.md](../p9/rate-limit-coverage.md)   | Rate-limit coverage of every non-auth route (P9 #9)        |
| [secrets-policy.md](secrets-policy.md)                         | Secret storage, envelope encryption, rotation, scanning    |
| [ai-provider-registry.md](ai-provider-registry.md)             | Provider allowlist, SSRF controls, prompt injection        |
| [upload-media-security.md](upload-media-security.md)           | Upload, media processing, recording consent                |
| [rbac-matrix.md](rbac-matrix.md)                               | CASL role/resource/action matrix                           |
| [pr-security-checklist.md](pr-security-checklist.md)           | Security review checklist for PRs                          |
| [test-cases.md](test-cases.md)                                 | QA security test cases (tenancy, auth abuse, SSRF)         |
| [mfa-test-plan.md](mfa-test-plan.md)                           | ADR-021 MFA/step-up test plan, findings and open questions |
| [assumptions-open-questions.md](assumptions-open-questions.md) | Assumptions and open questions                             |

Report vulnerabilities per the root `SECURITY.md`.

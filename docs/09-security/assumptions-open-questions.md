# Assumptions and open questions

## Assumptions

1. Validation library is **Zod** (README, `packages/config`); TypeBox not in use. If TypeBox is adopted for Fastify schemas, same rules apply.
2. ORM is **Prisma**; RLS uses interactive `$transaction` + `set_config('app.current_org_id', …, true)`.
3. **CASL** (`@casl/ability`) is the authorization library — not yet a dependency.
4. Tenant = organization; users can belong to multiple orgs, one active org per session.
5. Sessions stored in PostgreSQL (or Redis) — opaque tokens, no JWT in browser.
6. Integrations in scope: GitHub, Jira (README), plus Slack and Linear (brief).
7. Phase 0: nothing here is implemented; these are requirements.

## Open questions

1. **Doc location**: `docs/12-security/` already exists and `docs/09-ai/` already uses prefix 09. Should this move to `docs/12-security/`?
2. Secret manager / KMS choice (AWS, GCP, Vault) and hosting cloud.
3. Use a password pepper? Where stored and how rotated?
4. Guest role: needed at launch? Which resources can guests see?
5. Can members push to integrations, or admins only (org setting default)?
6. Session timeouts (30 min idle / 12 h absolute) acceptable for UX? "Remember me"?
7. Malware scanning: self-hosted ClamAV vs cloud provider scanner.
8. Consent model per jurisdiction (one-party vs all-party) — legal review needed.
9. Retention defaults for media, transcripts, embeddings.
10. Are per-org custom/self-hosted AI endpoints ever allowed?
11. MFA/SSO timeline (required for owners/admins?).
12. Session store: Postgres vs Redis.

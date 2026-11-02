# Assumptions and open questions

## Assumptions

1. Validation library is **Zod** (README, `packages/config`); TypeBox not in use. If TypeBox is adopted for Fastify schemas, same rules apply.
2. ORM is **Prisma**; RLS uses interactive `$transaction` + `set_config('app.current_org_id', …, true)`.
3. **CASL** (`@casl/ability` ^6.7.1, a dependency of `apps/api`) is the authorization library. Rules are in `apps/api/src/modules/organizations/domain/abilities.ts` (`defineAbilityFor`) and are enforced for organizations, the directory (employees, teams, projects), media, meetings, meeting insights, tasks and integrations. The web app only mirrors the rules as UI hints.
4. Tenant = organization; users can belong to multiple orgs, one active org per session.
5. Sessions stored in PostgreSQL (or Redis) — opaque tokens, no JWT in browser.
6. Integrations in scope: GitHub, Jira (README), plus Slack and Linear (brief).
7. Phase 0: nothing here is implemented; these are requirements.

## Open questions

Items 2, 3, 7, 8, 9 and 11 were decided by the owner (Maddy) on 2026-11-01 in ADR-016 to ADR-021.

1. ~~**Doc location**~~: resolved — docs live in `docs/12-security/`.
2. ~~Secret manager / KMS choice (AWS, GCP, Vault) and hosting cloud.~~ resolved — AWS KMS + AWS Secrets Manager, ap-south-1 ([ADR-016](../15-decisions/ADR-016-secret-manager-kms.md)).
3. ~~Use a password pepper? Where stored and how rotated?~~ resolved — no pepper at launch; argon2id is sufficient ([ADR-016](../15-decisions/ADR-016-secret-manager-kms.md)).
4. ~~Guest role~~: resolved for now — roles are `owner`, `admin`, `member`, `viewer` per contracts `Role` enum (PR #17). Guest is a possible future role; open: is it needed post-launch, and what can it see?
5. Can members push to integrations, or admins only (org setting default)?
6. Session timeouts (30 min idle / 12 h absolute) acceptable for UX? "Remember me"?
7. ~~Malware scanning: self-hosted ClamAV vs cloud provider scanner.~~ resolved — self-hosted clamd sidecar, fail-closed ([ADR-018](../15-decisions/ADR-018-upload-malware-scanning.md)).
8. ~~Consent model per jurisdiction (one-party vs all-party) — legal review needed.~~ resolved — all-party everywhere, no one-party mode; legal review before GA ([ADR-020](../15-decisions/ADR-020-recording-consent.md)).
9. ~~Retention defaults for media, transcripts, embeddings.~~ resolved — raw media 90 days default (7–365 per org); transcripts until deleted ([ADR-019](../15-decisions/ADR-019-media-retention.md)).
10. Are per-org custom/self-hosted AI endpoints ever allowed?
11. ~~MFA/SSO timeline (required for owners/admins?).~~ resolved — TOTP + passkeys required for owners/admins now; SSO deferred ([ADR-021](../15-decisions/ADR-021-mfa-sso.md)).
12. Session store: Postgres vs Redis.

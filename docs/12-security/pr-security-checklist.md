# PR security review checklist

Copy into PR description for changes touching api, worker, web auth, database, integrations, AI, storage, or infra.

## Secrets

- [ ] No secrets/tokens in code, tests, docs, commit messages, or PR text
- [ ] gitleaks passed (CI) / GitHub push protection clean
- [ ] New env vars added to `.env.example` with placeholder only and to `packages/config` schema

## Tenancy & authz

- [ ] Tenant tables have `org_id` + RLS enabled/forced in the migration
- [ ] Queries go through repositories scoped by `TenantContext.orgId`
- [ ] CASL check on every new route/action; matches `rbac-matrix.md`
- [ ] Cross-tenant tests added (org A cannot access org B → 404)

## Input & output

- [ ] Zod schema for params, query, body, and response (response omits secret fields)
- [ ] No raw SQL without org predicate and review; no string-built shell commands
- [ ] Untrusted content (transcripts, AI output, filenames) rendered escaped/sanitized

## Auth & sessions

- [ ] State-changing routes require CSRF token + Origin check
- [ ] Rate limits on new auth-adjacent or expensive endpoints
- [ ] Responses enumeration-safe

## Outbound calls / AI

- [ ] Outbound HTTP uses `safeFetch` (allowlist, SSRF IP checks, pinning, timeouts, size caps)
- [ ] No auto free→paid provider fallback
- [ ] Integration writes require human approval

## Files & media

- [ ] Upload limits, magic-byte checks, presign scope/TTL per `upload-media-security.md`

## Logging & audit

- [ ] No PII/secrets in logs (Pino redact updated)
- [ ] Security-relevant actions emit audit events

## Dependencies & infra

- [ ] New deps justified, maintained, lockfile updated; `pnpm audit` reviewed
- [ ] Dependabot alerts and the GitHub dependency graph checked for new or changed dependencies; any high or critical alert blocks unless it has an active [risk-exceptions.md](risk-exceptions.md) entry
- [ ] Containers non-root, least privilege; CI workflow `permissions:` minimal

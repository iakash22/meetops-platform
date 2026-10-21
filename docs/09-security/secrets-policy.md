# Secrets policy

## 1. Where secrets live
- **Dev**: `.env` (git-ignored), from `.env.example` with placeholders only. Never real values in `.env.example`.
- **CI**: GitHub Actions encrypted secrets / environments; least-privilege `GITHUB_TOKEN` permissions per workflow.
- **Staging/Prod**: a secret manager (AWS Secrets Manager / GCP Secret Manager / Vault — TBD), injected at runtime; validated by `packages/config` (Zod) at boot, fail fast if missing.
- Platform secrets: DB URL, Redis URL, S3 keys, SMTP app password, session/CSRF HMAC keys, KEK reference, platform AI keys.

## 2. Tenant secrets: envelope encryption
- Tenant integration tokens (Slack, Linear, GitHub, Jira OAuth access/refresh) and BYO provider API keys are stored encrypted:
  - Per-record random 256-bit DEK, AES-256-GCM, unique 96-bit nonce, AAD = `org_id || record_id || purpose`.
  - DEK wrapped by a KEK held in KMS (never in DB/app config); store `ciphertext, nonce, wrapped_dek, kek_id, key_version`.
  - Decrypt only in the worker/API code path that needs it, just-in-time; never cache plaintext in Redis or job payloads.
- AAD binding prevents copying a ciphertext into another org's row.

## 3. Never sent to the frontend
- Secret fields are **write-only**: API accepts them on create/update, returns only `{ configured: true, last4: "…abcd", updatedAt }`.
- Response Zod schemas must not include secret fields; serializer tests assert this.
- Rotating a key = submitting a new value; no "reveal" endpoint.

## 4. Rotation
| Secret | Rotation |
| --- | --- |
| KEK | Annually or on suspicion; KMS versioned keys, lazy re-wrap of DEKs |
| Session/CSRF HMAC keys | Support key ring (current + previous); rotate quarterly |
| DB/Redis/S3/SMTP creds | Quarterly and on staff offboarding |
| OAuth tokens | Refresh per provider; revoke on integration disconnect |
| Leaked secret | Immediate revoke + rotate, then incident review (see runbooks) |

## 5. Never put secrets in
Source code, docs, commit messages, GitHub issues/PRs/comments, Slack/Linear messages, logs, error messages, Sentry events, analytics, queue payloads, AI prompts, screenshots. Share credentials only via the secret manager (see `docs/17-agents/credential-requests.md` process).

## 6. Logging
- Pino `redact` paths: `req.headers.authorization`, `req.headers.cookie`, `*.password`, `*.token`, `*.apiKey`, `*.secret`, `*.accessToken`, `*.refreshToken`.
- Sentry `beforeSend` scrubs same keys.

## 7. Secret scanning
- **gitleaks** in CI on every PR (`gitleaks detect --redact`), and as pre-commit (husky) where feasible.
- Enable GitHub secret scanning + push protection on the repo.
- PR checklist item: "No secrets added; gitleaks passed" (see `pr-security-checklist.md`).

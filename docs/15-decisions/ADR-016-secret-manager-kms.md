# ADR-016: Secret manager and KMS for production

- Status: **Accepted — approved by owner Maddy, 2026-11-01**
- Date: 2026-11-01
- Owner: Architecture (All Rounder Techy), with Tester & Security
- Related: [ADR-002](./ADR-002-provider-interfaces.md) (provider interfaces), [ADR-008](./ADR-008-oauth-pkce-token-encryption.md) (`TokenCipher`, `KeyEncryptionProvider`), `docs/12-security/secrets-policy.md`
- Settles: open questions #2 and #3 in `docs/12-security/assumptions-open-questions.md`

## Context

`secrets-policy.md` names "AWS Secrets Manager / GCP Secret Manager / Vault — TBD" for staging and production and requires the
envelope-encryption KEK to be "held in KMS (never in DB/app config)". ADR-008 defines the `TokenCipher` envelope
(`v1.<keyId>.<wrappedKey>.<iv|ciphertext|tag>`) behind a `KeyEncryptionProvider` interface, but only `LocalKeyProvider`
exists and there is no KMS-backed provider or production secret path. The dev KEK (`INTEGRATIONS_TOKEN_KEK`) is refused
when `NODE_ENV=production`, so integrations have no production key source. Dev compose mounts `/run/secrets/*`, and
`packages/config` does not read `*_FILE` yet.

Options considered (prices checked 2026-11-01): AWS KMS + Secrets Manager (KMS $1/key/month, up to $3 during the first
two rotations, 20k requests free; Secrets Manager $0.40/secret/month + $0.05 per 10k calls); GCP Cloud KMS + Secret
Manager ($0.06 per key version or secret version per month); Infisical or Doppler with the KEK loaded into
`LocalKeyProvider` (cheapest, but the KEK sits in app memory with no KMS wrap, against `secrets-policy.md` §2).

## Decision

1. Production and staging use **AWS KMS** for the KEK and **AWS Secrets Manager** for platform secrets, in
   **ap-south-1 (Mumbai)**. Estimated cost about US$10/month.
2. One symmetric customer-managed KMS key per environment is the KEK, with automatic yearly rotation.
3. A new `KmsKeyProvider` implements ADR-008's `KeyEncryptionProvider`: KMS `Encrypt`/`Decrypt` wrap and unwrap each
   per-record DEK, and the existing AAD (`org || record || purpose`) is passed as the KMS EncryptionContext. The envelope
   format and `keyId` stay unchanged, so the `TokenCipher` callers do not change.
4. `packages/config` loads secrets at boot from Secrets Manager (and from `*_FILE` paths in dev compose), validates them
   with Zod, and fails fast when one is missing. Secret values are never logged.
5. IAM is least privilege: the API and worker roles get `kms:Encrypt`/`kms:Decrypt` on the one key, and read on their own
   secrets only. CloudTrail is on.
6. If hosting ends up off AWS, use the KMS of that host behind the same interface. Infisical is a stopgap for non-KEK
   secrets only.
7. **No password pepper at launch.** argon2id per `auth-session-spec.md` is sufficient. Revisit if the threat model changes.

## Consequences

- ADR-008's open gaps become tasks: `KmsKeyProvider`, a `token_key_id` column, and a KEK rotation / re-wrap job.
- `INTEGRATIONS_TOKEN_KEK` stays dev/test only; production integrations start once `KmsKeyProvider` ships.
- TOTP secrets (ADR-021) and billing webhook secrets (ADR-017) use this path, so this decision unblocks both.
- The owner creates the AWS account, KMS key and IAM roles. No key material or secret values are committed.
- Migrating clouds later means a re-wrap job (the `keyId` in each envelope makes this incremental).

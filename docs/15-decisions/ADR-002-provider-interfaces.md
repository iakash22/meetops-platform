# ADR-002: Provider-Independent Storage, Email, and AI

Date: 2026-10-20

## Status
Accepted

## Context
Vendors change. We need to switch storage, email, or AI providers without rewriting domain code.

## Decision
- Storage: `packages/storage` exposes a single `StorageService` interface backed by the AWS SDK S3 client. Providers selected via `STORAGE_PROVIDER=minio|r2|s3` and related `STORAGE_*` env vars.
- Email: provider-independent `EmailService` (implementation deferred). Development uses Nodemailer with Gmail SMTP.
- AI: `packages/ai-core` defines contracts for `LLMProvider` and `TranscriptionProvider`. Registry/adapters come later.

## Consequences
- Domain code remains provider-agnostic.
- Implementations can be swapped with configuration changes and adapter modules.
- Testing focuses on contracts; providers are mocked only in tests.

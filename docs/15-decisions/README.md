# Architecture decision records

| ADR                                                        | Title                                                 | Status                                               | Date       |
| ---------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- | ---------- |
| [ADR-001](ADR-001-modular-monolith.md)                     | Stack and Modular Monolith                            | Accepted                                             | 2026-10-20 |
| [ADR-002](ADR-002-provider-interfaces.md)                  | Provider-Independent Storage, Email, and AI           | Accepted                                             | 2026-10-20 |
| [ADR-003](ADR-003-contracts-ownership.md)                  | Ownership and versioning of `@meetops/contracts`      | Accepted; merged into `integration/phase-1` (PR #17) | 2026-10-21 |
| [ADR-004](ADR-004-db-contract-mapping.md)                  | Mapping the database (Prisma) to `@meetops/contracts` | Accepted; merged into `integration/phase-1` (PR #22) | 2026-10-21 |
| [ADR-005](ADR-005-extension-auth.md)                       | Browser extension authentication                      | Accepted, amended (A1: pairing proof, hardening)     | 2026-10-22 |
| [ADR-006](ADR-006-login-lockout-one-time-tokens.md)        | Login lockout and one-time tokens                     | Proposed (PR #53 merged)                             | 2026-10-24 |
| [ADR-007](ADR-007-integrations-retry-webhook-replay.md)    | Integrations retry idempotency and webhook replay     | Proposed (PR #63 merged)                             | 2026-10-24 |
| [ADR-008](ADR-008-oauth-pkce-token-encryption.md)          | OAuth 3LO + PKCE state and token encryption at rest   | Proposed (PR #67 merged)                             | 2026-10-24 |
| [ADR-009](ADR-009-ai-provider-routing-credentials-ssrf.md) | AI provider routing, credential refs and SSRF guard   | Proposed (PR #21 merged)                             | 2026-10-24 |
| [ADR-010](ADR-010-organization-id-tenant-key.md)           | `organizationId` as the canonical tenant key          | Proposed - needs Architecture review                 | 2026-10-24 |

New ADRs use the next number, `ADR-NNN-short-title.md`, with Date, Status, Context, Decision and Consequences sections. Add a row here. ADR-003 makes ARCH the owner of this folder.

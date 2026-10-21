# Architecture decision records

| ADR                                       | Title                                                 | Status                                           | Date       |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ---------- |
| [ADR-001](ADR-001-modular-monolith.md)    | Stack and Modular Monolith                            | Accepted                                         | 2026-10-20 |
| [ADR-002](ADR-002-provider-interfaces.md) | Provider-Independent Storage, Email, and AI           | Accepted                                         | 2026-10-20 |
| [ADR-003](ADR-003-contracts-ownership.md) | Ownership and versioning of `@meetops/contracts`      | Accepted; merged into `integration/phase-1` (PR #17)| 2026-10-21 |
| [ADR-004](ADR-004-db-contract-mapping.md) | Mapping the database (Prisma) to `@meetops/contracts` | Proposed; merged into `integration/phase-1` (PR #22)| 2026-10-21 |

New ADRs use the next number, `ADR-NNN-short-title.md`, with Date, Status, Context, Decision and Consequences sections. Add a row here. ADR-003 and ADR-004 are on `integration/phase-1` and reach `main` with the integration PR (#30). ADR-003 makes ARCH the owner of this folder.

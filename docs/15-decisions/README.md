# Architecture decision records

| ADR                                       | Title                                                 | Status                                           | Date       |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ---------- |
| [ADR-001](ADR-001-modular-monolith.md)    | Stack and Modular Monolith                            | Accepted                                         | 2026-10-20 |
| [ADR-002](ADR-002-provider-interfaces.md) | Provider-Independent Storage, Email, and AI           | Accepted                                         | 2026-10-20 |
| [ADR-003](ADR-003-contracts-ownership.md) | Ownership and versioning of `@meetops/contracts`      | Accepted (in open PR #17, `feat/core-contracts`) | 2026-10-21 |
| [ADR-004](ADR-004-db-contract-mapping.md) | Mapping the database (Prisma) to `@meetops/contracts` | Proposed (in open PR #22, `docs/adr-004`)        | 2026-10-21 |

New ADRs use the next number, `ADR-NNN-short-title.md`, with Date, Status, Context, Decision and Consequences sections. Add a row here. Links to ADR-003 and ADR-004 resolve once their PRs merge. ADR-003 makes ARCH the owner of this folder.

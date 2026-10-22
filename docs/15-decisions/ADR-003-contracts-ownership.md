# ADR-003: Ownership and versioning of `@meetops/contracts`

- Status: Accepted
- Date: 2026-10-21
- Owner: Architecture Agent (ARCH)

## Context

`packages/contracts` defines the shared domain types, API envelopes, pagination types and queue job payloads
(TypeBox schemas plus `Static` TS types). Every app and package depends on it, so uncontrolled edits break many consumers.

## Decision

1. **Ownership.** ARCH owns `packages/contracts`, `docs/02-architecture` and `docs/15-decisions`. Other agents
   (DB, BE, AI, FE, OPS, DOC, SEC, QA, INT, MEDIA, NATIVE) do not commit there directly.
2. **Change proposals.** Other agents open a PR labelled `contracts` that touches only `packages/contracts`
   (plus tests). The PR needs ARCH review and approval before merge. Feature PRs must not change contracts
   as a side effect; split them.
3. **Single source of truth.** Domain types (Organization, User, Membership/Role, Project, Meeting, Recording/
   FileObject, Transcript, Report, Task, ExtractedTask, IntegrationIssue), the API error envelope, pagination,
   and job payloads are imported from `@meetops/contracts`. Redeclaring them elsewhere is rejected in review.
   Prisma models may differ in shape but must map to and from these contracts.
4. **Versioning (semver).** `package.json` version follows semver (currently `0.x`, so a minor bump may break).
   - PATCH: docs, stricter tests, no schema change.
   - MINOR: additive change (new schema, new optional field, new union member _in inputs only_).
   - MAJOR (or minor while `0.x`): removing or renaming a field, making an optional field required, narrowing a
     union, changing a format/pattern, or changing a job payload in a way old workers can't read.
5. **Breaking-change process.** Write it up in the PR description (who is affected, migration steps), get ARCH approval, and bump the version.
   For queue payloads, increment `jobVersion` and keep workers accepting the previous version for one release.
   Consumers update in the same PR or in linked follow-ups before release.
6. **Deprecation.** Mark the symbol with `/** @deprecated <reason>; use X. Removal in vN */`. Keep it for at
   least one minor release, then remove it in a breaking release.
7. **Consumer notification.** Every contracts PR updates `packages/contracts/CHANGELOG.md` and pings the
   affected owners in the PR and on `docs/17-agents/implementation-board.md`. Breaking changes are also logged in
   `docs/17-agents/progress-log.md`.

## Consequences

- Stable cross-agent boundaries; one review step on every shared-type change.
- ARCH can become a bottleneck. Mitigation: small additive PRs are fast-tracked.

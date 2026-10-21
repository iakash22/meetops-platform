# Contracts guide (`@meetops/contracts`)

> **Note:** This page describes **open PR #17** (`feat/core-contracts`), which is not merged yet. Source: head commit `8a189c87e28ab7a81b14d8b94b0ca16990221561`, read via `gh pr view 17` / `gh pr diff 17`. Rules come from ADR-003 in that PR.
>
> This lives in `docs/04-api` rather than `packages/contracts/README.md` because ADR-003 makes ARCH the owner of `packages/contracts`, and other agents don't commit there. ARCH may move it into the package.

## What's in the package

TypeBox schemas (`@sinclair/typebox` `^0.34.0`), each with a matching TypeScript type. Version `0.1.0`.

| Module           | Exports                                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common`         | `Id`, `IsoDateTime`, `Timestamps`                                                                                                                                                                                     |
| `formats`        | `registerContractFormats()` registers the `date-time` and `email` formats with TypeBox's `FormatRegistry`; it runs on import and is idempotent                                                                        |
| `domain/org`     | `Role` (`owner`, `admin`, `member`, `viewer`), `ROLES`, `Organization`, `User`, `Membership`, `Project`                                                                                                               |
| `domain/meeting` | `MeetingSource`, `MeetingStatus`, `Meeting`, `TranscriptSegment`, `Transcript`, `Report`                                                                                                                              |
| `domain/media`   | `FileObject`, `RecordingStatus`, `Recording`                                                                                                                                                                          |
| `domain/task`    | `TaskStatus`, `TaskPriority`, `Task`, `ExtractedTask`, `IntegrationIssue`                                                                                                                                             |
| `api/auth`       | `LoginRequest`, `SignupRequest`, `ForgotPasswordRequest`, `AuthSession`                                                                                                                                               |
| `api/errors`     | `ApiErrorCode`, `ApiErrorEnvelope` (`{ error: { code, message, requestId?, details? } }`)                                                                                                                             |
| `api/pagination` | `CursorPageQuery`, `OffsetPageQuery` (`limit` 1..100, default 25), `CursorPage(item)`, `OffsetPage(item)`, `Paginated` (alias of `CursorPage`)                                                                        |
| `jobs`           | `QUEUE_NAMES` (`transcription`, `ai`, `email`), `SttProviderId`, `LlmProviderId`, `ModelRouteId` (`<provider>:<model>`), `FallbackPolicy`, `TranscriptionJobPayload`, `AiTaskKind`, `AiJobPayload`, `EmailJobPayload` |
| `legacy`         | Phase 0 hand-written types: `EmailMessage`, `StorageObjectMetadata`, `PresignedUrl`                                                                                                                                   |

Job payloads all carry `jobVersion: 1`, `organizationId`, `idempotencyKey` and an optional `requestId`. `FallbackPolicy` defaults to `allowPaidFallback: false` with no fallback routes, so there's no automatic paid fallback.

## Using TypeBox `Static`

Each contract is declared once as a schema, and its TypeScript type is derived from it under the same name:

```ts
import { Type, type Static } from '@sinclair/typebox';

export const Organization = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  slug: Type.String({ pattern: '^[a-z0-9-]{2,64}$' }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Organization = Static<typeof Organization>;
```

Consumers import both the value (for runtime validation, e.g. Fastify schemas or TypeBox `Value.Check`) and the type:

```ts
import { Organization, type ApiErrorEnvelope } from '@meetops/contracts';
```

For generic shapes, the schema is a function and the type is written by hand, e.g. `CursorPage(item)` with `type CursorPage<T> = { items: T[]; nextCursor: string | null }`.

## Adding a contract

Per ADR-003:

1. Only ARCH commits to `packages/contracts` directly. Other agents open a PR **labelled `contracts`** that touches only `packages/contracts` (and its tests), and ARCH must approve it.
2. Don't change contracts as a side effect of a feature PR; split them out.
3. Add the schema and its `Static` type in the matching module (`domain/`, `api/`, `jobs/`), and re-export it through that module's `index.ts`.
4. Add tests in `packages/contracts/test/` (existing: `schemas.test.ts`, `auth.test.ts`, `contracts.test.ts`). `typecheck` also checks the tests via `tsconfig.test.json`.
5. Update `packages/contracts/CHANGELOG.md` and ping affected owners in the PR and on the implementation board.
6. Don't redeclare contract types elsewhere. Prisma models may differ in shape but must map to and from the contracts.

## Versioning

Semver on `package.json` `version` (currently `0.x`, so a minor bump may break).

| Bump                         | When                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH                        | Docs, stricter tests, no schema change                                                                                                       |
| MINOR                        | Additive: new schema, new optional field, new union member in inputs only                                                                    |
| MAJOR (or minor while `0.x`) | Remove or rename a field, make optional required, narrow a union, change a format or pattern, or change a job payload old workers can't read |

Breaking changes need a write-up in the PR (who is affected, migration steps), ARCH approval and a version bump. For queue payloads, increment `jobVersion` and keep workers accepting the previous version for one release. Log breaking changes in `docs/17-agents/progress-log.md`.

Deprecation: mark the symbol `/** @deprecated <reason>; use X. Removal in vN */`, keep it at least one minor release, then remove it in a breaking release.

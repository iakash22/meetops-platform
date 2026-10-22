# @meetops/contracts

The single source of truth for shapes that cross a boundary: HTTP requests and responses, queue job payloads,
realtime events, and shared domain types. Owned by the Architecture Agent. See
[ADR-003](../../docs/15-decisions/ADR-003-contracts-ownership.md) for ownership and versioning, and
[ADR-004](../../docs/15-decisions/ADR-004-db-contract-mapping.md) for how the DB maps to these contracts.

Each contract is a [TypeBox](https://github.com/sinclairzx81/typebox) schema with a `Static` type of the same name:

```ts
import { LoginRequest, type LoginRequest as LoginRequestT } from '@meetops/contracts';
import { Value } from '@sinclair/typebox/value';
Value.Check(LoginRequest, body); // runtime validation (Fastify can use the schema directly)
```

Importing the package registers the `uuid`, `date-time`, `email` and `uri` string formats.

## Layout

| Module      | Contents                                                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`   | Organization, User, Membership/Role, Project, Meeting, MeetingParticipant, Recording, FileObject (internal), PublicFileObject, Transcript, Report and ReportContent, Task, ExtractedTask, IntegrationIssue |
| `api/`      | error envelope, pagination (`CursorPage`/`Paginated`, `OffsetPage`), auth, uploads, chunked recording sessions                                                                                             |
| `jobs/`     | transcription, AI and email queue payloads, provider ids, `ModelRouteId` (e.g. `gemini:gemini-2.5-flash-lite`), `FallbackPolicy`                                                                           |
| `realtime/` | `meeting:status`, `transcription:progress`, `task:update` events and their union                                                                                                                           |

## Entry points

| Import                      | Contents                                                                                                                                                                   | Runtime deps        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `@meetops/contracts`        | TypeBox schemas, `Static` types, constants                                                                                                                                 | `@sinclair/typebox` |
| `@meetops/contracts/types`  | TS types (`export type`) plus plain `as const` constants: `TASK_STATUSES`, `ROLES`, `API_ERROR_CODES`, `EXTENSION_*` (TTLs, scopes, `EXTENSION_AUTH_PATHS`), `REDACT_KEYS` | none                |
| `@meetops/contracts/legacy` | deprecated storage types (removal in 0.4.0)                                                                                                                                | none                |

**Bundled clients (the `apps/extension` in particular) should import from `@meetops/contracts/types`.** The main entry
pulls the TypeBox runtime into the bundle (≈47 kB minified, ≈12 kB gzipped for a constants-only import, measured with
esbuild), while the light entry adds about 150 bytes. Use the main entry where you validate with schemas (API, workers).
The package sets `"sideEffects": false`, and `test/types-entry.test.ts` guards that the light entry never imports TypeBox.

## Rules

- Ids are UUIDs, and timestamps are ISO-8601 strings.
- Request schemas set `additionalProperties: false`.
- Responses never expose storage locations, tokens or Prisma types.
- Cross-tenant access returns `NOT_FOUND`. Error messages are generic and always carry a `requestId`.
- Email jobs carry ids only. The worker resolves recipients and links.
- Changes go through a PR labelled `contracts` with ARCH review, plus a CHANGELOG entry.

## Adding or changing a contract (ADR-003)

1. Open a PR labelled `contracts` that touches only `packages/contracts`. ARCH must approve it. Don't change contracts as a side effect of a feature PR.
2. Add the schema and its `Static` type in the right module, and re-export it from that module's `index.ts`.
3. Add tests in `test/`. `typecheck` also checks the tests, via `tsconfig.test.json`.
4. Update `CHANGELOG.md`, bump the version and ping the affected owners.

## Versioning

| Bump                      | When                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH                     | Docs or tests only, no schema change                                                                                                                                            |
| MINOR                     | Additive changes: a new schema, a new optional field, a new union member in inputs                                                                                              |
| MAJOR (minor while `0.x`) | Removing or renaming a field, making a field required, narrowing a union, changing a format or pattern, or a job payload change that old workers can't read (bump `jobVersion`) |

Deprecate with `/** @deprecated <reason>; use X. Removal in vN */`. Keep the symbol for at least one minor release before removing it.

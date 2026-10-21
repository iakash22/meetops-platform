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

## Rules

- Ids are UUIDs, and timestamps are ISO-8601 strings.
- Request schemas set `additionalProperties: false`.
- Responses never expose storage locations, tokens or Prisma types.
- Cross-tenant access returns `NOT_FOUND`. Error messages are generic and always carry a `requestId`.
- Email jobs carry ids only. The worker resolves recipients and links.
- Changes go through a PR labelled `contracts` with ARCH review, plus a CHANGELOG entry.

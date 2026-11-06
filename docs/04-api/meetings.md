# Meetings routes (`apps/api/src/modules/meetings`)

All routes are under `/orgs/:organizationId/meetings`. Gate order on every route: CSRF/Origin (mutations,
`onRequest`) -> session (401) -> the path org is the session's active org and the caller a member, else 404 (same
body as an unknown org) -> CASL on `Meeting` (403) -> repository. The Prisma repository runs every call in
`withOrganizationContext` (forced RLS on `meetings`) and also filters on `org_id`.

| Method | Path                                        | Roles                | Notes                                                       |
| ------ | ------------------------------------------- | -------------------- | ----------------------------------------------------------- |
| GET    | `/orgs/:organizationId/meetings`            | all                  | Keyset cursor, `limit` 1..100, optional `source`.           |
| POST   | `/orgs/:organizationId/meetings`            | owner, admin, member | Manual create (web "New meeting"). See below.               |
| POST   | `/orgs/:organizationId/meetings/resolve`    | owner, admin, member | Find-or-create for an external call (extension bearer too). |
| GET    | `/orgs/:organizationId/meetings/:meetingId` | all                  | Missing, deleted and other-org ids: same 404.               |

## `POST /orgs/:organizationId/meetings` (#440)

Body (strict, mirrors `MeetingInput` in `apps/web/src/features/meetings/manage-api.ts`; not in `@meetops/contracts` yet):

```json
{ "title": "Weekly sync", "startedAt": "2026-11-05T10:00:00.000Z", "projectId": "<uuid>" }
```

- `title`: 1..300 chars, not blank (trimmed before storing). `startedAt`: optional ISO 8601 date-time.
  `projectId`: optional; must be a live project of the same organization (unknown, deleted or other-org: the same
  `400 VALIDATION_FAILED`).
- Unknown fields (`organizationId`, `source`, `status`, ...) are `400 VALIDATION_FAILED`.
- Response `201` with the contracts `Meeting` DTO: `source: "upload"`, `status: "scheduled"`, `createdById` = caller.
- Rate limited per caller (30/min) and per organization (300/min): `429 RATE_LIMITED` + `retry-after`.
- Audit-logged as `meeting.create` (`targetType: meeting`, metadata `{ source }`), like `resolve`.
- The OpenAPI document (`/docs/json`) is generated from the route schema.

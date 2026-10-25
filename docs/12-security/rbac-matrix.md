# RBAC role matrix (CASL)

Roles are per org membership and match the contracts `Role` enum (`packages/contracts/src/domain/org.ts`): `owner`, `admin`, `member`, `viewer`. Abilities are built server-side per request with `@casl/ability` from `{ userId, organizationId, role }` (ADR-010 names); every rule except `create Organization` is conditioned on `organizationId`. Frontend may use the same rules only to hide UI — never as enforcement.

> Future role: `guest` (external collaborator) is **not** in the contracts and is not supported. If added later, it must be added to the `Role` enum, the DB `MembershipRole` enum, this matrix, and the test cases first.

Legend: C create, R read, U update, D delete, A approve, P push to integration, ✓ all, `own` = only own records, — none.

| Resource                     | Owner  | Admin                | Member                    | Viewer   |
| ---------------------------- | ------ | -------------------- | ------------------------- | -------- |
| Organization settings        | ✓      | R U                  | R                         | R        |
| Billing / plan               | ✓      | R                    | —                         | —        |
| Delete / transfer org        | ✓      | —                    | —                         | —        |
| Members & invites            | ✓      | C R U D (not owners) | R                         | R        |
| Role changes                 | ✓      | assign member/viewer | —                         | —        |
| Meetings                     | ✓      | ✓                    | C R; U D own              | R        |
| Employees (directory)        | ✓      | ✓                    | R                         | R        |
| Teams + team members         | ✓      | ✓                    | R                         | R        |
| Projects                     | ✓      | ✓                    | R                         | R        |
| Recordings / media (uploads) | ✓      | ✓                    | C R; U D own              | R        |
| Recording sessions           | ✓      | ✓                    | C R; U D own              | R        |
| Transcripts                  | ✓      | ✓                    | R U(corrections)          | R        |
| AI summaries / insights      | ✓      | ✓                    | R                         | R        |
| Draft tasks (AI)             | ✓      | ✓ A                  | R U A(own meetings)       | R        |
| Tasks                        | ✓      | ✓                    | C R U; D own              | R        |
| Integration connections      | ✓      | ✓                    | R                         | —        |
| Push to integration          | ✓      | P                    | P (if org setting allows) | —        |
| AI provider config & keys    | ✓      | ✓ (write-only keys)  | —                         | —        |
| Consent / retention settings | ✓      | ✓                    | R                         | R        |
| Audit log                    | R      | R                    | —                         | —        |
| Data export                  | ✓      | ✓                    | —                         | —        |
| Sessions (others)            | revoke | revoke (non-owners)  | own only                  | own only |

Rules:

- Admins cannot modify/remove owners or grant owner; at least one owner must remain.
- Privilege changes rotate affected sessions and are audited.
- Unauthorized access to another org's resource returns 404.
- Example:

```ts
can('read', 'Meeting', { organizationId });
can(['update', 'delete'], 'Meeting', { organizationId, createdById: userId }); // member
```

## CASL subjects: directory and media (G14, BE-2)

`apps/api/src/modules/organizations/domain/abilities.ts` must define exactly these cells. Actions are the CASL `Action` values (`create`, `read`, `update`, `delete`; owner's `manage` expands to all four). Values: **allow**, **own** (allowed only when `createdById = userId`), **deny**.

| Subject            | Action | Owner | Admin | Member | Viewer |
| ------------------ | ------ | ----- | ----- | ------ | ------ |
| `Employee`         | create | allow | allow | deny   | deny   |
| `Employee`         | read   | allow | allow | allow  | allow  |
| `Employee`         | update | allow | allow | deny   | deny   |
| `Employee`         | delete | allow | allow | deny   | deny   |
| `Team`             | create | allow | allow | deny   | deny   |
| `Team`             | read   | allow | allow | allow  | allow  |
| `Team`             | update | allow | allow | deny   | deny   |
| `Team`             | delete | allow | allow | deny   | deny   |
| `Project`          | create | allow | allow | deny   | deny   |
| `Project`          | read   | allow | allow | allow  | allow  |
| `Project`          | update | allow | allow | deny   | deny   |
| `Project`          | delete | allow | allow | deny   | deny   |
| `FileObject`       | create | allow | allow | allow  | deny   |
| `FileObject`       | read   | allow | allow | allow  | allow  |
| `FileObject`       | update | allow | allow | own    | deny   |
| `FileObject`       | delete | allow | allow | own    | deny   |
| `RecordingSession` | create | allow | allow | allow  | deny   |
| `RecordingSession` | read   | allow | allow | allow  | allow  |
| `RecordingSession` | update | allow | allow | own    | deny   |
| `RecordingSession` | delete | allow | allow | own    | deny   |

Mapping to routes and records:

- `Team` covers team members: adding, changing or removing a member is `update` on the team (there is no separate `TeamMember` subject). The employee referenced must be in the same organization (composite FK, XT-38).
- `FileObject` is the upload subject. `POST /orgs/:organizationId/uploads` is `create`; `…/uploads/:id/complete` is `update`; a download URL is `read`. CASL runs before any presign. Build the subject with `createdById = uploadedById`.
- `RecordingSession` init is `create`; chunk URL, complete and abort are `update`; `delete` (discarding a session's chunks) has no route yet. Build the subject with `createdById = createdById`.
- `own` for a member means the record was created by that user; a member acting on another member's upload or session is denied (XT-34..36), and the route answers 404 as for other orgs.
- Uploads and recording sessions also need a consent attestation (upload-media-security §7, UP-16..18). That is a request check, not a CASL cell.

Invariants (checked for every subject above):

- A role in org A never authorizes a subject whose `organizationId` is B, for any action (cross-org always denied).
- An authenticated user with no membership (`role = null`) is denied every action on these subjects.
- `viewer` is read-only on every subject in this table.

BE-2 test derivation (1:1): `apps/api/test/abilities-directory-media.test.ts` has one table-driven case per row × role above (20 rows × 4 roles = 80 assertions) against a same-org subject, with `own` cells asserted twice (own record allowed, other user's record denied). It also asserts, for every subject × action × role, that the same subject in another org is denied, and that `role = null` is denied. Changing a cell here requires changing the test in the same PR, and the reverse.

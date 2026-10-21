# RBAC role matrix (CASL)

Roles are per org membership and match the contracts `Role` enum (`packages/contracts/src/domain/org.ts`): `owner`, `admin`, `member`, `viewer`. Abilities are built server-side per request with `@casl/ability` from `{ userId, orgId, role }`; all conditions include `orgId`. Frontend may use the same rules only to hide UI — never as enforcement.

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
| Recordings / media           | ✓      | ✓                    | C R; D own                | R        |
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
can('read', 'Meeting', { orgId });
can(['update', 'delete'], 'Meeting', { orgId, createdById: userId }); // member
```

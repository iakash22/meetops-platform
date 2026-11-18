# Security test cases (QA)

Setup for all cases: orgs **A** and **B**, each with owner, admin, member, viewer users (contracts `Role` enum) and data in every tenant table. "As A" = authenticated session of an org A user (admin unless stated). `{B.id}` = a real id owned by org B. Expected 404 means the same body as a non-existent id (no existence leak).

## 1. Cross-tenant access matrix

| ID    | Resource / action                                  | Steps (as A)                                                                                                                                                                   | Expected                                                                                                                                              |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| XT-01 | Meeting read                                       | `GET /meetings/{B.meetingId}`                                                                                                                                                  | 404                                                                                                                                                   |
| XT-02 | Meeting update                                     | `PATCH /meetings/{B.meetingId}`                                                                                                                                                | 404; B row unchanged                                                                                                                                  |
| XT-03 | Meeting delete                                     | `DELETE /meetings/{B.meetingId}`                                                                                                                                               | 404; B row still exists                                                                                                                               |
| XT-04 | Meeting list                                       | `GET /meetings?organizationId={B.organizationId}` (and `?orgId=`)                                                                                                              | 200 with only A rows; `orgId` param ignored                                                                                                           |
| XT-05 | Transcript read                                    | `GET /meetings/{B.meetingId}/transcript`                                                                                                                                       | 404                                                                                                                                                   |
| XT-06 | Transcript edit                                    | `PATCH /transcripts/{B.transcriptId}`                                                                                                                                          | 404                                                                                                                                                   |
| XT-07 | Summary / insights read                            | `GET /meetings/{B.meetingId}/summary`                                                                                                                                          | 404                                                                                                                                                   |
| XT-08 | Task read                                          | `GET /tasks/{B.taskId}`                                                                                                                                                        | 404                                                                                                                                                   |
| XT-09 | Task update/approve                                | `PATCH /tasks/{B.taskId}`, `POST /tasks/{B.taskId}/approve`                                                                                                                    | 404; no state change                                                                                                                                  |
| XT-10 | Task create referencing B parent                   | `POST /tasks` with `meetingId={B.meetingId}`                                                                                                                                   | 404 or 422; no row created                                                                                                                            |
| XT-11 | Task list                                          | `GET /tasks`                                                                                                                                                                   | Only A tasks                                                                                                                                          |
| XT-12 | Assignee injection                                 | Approve A task with `assigneeId={B.userId}`                                                                                                                                    | 422; assignee must be A member                                                                                                                        |
| XT-13 | Full-text search                                   | `GET /search?q=<unique B term>`                                                                                                                                                | 0 results                                                                                                                                             |
| XT-14 | Vector search                                      | Semantic query equal to a B chunk's text                                                                                                                                       | No B chunks returned                                                                                                                                  |
| XT-15 | File presign download                              | `POST /files/{B.fileId}/download-url`                                                                                                                                          | 404; no URL issued                                                                                                                                    |
| XT-16 | File presign upload key                            | `POST /orgs/{A.organizationId}/uploads` with body key `organizations/{B.organizationId}/x` (or legacy `org/{B.organizationId}/x`)                                              | 400 `VALIDATION_FAILED` or key ignored; server key under `organizations/{A.organizationId}/`                                                          |
| XT-17 | Upload complete                                    | `POST /uploads/{B.uploadId}/complete`                                                                                                                                          | 404                                                                                                                                                   |
| XT-18 | Integration connection read                        | `GET /integrations/{B.integrationId}`                                                                                                                                          | 404                                                                                                                                                   |
| XT-19 | Push to B integration                              | `POST /tasks/{A.taskId}/push` with `integrationId={B.integrationId}`                                                                                                           | 404; nothing sent externally                                                                                                                          |
| XT-20 | Provider config                                    | `GET/PUT /ai/providers/{B.configId}`                                                                                                                                           | 404                                                                                                                                                   |
| XT-21 | Members / invites                                  | `GET /orgs/{B.organizationId}/members`, `POST /orgs/{B.organizationId}/invites`                                                                                                | 404                                                                                                                                                   |
| XT-22 | Audit log                                          | `GET /audit?organizationId={B.organizationId}`                                                                                                                                 | Only A events                                                                                                                                         |
| XT-23 | Realtime                                           | Join room `organizations:{B.organizationId}` / `meeting:join` a B meeting                                                                                                      | Rejected (same ack as a missing meeting); no events                                                                                                   |
| XT-24 | Worker job mismatch                                | Enqueue job `{organizationId: A, meetingId: B.meetingId}`                                                                                                                      | Job fails closed, no processing, audit/log entry                                                                                                      |
| XT-25 | Worker object prefix                               | Media job for A whose key points at `organizations/{B.organizationId}/…` (or legacy `org/{B.organizationId}/…`)                                                                | Rejected by `assertKeyOwnedBy`                                                                                                                        |
| XT-26 | RLS no context                                     | As `meetops_app`, `SELECT * FROM tasks` without `app.current_organization_id` (and without the legacy `app.current_org_id`)                                                    | 0 rows                                                                                                                                                |
| XT-27 | RLS wrong org write                                | Context A, `INSERT … org_id = B`                                                                                                                                               | Fails `WITH CHECK`                                                                                                                                    |
| XT-28 | RLS connection reuse                               | Txn with context A, then new txn on same connection without setting                                                                                                            | 0 rows                                                                                                                                                |
| XT-29 | RLS coverage                                       | Query `pg_class`/`pg_policies` for all tables with `org_id`                                                                                                                    | All have RLS enabled + forced + policy                                                                                                                |
| XT-30 | Org switch                                         | Member of A only sends `X-Org-Id: B` / switch-org to B                                                                                                                         | 404/403; context stays A. Realtime side: XT-41, XT-42                                                                                                 |
| XT-31 | Recording session chunk URL (other org)            | `POST /recording-sessions/{B.sessionId}/chunks` `{seq:0,sizeBytes:1024}`                                                                                                       | 404; no URL issued                                                                                                                                    |
| XT-32 | Recording session complete (other org)             | `POST /recording-sessions/{B.sessionId}/complete`                                                                                                                              | 404; B session state unchanged                                                                                                                        |
| XT-33 | Recording session abort (other org)                | `POST /recording-sessions/{B.sessionId}/abort` `{reason:"user_stopped"}`                                                                                                       | 404; B session not aborted                                                                                                                            |
| XT-34 | Recording session chunk URL (same org, other user) | User A2 (same org) requests a chunk URL for A1's sessionId                                                                                                                     | 404; no URL issued                                                                                                                                    |
| XT-35 | Recording session complete (same org, other user)  | User A2 completes A1's session                                                                                                                                                 | 404; session state unchanged                                                                                                                          |
| XT-36 | Recording session abort (same org, other user)     | User A2 aborts A1's session                                                                                                                                                    | 404; session not aborted                                                                                                                              |
| XT-37 | Employee read/update/delete                        | `GET`/`PATCH`/`DELETE /orgs/{A.organizationId}/employees/{B.employeeId}`                                                                                                       | 404; B row unchanged                                                                                                                                  |
| XT-38 | Team and team members (other org)                  | `GET /orgs/{A.organizationId}/teams/{B.teamId}`; `POST …/teams/{A.teamId}/members` with `employeeId = B.employeeId`                                                            | 404; no `team_members` row                                                                                                                            |
| XT-39 | Project (other org)                                | `GET`/`PATCH /orgs/{A.organizationId}/projects/{B.projectId}`; create a project with `teamId = B.teamId`                                                                       | 404; no row created or changed                                                                                                                        |
| XT-40 | Team RLS                                           | As `meetops_app` with context A: select `teams`/`team_members`; insert a `team_members` row with `org_id = B`; insert one with `org_id = A` and B's `team_id` or `employee_id` | Only A rows; `WITH CHECK` fails; composite FK fails                                                                                                   |
| XT-41 | Realtime session revocation                        | Socket open on an A session; logout, logout-all or session revoke                                                                                                              | Disconnected within 1 s via `meetops:auth:revocations` (within `REALTIME_REAUTH_INTERVAL_MS` if Redis is down); no further `organizations:{A}` events |
| XT-42 | Realtime membership change                         | Socket open; the user is removed from A, has their role changed, or switches org                                                                                               | `auth:reauth-required`, then disconnect; no further events for the old org                                                                            |

## 2. Auth abuse cases

| ID    | Case                         | Steps                                                                             | Expected                                                                                                     |
| ----- | ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| AU-01 | Brute force single account   | 6 wrong passwords in 15 min                                                       | Progressive delay; at 10 → temp lock 15 min, notice email; correct password during lock rejected generically |
| AU-02 | Lockout not permanent        | Wait out lock window                                                              | Login works again                                                                                            |
| AU-03 | Credential stuffing          | 25 logins/min from one IP across many emails                                      | 429 after 20/min                                                                                             |
| AU-04 | Distributed stuffing         | Many IPs, one email                                                               | Per-account limit triggers                                                                                   |
| AU-05 | Login enumeration (message)  | Unknown email vs known email wrong password                                       | Identical status + body                                                                                      |
| AU-06 | Login enumeration (timing)   | 100 samples each                                                                  | Median difference < ~10 ms (dummy argon2 verify)                                                             |
| AU-07 | Signup enumeration           | Sign up existing email                                                            | Same response as new; email sent to owner                                                                    |
| AU-08 | Reset enumeration            | Reset unknown vs known email                                                      | Same response and timing                                                                                     |
| AU-09 | Session fixation             | Set a pre-chosen cookie, then log in                                              | New session id issued; old value invalid                                                                     |
| AU-10 | Rotation on privilege change | Admin promotes member; password change; org switch                                | New session id; old invalid; password change revokes other sessions                                          |
| AU-11 | Idle timeout                 | Idle > 30 min                                                                     | 401                                                                                                          |
| AU-12 | Absolute timeout             | Active > 12 h                                                                     | 401                                                                                                          |
| AU-13 | Logout                       | Logout then replay cookie                                                         | 401                                                                                                          |
| AU-14 | CSRF missing token           | POST without `X-CSRF-Token`                                                       | 403                                                                                                          |
| AU-15 | CSRF wrong token             | Token from another session                                                        | 403                                                                                                          |
| AU-16 | Bad Origin                   | Valid token, `Origin: https://evil.example`                                       | 403                                                                                                          |
| AU-17 | Missing Origin/Referer       | State-changing request with neither                                               | 403                                                                                                          |
| AU-18 | GET mutation                 | Try state change via GET                                                          | 404/405, no change                                                                                           |
| AU-19 | Cookie flags                 | Inspect `Set-Cookie` in prod-like env                                             | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`                                |
| AU-20 | Token storage                | Inspect localStorage/sessionStorage                                               | No session tokens                                                                                            |
| AU-21 | Reset token reuse            | Use reset link twice                                                              | Second use rejected                                                                                          |
| AU-22 | Reset token expiry           | Use after 30 min                                                                  | Rejected                                                                                                     |
| AU-23 | Reset revokes sessions       | Reset password                                                                    | All existing sessions invalid                                                                                |
| AU-24 | Invite reuse                 | Accept invite twice                                                               | Second rejected                                                                                              |
| AU-25 | Invite wrong email           | Accept with different account email                                               | Rejected                                                                                                     |
| AU-26 | Invite expiry                | Accept after 7 days                                                               | Rejected                                                                                                     |
| AU-27 | Invite flood                 | > 50 invites/day per org, > 5/day per address                                     | 429                                                                                                          |
| AU-28 | Invite role escalation       | Admin invites with role `owner`                                                   | 403                                                                                                          |
| AU-29 | Member → admin               | Member `PATCH /members/{self}` role=admin                                         | 403                                                                                                          |
| AU-30 | Admin → owner changes        | Admin demotes/removes owner                                                       | 403                                                                                                          |
| AU-31 | Last owner                   | Owner demotes self as last owner                                                  | 422                                                                                                          |
| AU-32 | Viewer writes                | Viewer creates/updates task                                                       | 403                                                                                                          |
| AU-33 | Unknown role rejected        | Send `role: "guest"` (or any value outside the `Role` enum) on invite/role change | 400 validation error; no membership created/changed                                                          |
| AU-34 | Member provider change       | Member `PUT /ai/providers`                                                        | 403; audit no change                                                                                         |
| AU-35 | Mass assignment              | `PATCH /me` with `role`, `organizationId`/`orgId`, `isAdmin`                      | Fields ignored / 400                                                                                         |

## 3. SSRF payloads

Run against every outbound URL input (AI provider config if any URL is accepted, webhook targets, integration base URLs, media import URLs). Expected for all, unless noted: request **rejected before connecting**, 4xx validation error, no outbound connection observed (verify via egress log / canary).

| ID    | Payload                                                                  | Notes                                                                          |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| SS-01 | `https://10.0.0.1/`                                                      | Private 10/8                                                                   |
| SS-02 | `https://172.16.0.1/`, `https://172.31.255.255/`                         | Private 172.16/12                                                              |
| SS-03 | `https://192.168.1.1/`                                                   | Private 192.168/16                                                             |
| SS-04 | `https://100.64.0.1/`                                                    | CGNAT                                                                          |
| SS-05 | `https://127.0.0.1/`, `https://127.1/`, `https://127.255.255.254/`       | Loopback                                                                       |
| SS-06 | `https://2130706433/`                                                    | Decimal 127.0.0.1                                                              |
| SS-07 | `https://0177.0.0.1/`                                                    | Octal                                                                          |
| SS-08 | `https://0x7f.0x0.0x0.0x1/`, `https://0x7f000001/`                       | Hex                                                                            |
| SS-09 | `https://0.0.0.0/`, `https://0/`                                         | Unspecified                                                                    |
| SS-10 | `https://169.254.169.254/latest/meta-data/`                              | Cloud metadata                                                                 |
| SS-11 | `https://metadata.google.internal/`                                      | GCP metadata hostname                                                          |
| SS-12 | `https://[::1]/`                                                         | IPv6 loopback                                                                  |
| SS-13 | `https://[fc00::1]/`, `https://[fd12:3456::1]/`                          | IPv6 ULA                                                                       |
| SS-14 | `https://[fe80::1]/`                                                     | IPv6 link-local                                                                |
| SS-15 | `https://[::ffff:127.0.0.1]/`, `https://[::ffff:7f00:1]/`                | IPv4-mapped                                                                    |
| SS-16 | `https://[fd00:ec2::254]/`                                               | AWS IPv6 metadata                                                              |
| SS-17 | `https://localtest.me/` or a domain with A record 127.0.0.1              | DNS resolves to internal                                                       |
| SS-18 | DNS rebinding domain (TTL 0, first public then 127.0.0.1)                | Connection uses pinned first-validated IP, or rejected; never reaches internal |
| SS-19 | Allowed host returning `302 Location: http://169.254.169.254/`           | Redirect not followed or re-validated and rejected                             |
| SS-20 | Redirect chain > 3 hops                                                  | Rejected                                                                       |
| SS-21 | `http://api.allowed-provider.com/`                                       | Non-HTTPS rejected                                                             |
| SS-22 | `file:///etc/passwd`                                                     | Scheme rejected                                                                |
| SS-23 | `gopher://127.0.0.1:6379/_INFO`                                          | Scheme rejected                                                                |
| SS-24 | `ftp://`, `dict://`, `ldap://`, `data:`                                  | Scheme rejected                                                                |
| SS-25 | `https://allowed.com@evil.example/`                                      | Userinfo rejected; host parsed as evil → rejected                              |
| SS-26 | `https://evil.example#@allowed.com`, `https://allowed.com.evil.example/` | Not on allowlist → rejected                                                    |
| SS-27 | `https://ALLOWED.com./`, punycode lookalike                              | Normalized; only exact allowlisted host passes                                 |
| SS-28 | Allowed host with non-standard port `:6379`                              | Rejected unless port allowlisted                                               |
| SS-29 | Oversized response (> cap, e.g. 50 MB) from test server                  | Aborted at cap; job fails cleanly; memory bounded                              |
| SS-30 | Slow response (slowloris, 1 byte / 10 s)                                 | Aborted at timeout                                                             |
| SS-31 | TLS with invalid/self-signed cert                                        | Rejected                                                                       |
| SS-32 | Arbitrary URL in provider config by admin                                | Rejected — only registry provider ids accepted                                 |

## 4. Recording-session and upload abuse

Routes from contracts `api/recording-sessions.ts` (init, chunks, complete, abort) and `api/uploads.ts`. Limits come from the contracts constants (`MAX_CHUNK_BYTES` = 64 MiB, `MAX_RECORDING_SESSION_BYTES`, `MAX_RECORDING_CHUNKS`, `CHUNK_UPLOAD_URL_TTL_SECONDS` = 300 s); the session byte and chunk caps are pending ARC-2 (G9), so tests read the constants instead of literals. Run as the session owner unless stated.

| ID    | Case                                        | Steps                                                                                                                                          | Expected                                                                                                                    |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| UP-01 | Chunk without size                          | `POST …/chunks` with `{seq:0}` only                                                                                                            | 400 `VALIDATION_FAILED`; no URL issued                                                                                      |
| UP-02 | Chunk over 64 MiB                           | `POST …/chunks` with `sizeBytes: 67108865`                                                                                                     | 400; no URL issued                                                                                                          |
| UP-03 | Body larger than signed Content-Length      | Get URL for `sizeBytes: 1048576`, PUT 2 MiB to it                                                                                              | Storage rejects (403/400 signature mismatch); no object written                                                             |
| UP-04 | Body smaller than signed Content-Length     | Same URL, PUT 512 KiB                                                                                                                          | Rejected or incomplete; complete step later fails (UP-08)                                                                   |
| UP-05 | Running total over the session cap          | Request chunk URLs until the sum of `sizeBytes` would exceed `MAX_RECORDING_SESSION_BYTES` (value per ARC-2)                                   | The exceeding request returns 400/413; no URL issued                                                                        |
| UP-06 | seq out of range                            | `POST …/chunks` with `seq: MAX_RECORDING_CHUNKS` or `-1`                                                                                       | 400                                                                                                                         |
| UP-07 | Complete with gaps                          | Upload seq 0,1,3; complete with `chunkCount: 4`                                                                                                | 400/409; status not `uploaded`; no transcription job enqueued                                                               |
| UP-08 | Complete with wrong sizes                   | A stored chunk's size differs from its signed `sizeBytes` (or exceeds 64 MiB)                                                                  | 400/409; session not completed                                                                                              |
| UP-09 | Complete with mismatched count              | Upload 3 chunks; complete with `chunkCount: 5` (and with `2`)                                                                                  | 400/409 in both cases                                                                                                       |
| UP-10 | Expired chunk URL                           | Obtain URL, wait > `CHUNK_UPLOAD_URL_TTL_SECONDS`, PUT                                                                                         | Storage rejects (expired signature)                                                                                         |
| UP-11 | Chunk after complete/abort                  | Request a chunk URL or PUT after the session completed or was aborted                                                                          | 404/409; no URL issued                                                                                                      |
| UP-12 | Double complete                             | Call complete twice                                                                                                                            | Second returns 409; no duplicate job                                                                                        |
| UP-13 | Extra fields                                | Add `key`, `bucket`, `organizationId` or `userId` to init, chunks, complete or abort bodies                                                    | 400 `VALIDATION_FAILED`                                                                                                     |
| UP-14 | Disallowed MIME on init                     | Init with `mimeType: "video/x-msvideo"` or `audio/webm;foo=bar`                                                                                | 400                                                                                                                         |
| UP-15 | Response leakage                            | Inspect every response from the four routes                                                                                                    | No `bucket`, `key`, `provider` or internal paths; `upload.method` is `PUT` and `expiresAt` ≤ 300 s ahead                    |
| UP-16 | Upload without consent                      | `POST /orgs/{A.organizationId}/uploads` init (and complete) with no consent attestation                                                        | 422; no `FileObject` created (or it stays `pending_upload`); no media job enqueued                                          |
| UP-17 | Recording session without consent           | Recording-session init with no consent attestation                                                                                             | 422; no session created; no chunk URL issued                                                                                |
| UP-18 | Consent attestation spoofing                | Attestation with `attestedByUserId` of another user or `organizationId = B`; then `UPDATE`/`DELETE` on `consent_attestations` as `meetops_app` | 400 `VALIDATION_FAILED` for the extra fields; the stored row names the caller and org A; update/delete denied (append-only) |
| UP-19 | Complete with a key not owned by the caller | The `FileObject` key or the stored object is under `organizations/{B.organizationId}/…` (or legacy `org/…` for a new upload)                   | 400/409 from `assertKeyOwnedBy`; `FileObject` stays `pending_upload`; no media job                                          |

## 5. MFA and step-up (ADR-021)

Planned. MFA is not built yet. The full steps, expected results, sources, priorities (P0/P1/P2), layers and threat-model links are in [`mfa-test-plan.md`](./mfa-test-plan.md); the open questions OQ-1 to OQ-17 are in its §14. The executable suite is `apps/api/test/mfa.security.test.ts`. "Active" cases run and pass on the current code at `6feef782`. "Pending" cases are flagged `TODO(ADR-021)` and are switched on when MFA lands (plan §13). MFA-SEC-05/06 findings are fixed; those tests should be un-skipped.

| ID          | Case                                         | Severity | Status                                         |
| ----------- | -------------------------------------------- | -------- | ---------------------------------------------- |
| MFA-ENR-01  | Secret generation                            | High     | Pending (skipped test)                         |
| MFA-ENR-02  | otpauth URI / QR                             | Medium   | Pending (skipped test)                         |
| MFA-ENR-03  | Uniqueness                                   | High     | Pending (skipped test)                         |
| MFA-ENR-04  | Pending factor is inactive                   | Medium   | Pending (skipped test)                         |
| MFA-ENR-05  | Confirm with a valid code before activation  | High     | Pending (skipped test)                         |
| MFA-ENR-06  | Re-enroll / replace                          | High     | Pending (skipped test)                         |
| MFA-ENR-07  | Factor ownership                             | High     | Pending (skipped test)                         |
| MFA-ENR-08  | Enrollment needs a fresh, verified session   | High     | Pending (`it.todo`)                            |
| MFA-ENR-09  | Owner/admin forced enrollment                | High     | Pending (`it.todo`)                            |
| MFA-TOTP-01 | Login of an MFA user is two-step             | Critical | Pending (skipped test)                         |
| MFA-TOTP-02 | Valid code elevates and rotates              | High     | Pending (skipped test)                         |
| MFA-TOTP-03 | Window / clock skew                          | Medium   | Pending (skipped test)                         |
| MFA-TOTP-04 | Replay of a used code                        | High     | Pending (skipped test)                         |
| MFA-TOTP-05 | Brute force / rate limit / lockout           | Critical | Pending (skipped test)                         |
| MFA-TOTP-06 | Input validation                             | Medium   | Pending (skipped test)                         |
| MFA-TOTP-07 | Timing-safe compare                          | Medium   | Pending (`it.todo`)                            |
| MFA-TOTP-08 | Shared lockout budget                        | High     | Pending (`it.todo`)                            |
| MFA-RC-01   | Generation                                   | High     | Pending (skipped test)                         |
| MFA-RC-02   | Single use                                   | High     | Pending (skipped test)                         |
| MFA-RC-03   | Hashed at rest                               | High     | Pending (`it.todo`)                            |
| MFA-RC-04   | Regenerate invalidates old                   | High     | Pending (skipped test)                         |
| MFA-RC-05   | Never re-displayed                           | Medium   | Pending (skipped test)                         |
| MFA-RC-06   | Use is audited and notified                  | Medium   | Pending (`it.todo`)                            |
| MFA-RC-07   | Rate limited                                 | High     | Pending (`it.todo`)                            |
| MFA-WA-01   | Origin / rpId                                | Critical | Pending (`it.todo`)                            |
| MFA-WA-02   | Challenge                                    | High     | Pending (`it.todo`)                            |
| MFA-WA-03   | Sign count                                   | Medium   | Pending (`it.todo`)                            |
| MFA-WA-04   | User verification                            | Medium   | Pending (`it.todo`)                            |
| MFA-WA-05   | Credential ownership                         | High     | Pending (`it.todo`)                            |
| MFA-WA-06   | Attestation / algorithms                     | Low      | Pending (`it.todo`)                            |
| MFA-WA-07   | Passkey as first factor?                     | Medium   | Pending (`it.todo`)                            |
| MFA-SU-01   | Sensitive routes exist (inventory)           | Info     | Active                                         |
| MFA-SU-02   | Unbuilt sensitive routes (pin)               | Medium   | Active                                         |
| MFA-SU-03   | Enforcement                                  | Critical | Pending (skipped test)                         |
| MFA-SU-04   | Elevation rotates                            | High     | Pending (skipped test)                         |
| MFA-SU-05   | Google sessions                              | High     | Pending (skipped test)                         |
| MFA-SU-06   | Freshness / max age                          | Medium   | Pending (`it.todo`)                            |
| MFA-SU-07   | Downgrade on sensitive change                | High     | Pending (`it.todo`)                            |
| MFA-SU-08   | Bearer clients                               | High     | Pending (`it.todo`)                            |
| MFA-SU-09   | Unknown auth_level values                    | Medium   | Pending (`it.todo`)                            |
| MFA-SES-01  | `auth_level` column and default              | Info     | Active                                         |
| MFA-SES-02  | Nothing elevates today                       | Info     | Active                                         |
| MFA-SES-03  | Password login not elevated                  | High     | Active                                         |
| MFA-SES-04  | Elevation keeps the absolute expiry          | Medium   | Pending (`it.todo`)                            |
| MFA-SES-05  | Reset / disable revokes everything else      | High     | Pending (`it.todo`)                            |
| MFA-SES-06  | Refresh-token families                       | High     | Pending (`it.todo`)                            |
| MFA-SES-07  | Realtime                                     | Medium   | Pending (`it.todo`)                            |
| MFA-DIS-01  | Disable needs step-up                        | Critical | Pending (skipped test)                         |
| MFA-DIS-02  | Required roles can't drop below one factor   | High     | Pending (`it.todo`)                            |
| MFA-DIS-03  | Notification                                 | High     | Pending (skipped test)                         |
| MFA-OIDC-01 | Google session not elevated                  | High     | Active                                         |
| MFA-OIDC-02 | Distinct auth_level for Google (**N-4**)     | Low      | Active                                         |
| MFA-OIDC-03 | Owners/admins via Google still do MFA        | Critical | Pending (`it.todo`)                            |
| MFA-OIDC-04 | `amr`/`acr` not trusted                      | High     | Pending (`it.todo`)                            |
| MFA-OIDC-05 | Pre-hijack (**N-1**) x MFA                   | High     | Pending (`it.todo`)                            |
| MFA-OIDC-06 | Linking is sensitive                         | High     | Pending (`it.todo`)                            |
| MFA-CLI-01  | Desktop (ADR-012)                            | High     | Pending (`it.todo`)                            |
| MFA-CLI-02  | Extension pairing (ADR-005)                  | High     | Pending (`it.todo`)                            |
| MFA-CLI-03  | Mobile                                       | High     | Pending (`it.todo`)                            |
| MFA-AUD-01  | Events                                       | Medium   | Pending (skipped test)                         |
| MFA-AUD-02  | No secrets in audit                          | High     | Pending (skipped test)                         |
| MFA-AUD-03  | Tenancy of events                            | Low      | Pending (`it.todo`)                            |
| MFA-TEN-01  | Owner/admin without MFA                      | Critical | Pending (`it.todo`)                            |
| MFA-TEN-02  | Org "require for everyone"                   | High     | Pending (`it.todo`)                            |
| MFA-TEN-03  | Org switch into an enforcing org             | High     | Pending (`it.todo`)                            |
| MFA-TEN-04  | Policy change                                | High     | Pending (`it.todo`)                            |
| MFA-TEN-05  | Promotion to admin                           | Medium   | Pending (`it.todo`)                            |
| MFA-REC-01  | All factors lost                             | Critical | Pending (`it.todo`)                            |
| MFA-REC-02  | Password reset keeps MFA                     | Critical | Pending (`it.todo`)                            |
| MFA-REC-03  | Admin/support reset of another member        | High     | Pending (`it.todo`)                            |
| MFA-REC-04  | Social engineering                           | High     | Pending (`it.todo`)                            |
| MFA-SEC-01  | TOTP secret encrypted at rest                | High     | Pending (`it.todo`)                            |
| MFA-SEC-02  | Recovery codes hashed                        | High     | Pending (`it.todo`)                            |
| MFA-SEC-03  | `secret` key redacted                        | High     | Active                                         |
| MFA-SEC-04  | otpauth URI in a logged URL                  | High     | Active                                         |
| MFA-SEC-05  | A 6-digit `code` is redacted (**P-1 fixed**) | Medium   | Ready to un-skip (finding fixed at `6feef782`) |
| MFA-SEC-06  | MFA field names redacted (**P-4 fixed**)     | Medium   | Ready to un-skip (finding fixed at `6feef782`) |
| MFA-SEC-07  | Never in errors, metrics or traces           | Medium   | Pending (`it.todo`)                            |
| MFA-CSRF-01 | Step-up routes refuse missing CSRF today     | High     | Active                                         |
| MFA-CSRF-02 | Every MFA POST/DELETE                        | High     | Pending (`it.todo`)                            |
| MFA-CSRF-03 | Enrollment response                          | Medium   | Pending (`it.todo`)                            |
| MFA-ERR-01  | Enrollment state not leaked before password  | Medium   | Pending (`it.todo`)                            |
| MFA-ERR-02  | Generic MFA failure                          | Medium   | Pending (`it.todo`)                            |
| MFA-ERR-03  | Org admins see status, not detail            | Low      | Pending (`it.todo`)                            |
| MFA-TO-01   | Mailbox claim clears attacker factors        | Critical | Pending (new)                                  |
| MFA-TO-02   | Google claim clears attacker factors         | Critical | Pending (new)                                  |
| MFA-TO-03   | Factor deletion is in the claim transaction  | High     | Pending (new)                                  |
| MFA-TO-04   | Verified-account password reset keeps MFA    | Critical | Pending (new)                                  |
| MFA-MIG-01  | Factor tables store no plaintext secrets     | High     | Pending (new)                                  |
| MFA-MIG-02  | Org policy storage and RLS                   | High     | Pending (new)                                  |
| MFA-MIG-03  | `auth_level='mfa'` is a first-class value    | High     | Pending (new)                                  |
| MFA-MIG-04  | Backfill / existing owners and admins        | High     | Pending (new)                                  |
| MFA-MIG-05  | Compatibility and rollback                   | Medium   | Pending (new)                                  |
| MFA-E2E-01  | Member optional enroll, logout, TOTP login   | Critical | Pending (new)                                  |
| MFA-E2E-02  | Owner forced enrollment                      | Critical | Pending (new)                                  |
| MFA-E2E-03  | Recovery code, single use                    | High     | Pending (new)                                  |
| MFA-E2E-04  | Step-up on a role change                     | Critical | Pending (new)                                  |
| MFA-E2E-05  | Disable MFA (optional role)                  | High     | Pending (new)                                  |
| MFA-E2E-06  | Google + MFA                                 | Critical | Pending (new)                                  |
| MFA-E2E-07  | Password reset then MFA                      | Critical | Pending (new)                                  |
| MFA-E2E-08  | WebAuthn happy path                          | High     | Pending (new)                                  |

## 6. AI prompt injection and PII (worker prompts)

Covers the production worker prompts `meeting-summary@1` and `action-items@1` (`apps/worker/src/ai/`). Executable suites: `apps/worker/test/ai-prompt-injection.test.ts` and `apps/worker/test/ai-pii-leak.test.ts` (fixtures in `apps/worker/test/fixtures/ai/`). They drive the real ai-core executor with a scripted provider; no network. "Gap" rows are `it.fails` (asserting the missing control) or `it.todo`.

| ID        | Case                                                                    | Severity | Status              |
| --------- | ----------------------------------------------------------------------- | -------- | ------------------- |
| AI-INJ-01 | One real `TRANSCRIPT_<nonce>` fence; nothing after the closer           | High     | Active              |
| AI-INJ-02 | Newlines in segment text cannot start a new `[n]` line                  | High     | Active              |
| AI-INJ-03 | Forged fence tags (guessed nonce, bare, other nonce, case, spacing)     | High     | Active              |
| AI-INJ-04 | Role spoofing via speaker labels (tags and punctuation stripped)        | Medium   | Active              |
| AI-INJ-05 | Control and bidi characters stripped                                    | Medium   | Active              |
| AI-INJ-06 | System prompt marks the fence as untrusted data                         | Medium   | Active              |
| AI-INJ-07 | Summary JSON with smuggled keys or trailing text is rejected            | High     | Active              |
| AI-INJ-08 | Action items with `status`/`assigneeId` rejected after bounded repair   | High     | Active              |
| AI-INJ-09 | Evidence ids outside the transcript are dropped                         | Medium   | Active              |
| AI-INJ-10 | Obeyed, schema-valid injected task stored as `pending_review` (today)   | High     | Active (current)    |
| AI-INJ-11 | Injected tasks flagged or kept out of drafts                            | High     | Gap (`it.fails`)    |
| AI-INJ-12 | Injected text in the stored report flagged                              | Medium   | Gap (`it.fails`)    |
| AI-INJ-13 | Loose fence look-alikes (`< /TRANSCRIPT_x >`, full-width brackets)      | Low      | Pending (`it.todo`) |
| AI-PII-01 | Logs and `summary:ready` events carry ids and counts only               | High     | Active              |
| AI-PII-02 | Errors (provider, invalid output, validation) carry codes only          | High     | Active              |
| AI-PII-03 | `toPublicError` exposes code, requestId and retryable only              | High     | Active              |
| AI-PII-04 | Outbox payloads (`meeting.summary_ready`, `extracted_tasks.*`) ids only | High     | Active              |
| AI-PII-08 | Emails and phones in segments reach the LLM prompt verbatim (today)     | Medium   | Active (current)    |
| AI-PII-05 | PII redacted before the transcript goes to the LLM                      | Medium   | Pending (`it.todo`) |
| AI-PII-06 | STT `redact_pii` enabled                                                | Medium   | Pending (`it.todo`) |
| AI-PII-07 | Logger redaction covers transcript/summary text keys                    | Medium   | Pending (`it.todo`) |

## 7. Counts

Cross-tenant: 42 · Auth abuse: 35 · SSRF: 32 · Recording-session and upload: 19 · MFA and step-up (planned): 101 (9 active, 2 ready to un-skip after P-1/P-4, 90 pending) · AI prompt injection and PII: 21 (15 active, 2 gaps as `it.fails`, 4 pending) · Total: 250.

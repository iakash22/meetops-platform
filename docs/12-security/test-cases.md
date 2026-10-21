# Security test cases (QA)

Setup for all cases: orgs **A** and **B**, each with owner, admin, member, viewer users (contracts `Role` enum) and data in every tenant table. "As A" = authenticated session of an org A user (admin unless stated). `{B.id}` = a real id owned by org B. Expected 404 means the same body as a non-existent id (no existence leak).

## 1. Cross-tenant access matrix

| ID    | Resource / action                | Steps (as A)                                                         | Expected                                         |
| ----- | -------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| XT-01 | Meeting read                     | `GET /meetings/{B.meetingId}`                                        | 404                                              |
| XT-02 | Meeting update                   | `PATCH /meetings/{B.meetingId}`                                      | 404; B row unchanged                             |
| XT-03 | Meeting delete                   | `DELETE /meetings/{B.meetingId}`                                     | 404; B row still exists                          |
| XT-04 | Meeting list                     | `GET /meetings?orgId={B.orgId}`                                      | 200 with only A rows; `orgId` param ignored      |
| XT-05 | Transcript read                  | `GET /meetings/{B.meetingId}/transcript`                             | 404                                              |
| XT-06 | Transcript edit                  | `PATCH /transcripts/{B.transcriptId}`                                | 404                                              |
| XT-07 | Summary / insights read          | `GET /meetings/{B.meetingId}/summary`                                | 404                                              |
| XT-08 | Task read                        | `GET /tasks/{B.taskId}`                                              | 404                                              |
| XT-09 | Task update/approve              | `PATCH /tasks/{B.taskId}`, `POST /tasks/{B.taskId}/approve`          | 404; no state change                             |
| XT-10 | Task create referencing B parent | `POST /tasks` with `meetingId={B.meetingId}`                         | 404 or 422; no row created                       |
| XT-11 | Task list                        | `GET /tasks`                                                         | Only A tasks                                     |
| XT-12 | Assignee injection               | Approve A task with `assigneeId={B.userId}`                          | 422; assignee must be A member                   |
| XT-13 | Full-text search                 | `GET /search?q=<unique B term>`                                      | 0 results                                        |
| XT-14 | Vector search                    | Semantic query equal to a B chunk's text                             | No B chunks returned                             |
| XT-15 | File presign download            | `POST /files/{B.fileId}/download-url`                                | 404; no URL issued                               |
| XT-16 | File presign upload key          | `POST /uploads` with body key `org/{B.orgId}/x`                      | Key ignored; server key under `org/{A.orgId}/`   |
| XT-17 | Upload complete                  | `POST /uploads/{B.uploadId}/complete`                                | 404                                              |
| XT-18 | Integration connection read      | `GET /integrations/{B.integrationId}`                                | 404                                              |
| XT-19 | Push to B integration            | `POST /tasks/{A.taskId}/push` with `integrationId={B.integrationId}` | 404; nothing sent externally                     |
| XT-20 | Provider config                  | `GET/PUT /ai/providers/{B.configId}`                                 | 404                                              |
| XT-21 | Members / invites                | `GET /orgs/{B.orgId}/members`, `POST /orgs/{B.orgId}/invites`        | 404                                              |
| XT-22 | Audit log                        | `GET /audit?orgId={B.orgId}`                                         | Only A events                                    |
| XT-23 | Realtime                         | Subscribe to channel `org:{B.orgId}` / B meeting                     | Rejected; no events                              |
| XT-24 | Worker job mismatch              | Enqueue job `{orgId: A, meetingId: B.meetingId}`                     | Job fails closed, no processing, audit/log entry |
| XT-25 | Worker object prefix             | Media job for A whose key points at `org/{B.orgId}/…`                | Rejected                                         |
| XT-26 | RLS no context                   | As `meetops_app`, `SELECT * FROM tasks` without `app.current_org_id` | 0 rows                                           |
| XT-27 | RLS wrong org write              | Context A, `INSERT … org_id = B`                                     | Fails `WITH CHECK`                               |
| XT-28 | RLS connection reuse             | Txn with context A, then new txn on same connection without setting  | 0 rows                                           |
| XT-29 | RLS coverage                     | Query `pg_class`/`pg_policies` for all tables with `org_id`          | All have RLS enabled + forced + policy           |
| XT-30 | Org switch                       | Member of A only sends `X-Org-Id: B` / switch-org to B               | 404/403; context stays A                         |

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
| AU-35 | Mass assignment              | `PATCH /me` with `role`, `orgId`, `isAdmin`                                       | Fields ignored / 400                                                                                         |

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

## 4. Counts

Cross-tenant: 30 · Auth abuse: 35 · SSRF: 32 · Total: 97.

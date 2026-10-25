// Generated from docs/12-security/test-cases.md (PR #4; XT-31..36 and UP-01..15 from the
// docs/security-threat-model branch, 2026-10-22; ADR-010 names, XT-37..42 and UP-16..19 from
// docs/security-rbac-directory-media, 2026-10-25). Keep IDs in sync with that doc.
export type SecurityCase = { id: string; title: string; steps: string; expected: string };

export const crossOrganizationCases: readonly SecurityCase[] = [
  { id: 'XT-01', title: 'Meeting read', steps: 'GET /meetings/{B.meetingId}', expected: '404' },
  {
    id: 'XT-02',
    title: 'Meeting update',
    steps: 'PATCH /meetings/{B.meetingId}',
    expected: '404; B row unchanged',
  },
  {
    id: 'XT-03',
    title: 'Meeting delete',
    steps: 'DELETE /meetings/{B.meetingId}',
    expected: '404; B row still exists',
  },
  {
    id: 'XT-04',
    title: 'Meeting list',
    steps: 'GET /meetings?organizationId={B.organizationId} (and ?orgId=)',
    expected: '200 with only A rows; orgId param ignored',
  },
  {
    id: 'XT-05',
    title: 'Transcript read',
    steps: 'GET /meetings/{B.meetingId}/transcript',
    expected: '404',
  },
  {
    id: 'XT-06',
    title: 'Transcript edit',
    steps: 'PATCH /transcripts/{B.transcriptId}',
    expected: '404',
  },
  {
    id: 'XT-07',
    title: 'Summary / insights read',
    steps: 'GET /meetings/{B.meetingId}/summary',
    expected: '404',
  },
  { id: 'XT-08', title: 'Task read', steps: 'GET /tasks/{B.taskId}', expected: '404' },
  {
    id: 'XT-09',
    title: 'Task update/approve',
    steps: 'PATCH /tasks/{B.taskId}, POST /tasks/{B.taskId}/approve',
    expected: '404; no state change',
  },
  {
    id: 'XT-10',
    title: 'Task create referencing B parent',
    steps: 'POST /tasks with meetingId={B.meetingId}',
    expected: '404 or 422; no row created',
  },
  { id: 'XT-11', title: 'Task list', steps: 'GET /tasks', expected: 'Only A tasks' },
  {
    id: 'XT-12',
    title: 'Assignee injection',
    steps: 'Approve A task with assigneeId={B.userId}',
    expected: '422; assignee must be A member',
  },
  {
    id: 'XT-13',
    title: 'Full-text search',
    steps: 'GET /search?q=<unique B term>',
    expected: '0 results',
  },
  {
    id: 'XT-14',
    title: 'Vector search',
    steps: "Semantic query equal to a B chunk's text",
    expected: 'No B chunks returned',
  },
  {
    id: 'XT-15',
    title: 'File presign download',
    steps: 'POST /files/{B.fileId}/download-url',
    expected: '404; no URL issued',
  },
  {
    id: 'XT-16',
    title: 'File presign upload key',
    steps:
      'POST /orgs/{A.organizationId}/uploads with body key organizations/{B.organizationId}/x (or legacy org/{B.organizationId}/x)',
    expected:
      '400 VALIDATION_FAILED or key ignored; server key under organizations/{A.organizationId}/',
  },
  {
    id: 'XT-17',
    title: 'Upload complete',
    steps: 'POST /uploads/{B.uploadId}/complete',
    expected: '404',
  },
  {
    id: 'XT-18',
    title: 'Integration connection read',
    steps: 'GET /integrations/{B.integrationId}',
    expected: '404',
  },
  {
    id: 'XT-19',
    title: 'Push to B integration',
    steps: 'POST /tasks/{A.taskId}/push with integrationId={B.integrationId}',
    expected: '404; nothing sent externally',
  },
  {
    id: 'XT-20',
    title: 'Provider config',
    steps: 'GET/PUT /ai/providers/{B.configId}',
    expected: '404',
  },
  {
    id: 'XT-21',
    title: 'Members / invites',
    steps: 'GET /orgs/{B.organizationId}/members, POST /orgs/{B.organizationId}/invites',
    expected: '404',
  },
  {
    id: 'XT-22',
    title: 'Audit log',
    steps: 'GET /audit?organizationId={B.organizationId}',
    expected: 'Only A events',
  },
  {
    id: 'XT-23',
    title: 'Realtime',
    steps: 'Join room organizations:{B.organizationId} / meeting:join a B meeting',
    expected: 'Rejected (same ack as a missing meeting); no events',
  },
  {
    id: 'XT-24',
    title: 'Worker job mismatch',
    steps: 'Enqueue job {organizationId: A, meetingId: B.meetingId}',
    expected: 'Job fails closed, no processing, audit/log entry',
  },
  {
    id: 'XT-25',
    title: 'Worker object prefix',
    steps:
      'Media job for A whose key points at organizations/{B.organizationId}/… (or legacy org/{B.organizationId}/…)',
    expected: 'Rejected by assertKeyOwnedBy',
  },
  {
    id: 'XT-26',
    title: 'RLS no context',
    steps:
      'As meetops_app, SELECT * FROM tasks without app.current_organization_id (and without the legacy app.current_org_id)',
    expected: '0 rows',
  },
  {
    id: 'XT-27',
    title: 'RLS wrong org write',
    steps: 'Context A, INSERT … org_id = B',
    expected: 'Fails WITH CHECK',
  },
  {
    id: 'XT-28',
    title: 'RLS connection reuse',
    steps: 'Txn with context A, then new txn on same connection without setting',
    expected: '0 rows',
  },
  {
    id: 'XT-29',
    title: 'RLS coverage',
    steps: 'Query pg_class/pg_policies for all tables with org_id',
    expected: 'All have RLS enabled + forced + policy',
  },
  {
    id: 'XT-30',
    title: 'Org switch',
    steps: 'Member of A only sends X-Org-Id: B / switch-org to B',
    expected: '404/403; context stays A. Realtime side: XT-41, XT-42',
  },
  {
    id: 'XT-31',
    title: 'Recording session chunk URL (other org)',
    steps: '`POST /recording-sessions/{B.sessionId}/chunks` `{seq:0,sizeBytes:1024}`',
    expected: '404; no URL issued',
  },
  {
    id: 'XT-32',
    title: 'Recording session complete (other org)',
    steps: '`POST /recording-sessions/{B.sessionId}/complete`',
    expected: '404; B session state unchanged',
  },
  {
    id: 'XT-33',
    title: 'Recording session abort (other org)',
    steps: '`POST /recording-sessions/{B.sessionId}/abort` `{reason:"user_stopped"}`',
    expected: '404; B session not aborted',
  },
  {
    id: 'XT-34',
    title: 'Recording session chunk URL (same org, other user)',
    steps: "User A2 (same org) requests a chunk URL for A1's sessionId",
    expected: '404; no URL issued',
  },
  {
    id: 'XT-35',
    title: 'Recording session complete (same org, other user)',
    steps: "User A2 completes A1's session",
    expected: '404; session state unchanged',
  },
  {
    id: 'XT-36',
    title: 'Recording session abort (same org, other user)',
    steps: "User A2 aborts A1's session",
    expected: '404; session not aborted',
  },
  {
    id: 'XT-37',
    title: 'Employee read/update/delete',
    steps: '`GET`/`PATCH`/`DELETE /orgs/{A.organizationId}/employees/{B.employeeId}`',
    expected: '404; B row unchanged',
  },
  {
    id: 'XT-38',
    title: 'Team and team members (other org)',
    steps:
      '`GET /orgs/{A.organizationId}/teams/{B.teamId}`; `POST …/teams/{A.teamId}/members` with `employeeId = B.employeeId`',
    expected: '404; no `team_members` row',
  },
  {
    id: 'XT-39',
    title: 'Project (other org)',
    steps:
      '`GET`/`PATCH /orgs/{A.organizationId}/projects/{B.projectId}`; create a project with `teamId = B.teamId`',
    expected: '404; no row created or changed',
  },
  {
    id: 'XT-40',
    title: 'Team RLS',
    steps:
      "As `meetops_app` with context A: select `teams`/`team_members`; insert a `team_members` row with `org_id = B`; insert one with `org_id = A` and B's `team_id` or `employee_id`",
    expected: 'Only A rows; `WITH CHECK` fails; composite FK fails',
  },
  {
    id: 'XT-41',
    title: 'Realtime session revocation',
    steps: 'Socket open on an A session; logout, logout-all or session revoke',
    expected:
      'Disconnected within 1 s via `meetops:auth:revocations` (within `REALTIME_REAUTH_INTERVAL_MS` if Redis is down); no further `organizations:{A}` events',
  },
  {
    id: 'XT-42',
    title: 'Realtime membership change',
    steps: 'Socket open; the user is removed from A, has their role changed, or switches org',
    expected: '`auth:reauth-required`, then disconnect; no further events for the old org',
  },
];

export const authAbuseCases: readonly SecurityCase[] = [
  {
    id: 'AU-01',
    title: 'Brute force single account',
    steps: '6 wrong passwords in 15 min',
    expected:
      'Progressive delay; at 10 → temp lock 15 min, notice email; correct password during lock rejected generically',
  },
  {
    id: 'AU-02',
    title: 'Lockout not permanent',
    steps: 'Wait out lock window',
    expected: 'Login works again',
  },
  {
    id: 'AU-03',
    title: 'Credential stuffing',
    steps: '25 logins/min from one IP across many emails',
    expected: '429 after 20/min',
  },
  {
    id: 'AU-04',
    title: 'Distributed stuffing',
    steps: 'Many IPs, one email',
    expected: 'Per-account limit triggers',
  },
  {
    id: 'AU-05',
    title: 'Login enumeration (message)',
    steps: 'Unknown email vs known email wrong password',
    expected: 'Identical status + body',
  },
  {
    id: 'AU-06',
    title: 'Login enumeration (timing)',
    steps: '100 samples each',
    expected: 'Median difference < ~10 ms (dummy argon2 verify)',
  },
  {
    id: 'AU-07',
    title: 'Signup enumeration',
    steps: 'Sign up existing email',
    expected: 'Same response as new; email sent to owner',
  },
  {
    id: 'AU-08',
    title: 'Reset enumeration',
    steps: 'Reset unknown vs known email',
    expected: 'Same response and timing',
  },
  {
    id: 'AU-09',
    title: 'Session fixation',
    steps: 'Set a pre-chosen cookie, then log in',
    expected: 'New session id issued; old value invalid',
  },
  {
    id: 'AU-10',
    title: 'Rotation on privilege change',
    steps: 'Admin promotes member; password change; org switch',
    expected: 'New session id; old invalid; password change revokes other sessions',
  },
  { id: 'AU-11', title: 'Idle timeout', steps: 'Idle > 30 min', expected: '401' },
  { id: 'AU-12', title: 'Absolute timeout', steps: 'Active > 12 h', expected: '401' },
  { id: 'AU-13', title: 'Logout', steps: 'Logout then replay cookie', expected: '401' },
  { id: 'AU-14', title: 'CSRF missing token', steps: 'POST without X-CSRF-Token', expected: '403' },
  { id: 'AU-15', title: 'CSRF wrong token', steps: 'Token from another session', expected: '403' },
  {
    id: 'AU-16',
    title: 'Bad Origin',
    steps: 'Valid token, Origin: https://evil.example',
    expected: '403',
  },
  {
    id: 'AU-17',
    title: 'Missing Origin/Referer',
    steps: 'State-changing request with neither',
    expected: '403',
  },
  {
    id: 'AU-18',
    title: 'GET mutation',
    steps: 'Try state change via GET',
    expected: '404/405, no change',
  },
  {
    id: 'AU-19',
    title: 'Cookie flags',
    steps: 'Inspect Set-Cookie in prod-like env',
    expected: '__Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain',
  },
  {
    id: 'AU-20',
    title: 'Token storage',
    steps: 'Inspect localStorage/sessionStorage',
    expected: 'No session tokens',
  },
  {
    id: 'AU-21',
    title: 'Reset token reuse',
    steps: 'Use reset link twice',
    expected: 'Second use rejected',
  },
  { id: 'AU-22', title: 'Reset token expiry', steps: 'Use after 30 min', expected: 'Rejected' },
  {
    id: 'AU-23',
    title: 'Reset revokes sessions',
    steps: 'Reset password',
    expected: 'All existing sessions invalid',
  },
  { id: 'AU-24', title: 'Invite reuse', steps: 'Accept invite twice', expected: 'Second rejected' },
  {
    id: 'AU-25',
    title: 'Invite wrong email',
    steps: 'Accept with different account email',
    expected: 'Rejected',
  },
  { id: 'AU-26', title: 'Invite expiry', steps: 'Accept after 7 days', expected: 'Rejected' },
  {
    id: 'AU-27',
    title: 'Invite flood',
    steps: '> 50 invites/day per org, > 5/day per address',
    expected: '429',
  },
  {
    id: 'AU-28',
    title: 'Invite role escalation',
    steps: 'Admin invites with role owner',
    expected: '403',
  },
  {
    id: 'AU-29',
    title: 'Member → admin',
    steps: 'Member PATCH /members/{self} role=admin',
    expected: '403',
  },
  {
    id: 'AU-30',
    title: 'Admin → owner changes',
    steps: 'Admin demotes/removes owner',
    expected: '403',
  },
  { id: 'AU-31', title: 'Last owner', steps: 'Owner demotes self as last owner', expected: '422' },
  { id: 'AU-32', title: 'Viewer writes', steps: 'Viewer creates/updates task', expected: '403' },
  { id: 'AU-33', title: 'Guest scope', steps: 'Guest reads unassigned meeting', expected: '404' },
  {
    id: 'AU-34',
    title: 'Member provider change',
    steps: 'Member PUT /ai/providers',
    expected: '403; audit no change',
  },
  {
    id: 'AU-35',
    title: 'Mass assignment',
    steps: 'PATCH /me with role, organizationId/orgId, isAdmin',
    expected: 'Fields ignored / 400',
  },
];

export const uploadCases: readonly SecurityCase[] = [
  {
    id: 'UP-01',
    title: 'Chunk without size',
    steps: '`POST …/chunks` with `{seq:0}` only',
    expected: '400 `VALIDATION_FAILED`; no URL issued',
  },
  {
    id: 'UP-02',
    title: 'Chunk over 64 MiB',
    steps: '`POST …/chunks` with `sizeBytes: 67108865`',
    expected: '400; no URL issued',
  },
  {
    id: 'UP-03',
    title: 'Body larger than signed Content-Length',
    steps: 'Get URL for `sizeBytes: 1048576`, PUT 2 MiB to it',
    expected: 'Storage rejects (403/400 signature mismatch); no object written',
  },
  {
    id: 'UP-04',
    title: 'Body smaller than signed Content-Length',
    steps: 'Same URL, PUT 512 KiB',
    expected: 'Rejected or incomplete; complete step later fails (UP-08)',
  },
  {
    id: 'UP-05',
    title: 'Running total over the session cap',
    steps:
      'Request chunk URLs until the sum of `sizeBytes` would exceed `MAX_RECORDING_SESSION_BYTES` (value per ARC-2)',
    expected: 'The exceeding request returns 400/413; no URL issued',
  },
  {
    id: 'UP-06',
    title: 'seq out of range',
    steps: '`POST …/chunks` with `seq: MAX_RECORDING_CHUNKS` or `-1`',
    expected: '400',
  },
  {
    id: 'UP-07',
    title: 'Complete with gaps',
    steps: 'Upload seq 0,1,3; complete with `chunkCount: 4`',
    expected: '400/409; status not `uploaded`; no transcription job enqueued',
  },
  {
    id: 'UP-08',
    title: 'Complete with wrong sizes',
    steps: "A stored chunk's size differs from its signed `sizeBytes` (or exceeds 64 MiB)",
    expected: '400/409; session not completed',
  },
  {
    id: 'UP-09',
    title: 'Complete with mismatched count',
    steps: 'Upload 3 chunks; complete with `chunkCount: 5` (and with `2`)',
    expected: '400/409 in both cases',
  },
  {
    id: 'UP-10',
    title: 'Expired chunk URL',
    steps: 'Obtain URL, wait > `CHUNK_UPLOAD_URL_TTL_SECONDS`, PUT',
    expected: 'Storage rejects (expired signature)',
  },
  {
    id: 'UP-11',
    title: 'Chunk after complete/abort',
    steps: 'Request a chunk URL or PUT after the session completed or was aborted',
    expected: '404/409; no URL issued',
  },
  {
    id: 'UP-12',
    title: 'Double complete',
    steps: 'Call complete twice',
    expected: 'Second returns 409; no duplicate job',
  },
  {
    id: 'UP-13',
    title: 'Extra fields',
    steps:
      'Add `key`, `bucket`, `organizationId` or `userId` to init, chunks, complete or abort bodies',
    expected: '400 `VALIDATION_FAILED`',
  },
  {
    id: 'UP-14',
    title: 'Disallowed MIME on init',
    steps: 'Init with `mimeType: "video/x-msvideo"` or `audio/webm;foo=bar`',
    expected: '400',
  },
  {
    id: 'UP-15',
    title: 'Response leakage',
    steps: 'Inspect every response from the four routes',
    expected:
      'No `bucket`, `key`, `provider` or internal paths; `upload.method` is `PUT` and `expiresAt` ≤ 300 s ahead',
  },
  {
    id: 'UP-16',
    title: 'Upload without consent',
    steps:
      '`POST /orgs/{A.organizationId}/uploads` init (and complete) with no consent attestation',
    expected: '422; no `FileObject` created (or it stays `pending_upload`); no media job enqueued',
  },
  {
    id: 'UP-17',
    title: 'Recording session without consent',
    steps: 'Recording-session init with no consent attestation',
    expected: '422; no session created; no chunk URL issued',
  },
  {
    id: 'UP-18',
    title: 'Consent attestation spoofing',
    steps:
      'Attestation with `attestedByUserId` of another user or `organizationId = B`; then `UPDATE`/`DELETE` on `consent_attestations` as `meetops_app`',
    expected:
      '400 `VALIDATION_FAILED` for the extra fields; the stored row names the caller and org A; update/delete denied (append-only)',
  },
  {
    id: 'UP-19',
    title: 'Complete with a key not owned by the caller',
    steps:
      'The `FileObject` key or the stored object is under `organizations/{B.organizationId}/…` (or legacy `org/…` for a new upload)',
    expected: '400/409 from `assertKeyOwnedBy`; `FileObject` stays `pending_upload`; no media job',
  },
];

# ADR-023: Account deletion and erasure

- Status: **Proposed — for Project Plan & Coordinator review before any code**
- Date: 2026-11-18
- Owner: Architecture (All Rounder Techy); API and worker by Backend; web by Frontend; mobile, desktop and extension
  by Native; provider deletes by AI; tests by Tester & Security
- Related: [ADR-006](./ADR-006-login-lockout-one-time-tokens.md), [ADR-014](./ADR-014-geoip-session-location.md),
  [ADR-019](./ADR-019-media-retention.md), [ADR-020](./ADR-020-recording-consent.md),
  [ADR-021](./ADR-021-mfa-sso.md), `docs/12-security/multi-tenant-isolation.md`,
  [account-deletion-erasure-brief.md](../research/account-deletion-erasure-brief.md) (Product Research, #508)
- Settles: ADR-020's open item "GDPR erasure (decision for Shubham)", and the ADR-019 purge job's shape
- **Not legal advice.** Retention periods and legal bases below are for counsel to confirm (see Open questions).

## Context

Mobile offers signup (`apps/mobile/app/(auth)/signup.tsx`), so Apple App Review Guideline 5.1.1(v) and Google Play's
User Data policy require in-app account deletion, and Play also requires a web page where people can request deletion
without the app. Today nothing deletes an account: there is no self-delete route, no screen, and no organization delete
route ([brief](../research/account-deletion-erasure-brief.md) S1, S8). The ADR-019 daily purge job is not built either;
the worker only redacts IPs (ADR-014) and purges sessions and AI idempotency rows.

A plain `DELETE FROM users` fails by design. `consent_attestations.attested_by_user_id` and
`meeting_consent_events.actor_user_id` reference `users` with `ON DELETE RESTRICT`, and both tables are append-only for
every role (ADR-020, "Open: GDPR erasure"). The same RESTRICT foreign keys block deleting a meeting that has consent
events and an organization that has consent rows or audit events (brief S2, S4). `users.deleted_at` already locks a user
out: the session verifier (`apps/api/src/modules/auth/application/session-verifier.ts`) and login both check it, so it
can't double as a "deletion requested" flag (brief §4.3).

Provider copies: AssemblyAI keeps a final transcript for 30 days by default unless we call
`DELETE /v2/transcript/{id}`. AI Engineer's #513 (merged into `integration/phase-1` at `1d7ba360`) added the
`ai-provider-transcript-delete` BullMQ job (`apps/worker/src/ai/provider-transcript-delete.ts`). It deletes the
provider copy after ours is stored, with retries, a deterministic job id per provider transcript id, and 404 treated as
success. That replaces the brief's gap S5 / C3 ("the adapter never calls DELETE"). Two limits remain: rows stored before
#513 have no provider id, and a delete that exhausted its retries is only counted in a metric. Gemini is called inline
(`:generateContent`, no Files API), so there is nothing to delete by API; only Google's abuse-monitoring log retention
remains (brief S6, §5).

The legal frame (brief §2.1, interpretation): DPDP Act s. 12(3) makes erasure the default "unless retention ... is
necessary for the specified purpose or for compliance with any law", and s. 8(7) requires erasure, including by the
Data Processor, unless the law requires retention. DPDP Rule 8(3) asks for processing logs to be kept for a year "even if
X deletes her account". GDPR Art. 17(3)(b) and (e) allow keeping data for a legal obligation or legal claims, and
Recital 26 says pseudonymised data is still personal data.

## Decision

The Project Plan & Coordinator's decisions of 2026-11-18 are binding here. Items marked **proposal** are this ADR's
design choices inside them, for review.

1. **Self-serve deletion with re-auth.** A signed-in user requests deletion from `/account` (web) or the mobile account
   tab. The request needs a recent re-auth (password, or a fresh Google sign-in). Once ADR-021 MFA lands, a user with a
   confirmed factor also needs an MFA step-up (`auth_level = mfa`). Proposal: "recent" means within 5 minutes.
2. **Last owner.** If the user is the sole owner of an org that has other live members, the request returns
   **409 `LAST_OWNER`**, listing those orgs, until they transfer ownership or schedule the org for deletion. An org
   scheduled for deletion is **read-only during its grace**. A **solo org** (the user is its only live member) is
   scheduled for deletion together with the account, in the same confirm.
3. **30-day soft-delete grace on a new column.** The request sets the new `users.deletion_requested_at`. It does
   **not** set `deleted_at`. During the grace:
   - signing in shows a **cancel banner**, and an **emailed cancel link** also cancels;
   - proposal: until cancelled, the new session is limited to the deletion status and cancel endpoints and sign-out (the
     same pattern as the OQ-5 enrolment-only session), so a pending account doesn't keep creating data.
     `deleted_at` is set only at the hard delete.
4. **Immediate revocation.** On request, in the same transaction as setting `deletion_requested_at`: revoke every
   session, extension and desktop token family (ADR-005, ADR-012), push device token and outstanding one-time link
   (password reset, email verification). Calendar connections are disconnected through `CalendarService.disconnect`
   (revoke at Google, then wipe); after cancelling, the user reconnects their calendar.
5. **Emails.** A confirmation when the request is made (purge date, cancel link, what is kept and why), a confirmation
   when it's cancelled, and a confirmation when deletion completes (Apple asks for that). Proposal: a reminder about 48
   hours before the purge.
6. **One purge job: the hard delete is the ADR-019 purge job.** The daily worker job built for ADR-019 (expired media,
   soft-deleted rows after 30 days) also runs account and org hard deletes. It runs as the separate audited system role
   (`multi-tenant-isolation.md`), batched and idempotent, and logs counts only. For a user whose grace has ended it:
   - **pseudonymises the `users` row:** keeps `id`, sets `email` to a unique tombstone `deleted+<uuid>@invalid` (the
     column is a full `@unique`; `.invalid` is a reserved TLD that the mailer must refuse), clears `name`,
     `password_hash`, `google_sub` and `email_verified_at`, and sets `deleted_at`;
   - **deletes the user's own rows** (data map below);
   - **removes recordings and transcripts** of data being deleted (solo orgs and orgs whose grace ended, plus ADR-019
     expiry) from object storage, and from providers;
   - **enqueues a provider delete for every remaining provider transcript id** belonging to the deleted data: each
     `transcripts.provider_job_id` and each per-chunk provider id, onto the #513 `ai-provider-transcript-delete` queue,
     before the rows that hold those ids are removed. Because the job id is deterministic and 404 counts as success,
     this is safe to repeat. It sweeps up earlier deletes that failed and any ids still present on older rows. Rows
     stored before ids were persisted have no id to delete; AssemblyAI's default retention (30 days for the final
     transcript) covers those, and the deletion page says so.
7. **Gemini.** No delete call exists or is needed for inline calls. Disclose Google's abuse-monitoring log retention on
   the deletion page and in the sub-processor list. Use paid, billing-enabled projects only, with AI Studio logging off.
8. **Consent and audit records become tombstones, not deletes.** Both are append-only with RESTRICT foreign keys. The
   purge keeps a pseudonymous id and timestamps and removes names, emails and IPs. They are kept only where a legal
   basis exists (DPDP s. 8(7) and s. 12; GDPR Art. 17(3)(b) and (e)), for the period counsel sets.
   - Consent rows already hold only a user uuid, method, version and times. After the `users` row is pseudonymised they
     are pseudonymous. Proposal: the free-text `meeting_consent_events.reason` is nulled for the deleted user's events.
   - Audit events: `ip_address`, `user_agent` and the geo columns are nulled (raw IPs are already nulled at 30 days by
     ADR-014), and names and emails are removed from `metadata`. **`actor_id` is kept for one year after each event,
     then nulled** (the existing append-only hatch already allows an UPDATE that only nulls `actor_id`).
   - ADR-020's alternative, a reviewed maintenance migration that removes consent rows
     (`docs/16-runbooks/meeting-consent-maintenance.md`), stays available for a counsel-directed erasure only. It is not
     the default path.
9. **`integration_connections.connected_by_id` gets a foreign key** to `users(id)` with `ON DELETE SET NULL`, in the
   same migration as `deletion_requested_at` (brief C5).
10. **A public web page** (no sign-in) explains how to request deletion, for Google Play. Its checklist is brief §6.3.
11. **Timing is an open question for counsel, not a decision.** See Open questions (Q29, Q31).

This closes ADR-020's open erasure item: user hard delete is pseudonymise-and-keep-evidence, and the maintenance
migration is the exception.

### Organization deletion (proposal)

Orgs mirror the user design. An owner (with step-up once ADR-021 lands) schedules the org with a new
`organizations.deletion_requested_at`. During its 30-day grace the org is **read-only**: no new recordings, uploads,
captures or invitations; outbound integration sync and webhooks pause; existing data stays readable and exportable;
members are emailed on day 0 and before the purge; owners see a banner with "Cancel deletion". At grace end the purge
job deletes the org's meetings, media, transcripts, reports, tasks and embeddings (storage objects too, and provider
deletes as in Decision 6), revokes integration tokens at the provider where an API exists and deletes
`integration_connections`, removes memberships, keeps a scrubbed meeting stub where consent events exist, and
tombstones the `organizations` row (keep `id`; scrub `name` and `slug`; set `deleted_at`). Members' own accounts are
untouched. A solo org scheduled with its owner's account is cancelled if the account deletion is cancelled.

## Data map

"Grace end" is day 30 after the request, when the daily purge job picks the user up. **Delete** = row removed.
**Tombstone** = row kept with personal data scrubbed. **Keep** = org data that outlives the user.

| Table or data                                                                                                                                                                                   | At request (day 0)                   | At grace end (purge)                                                                                                                                                                  | Basis                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `users`                                                                                                                                                                                         | Set `deletion_requested_at`          | **Tombstone**: keep `id`, `created_at`, `deletion_requested_at`; email to `deleted+<uuid>@invalid`; null `name`, `password_hash`, `google_sub`, `email_verified_at`; set `deleted_at` | Consent and audit FKs are RESTRICT                          |
| `sessions`, `auth_token_families`, `auth_refresh_tokens`, `auth_devices`                                                                                                                        | Revoke                               | **Delete**                                                                                                                                                                            | —                                                           |
| `push_device_tokens`                                                                                                                                                                            | **Delete**                           | —                                                                                                                                                                                     | —                                                           |
| `email_verifications`, `password_resets`, deletion cancel tokens                                                                                                                                | Void outstanding (keep cancel token) | **Delete**                                                                                                                                                                            | —                                                           |
| `mfa_factors`, `mfa_recovery_codes` (ADR-021, #497)                                                                                                                                             | Keep (needed to sign in and cancel)  | **Delete**                                                                                                                                                                            | —                                                           |
| `notifications`, `notification_delivery_attempts`, `notification_preferences`                                                                                                                   | Stop delivery                        | **Delete**                                                                                                                                                                            | —                                                           |
| `calendar_connections`, `calendar_events`, `calendar_event_links`                                                                                                                               | Revoke at Google and wipe            | **Delete** anything left                                                                                                                                                              | —                                                           |
| `memberships`                                                                                                                                                                                   | Keep                                 | **Delete**                                                                                                                                                                            | —                                                           |
| `invitations` addressed to the user's email                                                                                                                                                     | Keep                                 | **Delete**                                                                                                                                                                            | —                                                           |
| Creator and actor links: `organizations.created_by_id`, `invitations.invited_by_id` and `accepted_by_id`, meetings, files, tasks, task approvals, recording sessions, AI config, task sync jobs | Keep                                 | Null the link (what `SET NULL` does on a hard delete); **keep** the org row                                                                                                           | Org data (Q32)                                              |
| `integration_connections.connected_by_id`                                                                                                                                                       | Keep                                 | Null via the new `ON DELETE SET NULL` semantics, applied explicitly since the user row stays                                                                                          | Org data                                                    |
| `meeting_participants.user_id`, `employees.user_id`                                                                                                                                             | Keep                                 | Null the link; the display name and email in that org stay org data                                                                                                                   | Org data (Q32)                                              |
| Meetings, recordings, transcripts, chunks, reports, tasks, embeddings and storage objects in **orgs the user doesn't delete**                                                                   | Keep                                 | **Keep** (org data)                                                                                                                                                                   | Org data (Q32)                                              |
| The same in **solo orgs and orgs whose grace ended**                                                                                                                                            | Org read-only                        | **Delete** rows and storage objects; enqueue provider deletes first; keep a scrubbed meeting stub where consent events exist                                                          | —                                                           |
| AssemblyAI copies (`transcripts.provider_job_id`, per-chunk provider ids)                                                                                                                       | —                                    | Enqueue `ai-provider-transcript-delete` for every remaining id, then delete the rows                                                                                                  | DPDP s. 8(7) (Processor erasure)                            |
| `consent_attestations`, `meeting_consent_events`                                                                                                                                                | Keep                                 | **Tombstone**: rows stay; pseudonymous once `users` is scrubbed; null `reason` on the user's events                                                                                   | DPDP s. 6(10), 8(7), 12(3); GDPR Art. 17(3)(e); counsel Q30 |
| `audit_events`                                                                                                                                                                                  | Write `account.deletion_requested`   | **Tombstone**: null IP, user agent and geo; strip names and emails from `metadata`; null `actor_id` once the event is a year old                                                      | DPDP Rules 6(1)(e), 8(3); counsel Q29                       |
| Outbox and mail jobs carrying the user's email                                                                                                                                                  | Send request mail                    | Completion mail sent from a transient job payload, removed on completion; no stored copy                                                                                              | —                                                           |
| Backups                                                                                                                                                                                         | —                                    | Roll off within 35 days of the purge (ADR-019)                                                                                                                                        | Counsel Q31                                                 |
| Gemini abuse-monitoring logs                                                                                                                                                                    | —                                    | Not ours to delete; disclosed                                                                                                                                                         | Google terms                                                |

## State machine

```text
User:
  active --request (re-auth [+ MFA step-up]; no blocking LAST_OWNER)--> pending_deletion
      day 0: deletion_requested_at = now; revoke sessions and tokens; request email; audit
  pending_deletion --sign-in banner "Cancel" or emailed cancel link--> active
      deletion_requested_at = NULL; cancel email; audit; solo orgs scheduled with it are cancelled
  pending_deletion --purge job, now >= deletion_requested_at + 30 days--> purging
      per-user transaction, idempotent and resumable: provider deletes enqueued, own rows deleted,
      links nulled, tombstones written
  purging --all steps done--> deleted
      deleted_at = now; completion email (address from the transient job payload); audit

Organization:
  active --owner schedules (or solo org with its owner's account)--> pending_deletion (read-only)
  pending_deletion --owner cancels--> active
  pending_deletion --purge job at grace end--> deleted (tombstone)
```

Signup during the grace with the same email gets the usual non-enumerating response; signing in leads to the cancel
banner. After the purge the email is free, so signing up again creates a new, unrelated account.

## API sketch (names are proposals; no code here)

| Method and path              | Auth                                            | Behaviour                                                                                                                                   |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/deletion`           | Session (also the limited pending session)      | `{ status: 'none' \| 'scheduled', requestedAt, purgeAfter, soloOrgs }`                                                                      |
| `POST /me/deletion`          | Session + re-auth (+ MFA step-up after ADR-021) | Schedules. 401 `REAUTH_REQUIRED`; 403 step-up required; 409 `LAST_OWNER` with `{ orgs: [{ id, name, memberCount }] }`; repeat is idempotent |
| `DELETE /me/deletion`        | Session (also the limited pending session)      | Cancels                                                                                                                                     |
| `POST /auth/deletion/cancel` | None; single-use hashed token from the email    | Cancels. Token handling as ADR-006 one-time tokens; uniform error for bad or expired tokens                                                 |
| `POST /orgs/:id/deletion`    | Owner + step-up                                 | Schedules the org; org becomes read-only                                                                                                    |
| `DELETE /orgs/:id/deletion`  | Owner                                           | Cancels the org's deletion                                                                                                                  |
| Web `/delete-account`        | None                                            | Public page (brief §6.3): how to delete on web, iOS and Android, last-owner steps, grace wording, what's kept and why, processors, contact  |

Contracts gain the request and status shapes and the new error codes; `LAST_OWNER` already exists in
`packages/contracts/src/constants.ts`. Native clients treat the 401 after revocation as "deletion scheduled", not a
generic error. Audit actions: `account.deletion_requested`, `account.deletion_cancelled`, `account.deletion_purged`,
`org.deletion_requested`, `org.deletion_cancelled`, `org.deletion_purged`, with no email or name in `metadata`.

## Migration outline (one migration, no code here)

1. `users.deletion_requested_at timestamptz NULL`, with a partial index for the purge scan
   (`WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL`).
2. `organizations.deletion_requested_at timestamptz NULL`, with the same kind of partial index.
3. A small table for deletion cancel tokens (user FK `ON DELETE CASCADE`, unique `token_hash`, `expires_at`,
   `used_at`), following ADR-006.
4. `integration_connections.connected_by_id` → `users(id)` `ON DELETE SET NULL`: first null ids with no matching user,
   then add the constraint `NOT VALID` and `VALIDATE` it in a separate step; index the column.
5. Audit hatch: extend `audit_events_append_only()` to allow an UPDATE that only nulls `ip_address`, `user_agent` and
   the geo columns and rewrites `metadata` to its scrubbed form, alongside the existing `actor_id` rule. Grant
   column-level `UPDATE` for those columns to the purge role only.
6. Consent hatch (proposal): allow an UPDATE on `meeting_consent_events` that only nulls `reason`, for the purge role
   only. Everything else stays append-only.
7. Grants for the purge system role: `SELECT`/`DELETE` on the user-owned tables in the data map, and the column
   `UPDATE`s on `users` and `organizations` needed to write tombstones. RLS and live tests cover each grant.

Per-chunk provider ids live today inside `transcript_chunks.segments` (the stored chunk JSON), while
`transcripts.provider_job_id` holds the anchor's id. The purge reads both. A dedicated chunk column is a follow-up, not
part of this migration.

## Consequences

- Apple 5.1.1(v) and Play's in-app and web requirements can be met; deactivation alone is not offered.
- ADR-020's erasure item is closed; the ADR-019 purge job gets its full scope, one job instead of two.
- ADR-019's "provider copies deleted right after processing" holds for new transcripts once #513's job runs, and the
  purge sweep covers failures and older rows that have ids.
- Pseudonymised `users`, consent and audit rows are still personal data (GDPR Recital 26); keeping them needs the basis
  counsel confirms (Q30, Q33).
- More states to test: pending users and read-only orgs touch auth, every write path that checks org state, and native
  error handling.

## Risks

- **Wrong-data purge.** A bug could delete another org's or user's data. Mitigation: per-user transactions, RLS-scoped
  queries, dry-run counts in staging, counts-only logs, an env kill switch on the purge, and live tests.
- **Account takeover leading to deletion.** Re-auth, MFA step-up (after ADR-021), the request email with a cancel link,
  and the 30-day grace limit the damage.
- **Last-owner friction.** Apple says deletion shouldn't be "unnecessarily difficult"; the solo-org path keeps the
  common case to one confirm.
- **Provider delete failures.** A provider delete can fail for good after retries. The purge sweep re-enqueues every
  remaining id, and the failure metric needs an alert. Rows from before ids were stored rely on AssemblyAI's default
  retention.
- **Audit `metadata` may already hold emails or names** (not audited row by row; brief §9). Scrubbing depends on the
  metadata review follow-up.
- **Timing.** 30 days of grace, plus a daily run, plus 35 days of backups can exceed GDPR's one month (Q31).
- **Rule 8(3)** may require keeping more than processing logs for a year (Q29), which would change the data map.

## Open questions

For counsel (not decisions; numbering as in the brief §8):

- **Q29.** DPDP Rule 8(3)'s one-year retention of "personal data, associated traffic data and other logs of the
  processing": does it cover meeting content, or only records of processing? This ADR assumes the latter, as ADR-019
  does.
- **Q31.** Is a user-chosen 30-day grace, then a daily purge, then 35-day backup roll-off, compatible with GDPR
  Art. 12(3)'s one month? Or must the grace be shorter or optional for EU users?
- **Q30.** How long may pseudonymised consent records be kept after a user or org is deleted, and on what basis?
- **Q32.** Are meetings a member recorded in someone else's org that org's data, or the member's?
- **Q33.** Does a pseudonymised `users` row (uuid only) count as erased under DPDP s. 12(3)?

For the coordinator:

- Is the limited "cancel or sign out" session during the grace acceptable, or should a pending user keep a full
  session with a banner?
- The 48-hour reminder email, and a signed-out request form on the public page that verifies by email link (both
  proposals from brief §4.3 and §6.3).

## Follow-up tickets

1. **DB:** the migration above, plus RLS and live tests (consent rows survive, `SET NULL` works, hatches are narrow).
2. **Contracts:** deletion request and status shapes, error codes, audit actions.
3. **API:** `/me/deletion`, the cancel link, `/orgs/:id/deletion`, day-0 revocation, LAST_OWNER checks, org read-only
   enforcement on every write path.
4. **Auth:** login and session verifier handling of `deletion_requested_at` (password and Google), the limited session.
5. **Worker:** the ADR-019 purge job (media expiry, soft-delete purge, user and org purge, provider-delete sweep onto the
   #513 queue, yearly `actor_id` nulling) with a kill switch.
6. **AI:** a dedicated per-chunk provider id column; an alert on
   `meetops_provider_transcript_delete_failures_total`; confirm Gemini projects are paid with logging off.
7. **Mail:** request, cancel, reminder and completion templates; the mailer refuses `.invalid` addresses.
8. **Web:** delete-account flow under `/account`, the last-owner resolver, org deletion settings, the cancel landing
   page, and the public `/delete-account` page.
9. **Native:** mobile account-tab entry (in-app or a direct link to the web flow) and "deletion scheduled" handling;
   desktop and extension link to the web page; Play Data safety and App Store privacy answers.
10. **Audit:** review `audit_events.metadata` and stop writing emails or names there.
11. **Docs:** point ADR-020's open item and ADR-019's provider-copy line at this ADR (after #472 merges, to avoid a
    conflict in ADR-020); the privacy notice and sub-processor list; a purge runbook; add counsel questions Q29–Q33 to
    `docs/research/legal-questions-brief.md` (brief §8 refers to them there, but they aren't on the tip yet).

# ADR-019: Recording and media retention

- Status: **Accepted — approved by owner Maddy, 2026-11-01**
- Date: 2026-11-01
- Owner: Architecture (All Rounder Techy); settings UI by the Coordinator; tests by Tester & Security
- Related: [ADR-014](./ADR-014-geoip-session-location.md) (IP retention), `docs/12-security/upload-media-security.md` §7, `docs/12-security/multi-tenant-isolation.md`, `docs/12-security/rbac-matrix.md`
- Settles: open question #9 in `docs/12-security/assumptions-open-questions.md`

## Context

`upload-media-security.md` §7 asks for org-configurable retention and hard delete of media and derived data on request,
but no default exists and there is no media purge job. Already decided elsewhere: ADR-014 nulls raw IPs after 30 days;
mobile deletes local chunks after a confirmed upload, with a 7-day cap. AssemblyAI keeps uploads and transcripts until
they are deleted.

India's DPDP Rules 2025 were notified on 13 Nov 2025; erasure and notice duties apply from 13 May 2027, and Rule 8
requires processing logs to be kept for at least one year. GDPR requires storage limitation. For meeting content, MeetOps
is mostly the processor; the customer org is the Data Fiduciary (GDPR controller).

## Decision

| Data                                                  | Retention                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| Raw recordings and normalised audio/video             | **90 days by default**; owner/admin can set **7–365 days** per org |
| Transcripts, reports, tasks, embeddings               | Until the meeting or account is deleted                            |
| Session chunks (`tmp/session-chunks/`)                | Bucket lifecycle rule, 2 days                                      |
| Quarantined objects                                   | 30 days, then deleted                                              |
| Soft-deleted rows (`deletedAt`), including embeddings | Hard purge after 30 days                                           |
| Backups                                               | 35-day rolling window, so deleted data ages out                    |
| Audit and processing logs                             | At least 1 year (DPDP Rule 8); raw IPs nulled at 30 days (ADR-014) |
| AI provider copies (AssemblyAI, Gemini)               | Deleted at the provider right after processing                     |

1. A daily worker job purges expired media and derived rows per org, using the separate audited system role from
   `multi-tenant-isolation.md`. It is batched and idempotent, and logs counts only.
2. Purged media is never downloadable; deletion is audited.
3. Owners and admins manage retention (`rbac-matrix.md`); members and viewers can read it.

## Consequences

- The org retention setting narrows to 7–365 days. The `MIN_RETENTION_DAYS`/`MAX_RETENTION_DAYS` contract constants
  (1 and 3650 on `integration/phase-1`) need a contracts change.
- Storage cost stays bounded (for example about 90 GB steady for 1,000 audio hours a month).
- Users lose replay of raw media after the window unless they raise it.
- The privacy notice, DPA and sub-processor list must state this schedule (owner, with counsel).

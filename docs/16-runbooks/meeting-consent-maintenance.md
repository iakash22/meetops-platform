# Meeting consent ledger: maintenance opt-out

`meeting_consent_events` (migration `20261031030000_meeting_consent_events`) is append-only. The
`meeting_consent_events_append_only` trigger refuses every UPDATE, DELETE and TRUNCATE, including for the
table owner, and `meetops_app` holds only SELECT and INSERT. A revocation is a new event, never an edit.

## When to use the opt-out

Only for a reviewed data migration (for example a schema backfill or a legally required erasure) that
Akash has approved in writing. Never from application code, never to "fix" a consent decision.

## How

The trigger lets a statement through only when **both** hold:

1. the session runs as a member of `meetops_migrator`, and
2. `meetops.consent_maintenance` is `on` for the current transaction.

```sql
BEGIN;
SET LOCAL meetops.consent_maintenance = 'on';   -- transaction-scoped; ends at COMMIT/ROLLBACK
-- reviewed UPDATE/DELETE on meeting_consent_events here (still subject to forced RLS)
COMMIT;
```

- Always `SET LOCAL`, never `SET` or a role/database default, so the opt-out cannot leak into other work.
- Forced RLS still applies: set `app.current_organization_id` for the org you are touching.
- The setting has no effect for `meetops_app` (not a `meetops_migrator` member); it still gets
  `insufficient_privilege`.
- Record what was changed, why, and the approval in the PR or incident notes.

## Deploying `20261031130000_consent_hardening` (locking)

- `ALTER TABLE meeting_consent_events ADD COLUMN "seq" BIGSERIAL NOT NULL` has a volatile default
  (`nextval`), so Postgres **rewrites the whole table under an ACCESS EXCLUSIVE lock**: all reads and
  writes on `meeting_consent_events` block until it finishes.
- `CREATE INDEX ... (org_id, meeting_id, seq)` takes a SHARE lock and **blocks inserts/updates** for
  its duration.
- The two `ADD CONSTRAINT ... CHECK ... NOT VALID` statements only take a brief lock (no scan).
- The table is new and small today, so this should take a moment, but run it in a **maintenance window**
  (or at low traffic) and set `lock_timeout` so it fails fast instead of queueing behind long
  transactions. On a large table, build the index separately with `CREATE INDEX CONCURRENTLY`
  (outside the Prisma migration transaction) before deploying, and keep `IF NOT EXISTS` in the migration.
- Optional later: `ALTER TABLE ... VALIDATE CONSTRAINT ..._backdate_check` (SHARE UPDATE EXCLUSIVE,
  does not block writes) once legacy rows are confirmed in bounds.
- Behaviour change: attestations older than 24 h fail closed (422 `CONSENT_INVALID` from the API;
  CHECK violation 23514 at the DB). In-flight uploads holding an older attestation must re-attest.

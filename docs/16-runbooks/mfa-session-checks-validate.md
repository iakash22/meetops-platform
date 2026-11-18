# MFA sessions CHECK validation (`20261111180100`)

Migration `20261111180100_mfa_validate_session_checks` (PR #497) runs `VALIDATE CONSTRAINT` on the two
CHECKs that `20261111180000_mfa_totp` added `NOT VALID`:

- `sessions_auth_level_check`: `"auth_level" IN ('password', 'google', 'mfa')`
- `sessions_mfa_at_level_check`: `"mfa_at" IS NULL OR "auth_level" = 'mfa'`

`VALIDATE CONSTRAINT` takes only SHARE UPDATE EXCLUSIVE, so logins and session reads/writes continue
while existing rows are scanned. If any existing row fails a CHECK, that constraint stays `NOT VALID`
and Prisma records the migration as failed.

`20261111180000_mfa_totp` itself starts with `SET lock_timeout = '5s'` so `ADD COLUMN` / `ADD
CONSTRAINT` fail fast rather than queue behind a long lock on `sessions`.

## Pre-check (run before deploying `20261111180100`)

Run as the **migrator role** (forced RLS would hide other tenants' sessions from the app role). Both
counts must be 0:

```sql
SELECT count(*) AS bad_auth_level
FROM "sessions"
WHERE "auth_level" NOT IN ('password', 'google', 'mfa');

SELECT count(*) AS bad_mfa_at
FROM "sessions"
WHERE "mfa_at" IS NOT NULL AND "auth_level" <> 'mfa';
```

If either count is not 0, inspect and fix those rows before deploying. Do not invent an `mfa` level
for a session that has not passed MFA: set a valid first-factor `auth_level` (`password` or `google`)
and clear `mfa_at` when the session is not at `mfa`.

## Recovery after a failed `VALIDATE CONSTRAINT`

1. Confirm the failure. The constraint is still `NOT VALID`, and `_prisma_migrations` has this
   migration as failed:

   ```sql
   SELECT conname, convalidated
   FROM pg_constraint
   WHERE conname IN ('sessions_auth_level_check', 'sessions_mfa_at_level_check');

   SELECT migration_name, finished_at, rolled_back_at, logs
   FROM "_prisma_migrations"
   WHERE migration_name = '20261111180100_mfa_validate_session_checks';
   ```

2. Find the offending rows (same predicates as the pre-check):

   ```sql
   SELECT id, user_id, auth_level, mfa_at, created_at
   FROM "sessions"
   WHERE "auth_level" NOT IN ('password', 'google', 'mfa')
      OR ("mfa_at" IS NOT NULL AND "auth_level" <> 'mfa');
   ```

3. Fix those rows as in the pre-check (valid `auth_level`; `mfa_at` only with `auth_level = 'mfa'`).
   Re-run both counts until they are 0.

4. Mark the migration rolled back, then deploy again:

   ```bash
   pnpm --filter @meetops/database exec prisma migrate resolve --rolled-back 20261111180100_mfa_validate_session_checks
   pnpm --filter @meetops/database exec prisma migrate deploy
   ```

   Optionally `SET lock_timeout = '5s'` on the session before a manual `VALIDATE CONSTRAINT` so a
   stuck lock fails fast.

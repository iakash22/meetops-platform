#!/usr/bin/env bash
# Logical Postgres backup for MeetOps (P9 item #10; docs/16-runbooks/backup-restore.md).
# Usage: scripts/db-backup.sh --db <name> [--out DIR]
# Connection comes ONLY from libpq env (PGHOST, PGPORT, PGUSER, PGPASSFILE/PGPASSWORD), never from argv, so no
# password lands in `ps`, shell history or logs. Use the owner/migrator role, never the RLS-bound app role (it
# would dump only one org's rows).
# Writes <out>/meetops-<db>-<UTC ts>.dump (pg_dump -Fc) and a .meta file (sha256, latest applied migration, git
# sha, server version, per-table row counts used by scripts/db-restore-drill.sh). Files are created 0600.
set -euo pipefail
# PG_BIN: directory of client tools matching the SERVER major version (e.g. /usr/lib/postgresql/16/bin).
B="${PG_BIN:+$PG_BIN/}"
DB="" OUT="backups"
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="${2:?--db needs a name}"; shift 2 ;;
    --out) OUT="${2:?--out needs a dir}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "db-backup: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "db-backup: --db must be a plain lowercase identifier" >&2; exit 2; }
for t in "${B}pg_dump" "${B}psql" sha256sum; do command -v "$t" >/dev/null || { echo "db-backup: $t not found" >&2; exit 3; }; done
umask 077; mkdir -p "$OUT"
TS="$(date -u +%Y%m%dT%H%M%SZ)"; BASE="$OUT/meetops-$DB-$TS"
q() { "${B}psql" -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "$1" < /dev/null; }
q 'select 1' >/dev/null || { echo "db-backup: cannot connect to database $DB (check PG* env)" >&2; exit 4; }
"${B}pg_dump" --format=custom --no-owner --no-privileges --file="$BASE.dump" -d "$DB"
{
  echo "sha256=$(sha256sum "$BASE.dump" | cut -d' ' -f1)"
  echo "database=$DB"
  echo "created_utc=$TS"
  echo "git_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "server_version=$(q 'show server_version_num')"
  echo "latest_migration=$(q "select coalesce((select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc, migration_name desc limit 1), '') where to_regclass('_prisma_migrations') is not null union all select '' where to_regclass('_prisma_migrations') is null" | head -1)"
  echo "rls_forced_tables=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity")"
  # Exact counts (not estimates) of every public table, as the restore drill's comparison baseline.
  q "select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1" |
    while IFS= read -r tbl; do echo "rows.$tbl=$(q "select count(*) from public.\"$tbl\"")"; done
} > "$BASE.meta"
echo "db-backup: wrote $BASE.dump and $BASE.meta"

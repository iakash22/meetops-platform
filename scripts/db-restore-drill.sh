#!/usr/bin/env bash
# Postgres restore drill (P9 item #10; docs/16-runbooks/backup-restore.md "Restore drill").
# Usage: scripts/db-restore-drill.sh --dump FILE.dump [--target drill_<name>] [--keep]
# Restores a scripts/db-backup.sh dump into a NEW scratch database on a LOCAL server and verifies it against the
# .meta baseline: checksum, pg_restore success, pgvector present, forced-RLS table count, latest migration and
# exact per-table row counts. Prints measured restore time (RTO input) and backup age (RPO input).
# Safety: the target must be named drill_* and must not exist (never restores over a database); PGHOST must be
# local (unset/socket, localhost, 127.0.0.1, ::1); the scratch DB is dropped afterwards unless --keep.
# Connection from libpq env only (PGHOST, PGPORT, PGUSER, PGPASSFILE/PGPASSWORD); never from argv.
# Exit: 0 PASS, 1 verification FAIL, 2 usage, 3 missing tool, 4 refused (safety).
set -euo pipefail
# PG_BIN: directory of client tools matching the SERVER major version (e.g. /usr/lib/postgresql/16/bin).
B="${PG_BIN:+$PG_BIN/}"
DUMP="" TARGET="" KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP="${2:?--dump needs a file}"; shift 2 ;;
    --target) TARGET="${2:?--target needs a name}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "drill: unknown argument: $1" >&2; exit 2 ;;
  esac
done
refuse() { echo "drill: REFUSED: $*" >&2; exit 4; }
[ -f "$DUMP" ] || { echo "drill: --dump file not found" >&2; exit 2; }
META="${DUMP%.dump}.meta"; [ -f "$META" ] || { echo "drill: missing $META (made by scripts/db-backup.sh)" >&2; exit 2; }
for t in "${B}pg_restore" "${B}psql" "${B}createdb" "${B}dropdb" sha256sum; do command -v "$t" >/dev/null || { echo "drill: $t not found" >&2; exit 3; }; done
case "${PGHOST:-}" in ""|/*|localhost|127.0.0.1|::1) ;; *) refuse "PGHOST '${PGHOST}' is not local; drills run against a local server only" ;; esac
TARGET="${TARGET:-drill_$(date -u +%Y%m%d%H%M%S)}"
[[ "$TARGET" =~ ^drill_[a-z0-9_]{1,56}$ ]] || refuse "target must match drill_[a-z0-9_]+"
meta() { sed -n "s/^$1=//p" "$META" | head -1; }
q() { "${B}psql" -X -q -At -v ON_ERROR_STOP=1 -d "$TARGET" -c "$1" < /dev/null; }
exists="$("${B}psql" -X -q -At -d postgres -c "select 1 from pg_database where datname='$TARGET'")" \
  || { echo "drill: cannot connect to the local server (check PG* env)" >&2; exit 4; }
server_major=$(( $("${B}psql" -X -q -At -d postgres -c 'show server_version_num') / 10000 ))
client_major="$("${B}pg_restore" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)*.*/\1/')"
[ "$client_major" -le "$server_major" ] || {
  echo "drill: pg_restore $client_major is newer than the server ($server_major); its output may not load. Set PG_BIN to" >&2
  echo "       v$server_major client tools (or run the drill inside the server image). Back up with the same tools." >&2
  exit 3; }
[ -z "$exists" ] || refuse "database $TARGET already exists; drills never restore over a database"

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS $1 ($2)"; else echo "  FAIL $1 (expected '$3', got '$2')"; fails=$((fails+1)); fi; }
echo "drill: $DUMP -> $TARGET"
check "checksum" "$(sha256sum "$DUMP" | cut -d' ' -f1)" "$(meta sha256)"
if [ "$fails" -gt 0 ]; then echo "drill: FAIL (checksum mismatch; not restoring)"; exit 1; fi
cleanup() { [ "$KEEP" = 1 ] || "${B}dropdb" --if-exists "$TARGET" 2>/dev/null || true; }
trap cleanup EXIT
start=$(date +%s)
"${B}createdb" "$TARGET"
if "${B}pg_restore" --no-owner --no-privileges --exit-on-error -d "$TARGET" "$DUMP"; then echo "  PASS pg_restore"; else echo "  FAIL pg_restore"; exit 1; fi
secs=$(( $(date +%s) - start ))
check "pgvector extension" "$(q "select count(*) from pg_extension where extname='vector'")" 1
check "forced-RLS tables" "$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity")" "$(meta rls_forced_tables)"
mig="$(q "select coalesce((select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc, migration_name desc limit 1), '') where to_regclass('_prisma_migrations') is not null union all select '' where to_regclass('_prisma_migrations') is null" | head -1)"
check "latest migration" "$mig" "$(meta latest_migration)"
while IFS='=' read -r key want; do
  tbl="${key#rows.}"
  check "rows $tbl" "$(q "select count(*) from public.\"$tbl\"" 2>/dev/null || echo missing)" "$want"
done < <(grep '^rows\.' "$META")
created="$(meta created_utc)"
age_s=$(( $(date -u +%s) - $(date -u -d "${created:0:8} ${created:9:2}:${created:11:2}:${created:13:2}" +%s) ))
echo "drill: restore took ${secs}s (RTO input); backup age ${age_s}s (RPO input); backup git sha $(meta git_sha)"
[ "$KEEP" = 1 ] && echo "drill: kept $TARGET (drop it with: dropdb $TARGET)"
if [ "$fails" -eq 0 ]; then echo "drill: PASS"; else echo "drill: FAIL ($fails checks)"; exit 1; fi

#!/usr/bin/env bash
# Postgres restore drill (P9 item #10; docs/16-runbooks/backup-restore.md "Restore drill").
# Usage: scripts/db-restore-drill.sh --dump FILE.dump[.age|.gpg] [--identity AGE_KEY_FILE] [--target drill_<name>] [--keep]
# Restores a scripts/db-backup.sh dump into a NEW scratch database on a LOCAL server and verifies it against the
# .meta baseline: checksum, pg_restore success, pgvector present, forced-RLS table count, latest migration and
# exact per-table row counts. Prints measured restore time (RTO input) and backup age (RPO input).
# Encrypted dumps are decrypted in a stream straight into pg_restore (no plaintext on disk): .age needs
# --identity (age key file); .gpg uses the caller's gpg keyring/agent.
# Safety: the target must be named drill_* and must not exist (never restores over a database); PGHOST must be
# local (unset/socket, localhost, 127.0.0.1, ::1); PGHOSTADDR, PGSERVICE and PGSERVICEFILE are refused; after
# connecting, inet_server_addr() must be NULL (unix socket) or loopback. The scratch DB is dropped afterwards
# unless --keep. Connection from libpq env only (PGHOST, PGPORT, PGUSER, PGPASSFILE/PGPASSWORD); never argv.
# PG_BIN: directory of client tools matching the server major version.
# Exit: 0 PASS, 1 verification FAIL, 2 usage, 3 missing tool, 4 refused (safety).
set -euo pipefail
B="${PG_BIN:+$PG_BIN/}"
DUMP="" TARGET="" KEEP=0 IDENT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP="${2:?--dump needs a file}"; shift 2 ;;
    --target) TARGET="${2:?--target needs a name}"; shift 2 ;;
    --identity) IDENT="${2:?--identity needs a file}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "drill: unknown argument: $1" >&2; exit 2 ;;
  esac
done
refuse() { echo "drill: REFUSED: $*" >&2; exit 4; }
[ -f "$DUMP" ] || { echo "drill: --dump file not found" >&2; exit 2; }
case "$DUMP" in
  *.dump) ENC=none; META="${DUMP%.dump}.meta" ;;
  *.dump.age) ENC=age; META="${DUMP%.dump.age}.meta" ;;
  *.dump.gpg) ENC=gpg; META="${DUMP%.dump.gpg}.meta" ;;
  *) echo "drill: --dump must end in .dump, .dump.age or .dump.gpg" >&2; exit 2 ;;
esac
[ -f "$META" ] || { echo "drill: missing $META (made by scripts/db-backup.sh)" >&2; exit 2; }
for t in "${B}pg_restore" "${B}psql" "${B}createdb" "${B}dropdb" sha256sum; do command -v "$t" >/dev/null || { echo "drill: $t not found" >&2; exit 3; }; done
if [ "$ENC" != none ]; then
  command -v "$ENC" >/dev/null || { echo "drill: dump is $ENC-encrypted but '$ENC' is not installed" >&2; exit 3; }
  [ "$ENC" = gpg ] || [ -f "$IDENT" ] || { echo "drill: .age dump needs --identity <age key file>" >&2; exit 2; }
fi
# Every libpq way to point at another server is refused, not just PGHOST.
for v in PGHOSTADDR PGSERVICE PGSERVICEFILE; do [ -z "${!v:-}" ] || refuse "$v is set; drills use PGHOST/PGPORT only"; done
case "${PGHOST:-}" in ""|/*|localhost|127.0.0.1|::1) ;; *) refuse "PGHOST '${PGHOST}' is not local; drills run against a local server only" ;; esac
TARGET="${TARGET:-drill_$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}}"
[[ "$TARGET" =~ ^drill_[a-z0-9_]{1,56}$ ]] || refuse "target must match drill_[a-z0-9_]+"
meta() { sed -n "s/^$1=//p" "$META" | head -1; }
q() { "${B}psql" -X -q -At -v ON_ERROR_STOP=1 -d "$TARGET" -c "$1" < /dev/null; }
qp() { "${B}psql" -X -q -At -v ON_ERROR_STOP=1 -d postgres -c "$1" < /dev/null; }
addr="$(qp "select coalesce(host(inet_server_addr()), '')")" \
  || { echo "drill: cannot connect to the local server (check PG* env)" >&2; exit 4; }
case "$addr" in ""|127.*|::1) ;; *) refuse "connected server address $addr is not loopback or a unix socket" ;; esac
server_major=$(( $(qp 'show server_version_num') / 10000 ))
client_major="$("${B}pg_restore" --version | sed -E 's/.* ([0-9]+)(\.[0-9]+)*.*/\1/')"
[ "$client_major" -le "$server_major" ] || {
  echo "drill: pg_restore $client_major is newer than the server ($server_major); its output may not load. Set PG_BIN to" >&2
  echo "       v$server_major client tools (or run the drill inside the server image). Back up with the same tools." >&2
  exit 3; }
[ -z "$(qp "select 1 from pg_database where datname='$TARGET'")" ] || refuse "database $TARGET already exists; drills never restore over a database"

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS $1 ($2)"; else echo "  FAIL $1 (expected '$3', got '$2')"; fails=$((fails+1)); fi; }
echo "drill: $DUMP -> $TARGET"
check "checksum" "$(sha256sum "$DUMP" | cut -d' ' -f1)" "$(meta sha256)"
check "encryption" "$ENC" "$(meta encryption || true)"
if [ "$fails" -gt 0 ]; then echo "drill: FAIL (checksum/encryption mismatch; not restoring)"; exit 1; fi
start=$(date +%s)
"${B}createdb" "$TARGET" || { echo "drill: createdb $TARGET failed" >&2; exit 1; }
# Only now is there something of ours to clean up.
cleanup() { [ "$KEEP" = 1 ] || "${B}dropdb" --if-exists "$TARGET" < /dev/null 2>/dev/null || true; }
trap cleanup EXIT
restore() {
  case "$ENC" in
    none) "${B}pg_restore" --no-owner --no-privileges --exit-on-error -d "$TARGET" < "$DUMP" ;;
    age)  age -d -i "$IDENT" "$DUMP" | "${B}pg_restore" --no-owner --no-privileges --exit-on-error -d "$TARGET" ;;
    gpg)  gpg --batch --quiet --decrypt "$DUMP" | "${B}pg_restore" --no-owner --no-privileges --exit-on-error -d "$TARGET" ;;
  esac
}
if restore; then echo "  PASS pg_restore"; else echo "  FAIL pg_restore"; exit 1; fi
secs=$(( $(date +%s) - start ))
check "pgvector extension" "$(q "select count(*) from pg_extension where extname='vector'")" 1
check "forced-RLS tables" "$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity")" "$(meta rls_forced_tables)"
mig="$(q "select coalesce((select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc, migration_name desc limit 1), '') where to_regclass('_prisma_migrations') is not null union all select '' where to_regclass('_prisma_migrations') is null" | head -1)"
check "latest migration" "$mig" "$(meta latest_migration)"
while IFS='=' read -r key want; do
  tbl="${key#rows.}"
  # .meta is input: only plain lowercase identifiers are accepted, and they are quoted as identifiers.
  if ! [[ "$tbl" =~ ^[a-z_][a-z0-9_]*$ ]] || ! [[ "$want" =~ ^[0-9]+$ ]]; then
    echo "  FAIL rows: invalid .meta entry rejected"; fails=$((fails+1)); continue
  fi
  check "rows $tbl" "$(q "select count(*) from public.\"$tbl\"" 2>/dev/null || echo missing)" "$want"
done < <(grep '^rows\.' "$META")
created="$(meta created_utc)"
age_s=$(( $(date -u +%s) - $(date -u -d "${created:0:8} ${created:9:2}:${created:11:2}:${created:13:2}" +%s) ))
echo "drill: restore took ${secs}s (RTO input); backup age ${age_s}s (RPO input); backup git sha $(meta git_sha)"
[ "$KEEP" = 1 ] && echo "drill: kept $TARGET (drop it with: dropdb $TARGET)"
if [ "$fails" -eq 0 ]; then echo "drill: PASS"; else echo "drill: FAIL ($fails checks)"; exit 1; fi

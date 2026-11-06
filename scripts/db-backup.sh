#!/usr/bin/env bash
# Logical Postgres backup for MeetOps (P9 item #10; docs/16-runbooks/backup-restore.md).
# Usage: scripts/db-backup.sh --db <name> [--out DIR] [--encrypt age|gpg --recipient <age-recipient|gpg-key-id>]
# Connection comes ONLY from libpq env (PGHOST, PGPORT, PGUSER, PGPASSFILE/PGPASSWORD), never from argv, so no
# password lands in `ps`, shell history or logs. Use the owner/migrator role, never the RLS-bound app role (it
# would dump only one org's rows).
# Writes <out>/meetops-<db>-<UTC ts>.dump (pg_dump -Fc; .dump.age / .dump.gpg when encrypted, streamed so no
# plaintext dump touches disk) and a .meta file (sha256 of the stored file, encryption, latest applied migration,
# git sha, server version, per-table row counts used by scripts/db-restore-drill.sh).
# --out is forced to 0700 (created if missing); an existing dir owned by another user is refused. Files are 0600.
# The dump is written to a temp file and renamed only on success; a failed run leaves no partial dump.
# PG_BIN: directory of client tools matching the SERVER major version (e.g. /usr/lib/postgresql/16/bin).
# Exit: 0 ok, 2 usage, 3 missing tool, 4 connect/refused, other = pg_dump/encryption failure.
set -euo pipefail
B="${PG_BIN:+$PG_BIN/}"
DB="" OUT="backups" ENC="" RCPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="${2:?--db needs a name}"; shift 2 ;;
    --out) OUT="${2:?--out needs a dir}"; shift 2 ;;
    --encrypt) ENC="${2:?--encrypt needs age or gpg}"; shift 2 ;;
    --recipient) RCPT="${2:?--recipient needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "db-backup: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "db-backup: --db must be a plain lowercase identifier" >&2; exit 2; }
case "$ENC" in "") [ -z "$RCPT" ] || { echo "db-backup: --recipient needs --encrypt" >&2; exit 2; } ;;
  age|gpg) [ -n "$RCPT" ] || { echo "db-backup: --encrypt $ENC needs --recipient" >&2; exit 2; }
    command -v "$ENC" >/dev/null || { echo "db-backup: --encrypt $ENC requested but '$ENC' is not installed; no backup written" >&2; exit 3; } ;;
  *) echo "db-backup: --encrypt must be age or gpg" >&2; exit 2 ;;
esac
for t in "${B}pg_dump" "${B}psql" sha256sum stat; do command -v "$t" >/dev/null || { echo "db-backup: $t not found" >&2; exit 3; }; done
umask 077
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  [ -d "$OUT" ] && [ ! -L "$OUT" ] || { echo "db-backup: --out $OUT is not a directory (or is a symlink)" >&2; exit 4; }
  [ "$(stat -c %u "$OUT")" = "$(id -u)" ] || { echo "db-backup: REFUSED: --out $OUT is owned by another user" >&2; exit 4; }
  chmod 700 "$OUT"
else
  mkdir -p -m 700 "$OUT"
fi
TS="$(date -u +%Y%m%dT%H%M%SZ)"; BASE="$OUT/meetops-$DB-$TS"
EXT=".dump${ENC:+.$ENC}"
q() { "${B}psql" -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "$1" < /dev/null; }
q 'select 1' >/dev/null || { echo "db-backup: cannot connect to database $DB (check PG* env)" >&2; exit 4; }
TMPF="$(mktemp "$OUT/.partial.XXXXXX")"; TMPM="$(mktemp "$OUT/.partial-meta.XXXXXX")"
trap 'rm -f "$TMPF" "$TMPM"' EXIT
case "$ENC" in
  "")  "${B}pg_dump" --format=custom --no-owner --no-privileges -d "$DB" > "$TMPF" ;;
  age) "${B}pg_dump" --format=custom --no-owner --no-privileges -d "$DB" | age -r "$RCPT" > "$TMPF" ;;
  gpg) "${B}pg_dump" --format=custom --no-owner --no-privileges -d "$DB" | gpg --batch --yes --quiet --encrypt --recipient "$RCPT" > "$TMPF" ;;
esac
[ -s "$TMPF" ] || { echo "db-backup: empty dump" >&2; exit 1; }
LIST="select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by 1"
{
  echo "sha256=$(sha256sum "$TMPF" | cut -d' ' -f1)"
  echo "encryption=${ENC:-none}"
  echo "database=$DB"
  echo "created_utc=$TS"
  echo "git_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "server_version=$(q 'show server_version_num')"
  echo "latest_migration=$(q "select coalesce((select migration_name from _prisma_migrations where finished_at is not null order by finished_at desc, migration_name desc limit 1), '') where to_regclass('_prisma_migrations') is not null union all select '' where to_regclass('_prisma_migrations') is null" | head -1)"
  echo "rls_forced_tables=$(q "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity")"
  skipped=0
  # Exact counts as the drill baseline. Only plain lowercase identifiers are recorded (and quoted); others skipped.
  while IFS= read -r tbl; do
    if [[ "$tbl" =~ ^[a-z_][a-z0-9_]*$ ]]; then echo "rows.$tbl=$(q "select count(*) from public.\"$tbl\"")"
    else skipped=$((skipped+1)); echo "db-backup: WARN table with a non-plain name not row-checked" >&2; fi
  done < <(q "$LIST")
  echo "unchecked_tables=$skipped"
} > "$TMPM"
mv "$TMPF" "$BASE$EXT"; mv "$TMPM" "$BASE.meta"; trap - EXIT
echo "db-backup: wrote $BASE$EXT and $BASE.meta (encryption: ${ENC:-none})"

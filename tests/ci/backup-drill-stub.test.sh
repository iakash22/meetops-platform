#!/usr/bin/env bash
# Server-free tests for scripts/db-backup.sh and scripts/db-restore-drill.sh: stub PG client tools in PG_BIN
# (no Postgres, no docker). Covers safety refusals, .meta validation, --out permissions, atomic dump writes,
# trap ordering and gpg encryption round-trip (age is exercised only for "requested but missing" when absent).
# The real-server path is tests/ci/backup-drill.test.sh.   Usage: bash tests/ci/backup-drill-stub.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit
ROOT="$PWD"; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1: $2"; fail=1; }
S="$TMP/stub"; mkdir "$S"; LOG="$TMP/calls"; : > "$LOG"
export STUB_LOG="$LOG" STUB_DIR="$TMP"
cat > "$S/psql" <<'P'
#!/bin/bash
sql=""; while [ $# -gt 0 ]; do [ "$1" = -c ] && sql="$2"; shift; done
echo "psql $sql" >> "$STUB_LOG"
[ -n "${STUB_NOCONNECT:-}" ] && exit 2
case "$sql" in
  "select 1") echo 1 ;;
  *inet_server_addr*) echo "${STUB_ADDR:-}" ;;
  "show server_version_num") echo 160004 ;;
  *pg_database*) [ -f "$STUB_DIR/db-exists" ] && echo 1 ;;
  *"from _prisma_migrations"*) echo 20261103180000_x ;;
  *relforcerowsecurity*) echo 1 ;;
  *"c.relname from pg_class"*) printf 'meetings\norganizations\n' ;;
  *'"meetings"'*) echo 25 ;;
  *'"organizations"'*) echo 3 ;;
  *"extname='vector'"*) echo 1 ;;
  *) echo 0 ;;
esac
P
cat > "$S/pg_dump" <<'P'
#!/bin/bash
echo "pg_dump $*" >> "$STUB_LOG"; printf 'PGDMP-partial'
[ -n "${STUB_DUMP_FAIL:-}" ] && exit 1; printf 'PGDMP-rest-of-archive\n'
P
cat > "$S/pg_restore" <<'P'
#!/bin/bash
[ "$1" = --version ] && { echo "pg_restore (PostgreSQL) 16.4"; exit 0; }
c="$(cat)"; echo "pg_restore got=$c" >> "$STUB_LOG"; [ "$c" = "PGDMP-partialPGDMP-rest-of-archive" ]
P
printf '#!/bin/bash\necho "createdb $*" >> "$STUB_LOG"; [ -z "${STUB_CREATEDB_FAIL:-}" ]\n' > "$S/createdb"
printf '#!/bin/bash\necho "dropdb $*" >> "$STUB_LOG"\n' > "$S/dropdb"
chmod +x "$S"/*; export PG_BIN="$S"
BK="$ROOT/scripts/db-backup.sh"; DR="$ROOT/scripts/db-restore-drill.sh"
run() { out="$("$@" 2>&1)"; rc=$?; }

# ---- backup ----
run "$BK" --db meetops --out "$TMP/out1"
DUMP="$(ls "$TMP"/out1/*.dump 2>/dev/null)"; META="${DUMP%.dump}.meta"
[ $rc -eq 0 ] && [ "$(stat -c %a "$TMP/out1")" = 700 ] && [ "$(stat -c %a "$DUMP")" = 600 ] && grep -q '^rows.meetings=25$' "$META" && grep -q '^encryption=none$' "$META" \
  && ok "backup: dump + meta, dir 0700, files 0600" || bad "backup" "rc=$rc $out"
mkdir -m 755 "$TMP/out2"; run "$BK" --db meetops --out "$TMP/out2"
[ $rc -eq 0 ] && [ "$(stat -c %a "$TMP/out2")" = 700 ] && ok "existing --out forced to 0700" || bad "chmod out" "$(stat -c %a "$TMP/out2")"
run "$BK" --db meetops --out /
[ $rc -eq 4 ] && [[ "$out" == *"owned by another user"* ]] && ok "--out owned by another user refused" || bad "foreign out" "rc=$rc $out"
ln -s "$TMP/out1" "$TMP/outlink"; run "$BK" --db meetops --out "$TMP/outlink"
[ $rc -eq 4 ] && ok "symlinked --out refused" || bad "symlink out" "rc=$rc"
STUB_DUMP_FAIL=1 run "$BK" --db meetops --out "$TMP/out3"
[ $rc -ne 0 ] && [ -z "$(ls -A "$TMP/out3")" ] && ok "failed pg_dump leaves no partial dump or meta" || bad "partial" "rc=$rc $(ls -A "$TMP/out3")"
run "$BK" --db meetops --out "$TMP/out4" --encrypt age --recipient age1xyz
if command -v age >/dev/null; then ok "age present (missing-tool case not testable here)"
else [ $rc -eq 3 ] && [[ "$out" == *"not installed"* ]] && [ ! -e "$TMP/out4" ] && ok "--encrypt age without age fails clearly, writes nothing" || bad "age missing" "rc=$rc $out"; fi
run "$BK" --db meetops --encrypt gpg; [ $rc -eq 2 ] && ok "--encrypt without --recipient rejected" || bad "no rcpt" "rc=$rc"
run "$BK" --db meetops --encrypt rot13 --recipient x; [ $rc -eq 2 ] && ok "unknown --encrypt rejected" || bad "bad enc" "rc=$rc"

# ---- drill refusals (before any createdb) ----
: > "$LOG"
for v in PGHOSTADDR=10.0.0.9 PGSERVICE=prod PGSERVICEFILE=/tmp/x; do
  run env "$v" "$DR" --dump "$DUMP"; [ $rc -eq 4 ] && [[ "$out" == *"${v%%=*} is set"* ]] && ok "refuses ${v%%=*}" || bad "${v%%=*}" "rc=$rc $out"
done
run env PGHOST=db.example.com "$DR" --dump "$DUMP"; [ $rc -eq 4 ] && ok "refuses remote PGHOST" || bad "remote" "rc=$rc"
STUB_ADDR=10.1.2.3 run "$DR" --dump "$DUMP"; [ $rc -eq 4 ] && [[ "$out" == *"not loopback"* ]] && ok "refuses a non-loopback inet_server_addr()" || bad "addr" "rc=$rc $out"
grep -q '^createdb' "$LOG" && bad "refusals" "createdb ran" || ok "no createdb on any refusal"
touch "$TMP/db-exists"; run "$DR" --dump "$DUMP" --target drill_x; rm "$TMP/db-exists"
[ $rc -eq 4 ] && [[ "$out" == *"already exists"* ]] && ! grep -q '^dropdb' "$LOG" && ok "existing target refused and NOT dropped" || bad "exists" "rc=$rc $out"

# ---- drill pass + cleanup + trap ordering ----
: > "$LOG"; STUB_ADDR=127.0.0.1 run "$DR" --dump "$DUMP"
[ $rc -eq 0 ] && [[ "$out" == *"drill: PASS"* ]] && ok "drill PASS via loopback" || bad "pass" "rc=$rc $out"
t1="$(sed -n 's/^createdb //p' "$LOG")"; grep -qx "dropdb --if-exists $t1" "$LOG" && [[ "$t1" =~ ^drill_[0-9]{14}_[0-9]+_[0-9]+$ ]] && ok "unique default target ($t1) dropped" || bad "unique/drop" "$t1 $(cat "$LOG")"
: > "$LOG"; STUB_CREATEDB_FAIL=1 run "$DR" --dump "$DUMP" --target drill_cf
[ $rc -eq 1 ] && ! grep -q '^dropdb' "$LOG" && ok "createdb failure: cleanup trap not set, nothing dropped" || bad "trap order" "rc=$rc $(cat "$LOG")"

# ---- .meta validation ----
cp "$META" "$TMP/meta.bak"
printf 'rows.x"; drop table organizations; --=1\n' >> "$META"
: > "$LOG"; run "$DR" --dump "$DUMP" --target drill_inj
[ $rc -eq 1 ] && [[ "$out" == *"invalid .meta entry rejected"* ]] && ! grep -q 'drop table' "$LOG" && ok "malicious .meta table name rejected, never sent to psql" || bad "inject" "rc=$rc $out"
cp "$TMP/meta.bak" "$META"; printf 'rows.Meetings=1\n' >> "$META"; run "$DR" --dump "$DUMP" --target drill_up
[ $rc -eq 1 ] && [[ "$out" == *"invalid .meta entry"* ]] && ok "non-lowercase .meta table name rejected" || bad "upper" "rc=$rc"
cp "$TMP/meta.bak" "$META"

# ---- gpg round trip (no plaintext dump on disk) ----
if command -v gpg >/dev/null; then
  export GNUPGHOME="$TMP/gnupg"; mkdir -m 700 "$GNUPGHOME"
  gpg --batch --quiet --passphrase '' --quick-gen-key 'drill-test <drill@example.invalid>' default default never 2>/dev/null
  run "$BK" --db meetops --out "$TMP/enc" --encrypt gpg --recipient drill@example.invalid
  E="$(ls "$TMP"/enc/*.dump.gpg 2>/dev/null)"
  if [ $rc -eq 0 ] && [ -s "$E" ] && ! grep -q PGDMP "$E" && [ -z "$(ls "$TMP"/enc/*.dump 2>/dev/null)" ] && grep -q '^encryption=gpg$' "${E%.dump.gpg}.meta"; then ok "gpg: encrypted dump, no plaintext file"; else bad "gpg backup" "rc=$rc $out"; fi
  STUB_ADDR= run "$DR" --dump "$E" --target drill_gpg
  [ $rc -eq 0 ] && [[ "$out" == *"PASS encryption (gpg)"* && "$out" == *"drill: PASS"* ]] && ok "gpg: drill decrypts in a stream and passes" || bad "gpg drill" "rc=$rc $out"
  cp "$E" "$TMP/enc/fake.dump.age"; cp "${E%.dump.gpg}.meta" "$TMP/enc/fake.meta"; run "$DR" --dump "$TMP/enc/fake.dump.age"
  command -v age >/dev/null || { [ $rc -eq 3 ] && ok "drill: .age dump without age fails clearly" || bad "age drill" "rc=$rc $out"; }
else echo "SKIP gpg round trip (gpg not installed)"; fi
[ $fail -eq 0 ] && echo "ALL BACKUP DRILL STUB TESTS PASSED" || echo "BACKUP DRILL STUB TESTS FAILED"
exit $fail

#!/usr/bin/env bash
# Tests scripts/db-backup.sh + scripts/db-restore-drill.sh against a LOCAL Postgres with pgvector.
# Point libpq env at a throwaway server first (superuser, e.g. the pgvector/pgvector:pg16 image), e.g.
#   docker run -d --rm --name drill-pg --network host -e POSTGRES_PASSWORD_FILE=... pgvector/pgvector:pg16 -c port=55439
#   PGHOST=127.0.0.1 PGPORT=55439 PGUSER=postgres PGPASSFILE=... bash tests/ci/backup-drill.test.sh
# Without a reachable server it prints SKIP and exits 0. Creates/drops only drill_src_test and drill_* databases.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit
# DRILL_TEST_CONTAINER=<name>: run the PG client tools INSIDE that server container (matching major version) via
# wrappers in PG_BIN; host psql is still used for fixtures. Needed when host tools are newer than the server.
if [ -n "${DRILL_TEST_CONTAINER:-}" ]; then
  WB="$(mktemp -d)"; C="$DRILL_TEST_CONTAINER"; X="docker exec -i -u postgres -e PGPORT=${PGPORT:-5432} $C"
  for t in psql createdb dropdb; do printf '#!/bin/bash\nexec %s %s "$@"\n' "$X" $t > "$WB/$t"; done
  printf '#!/bin/bash\na=(); f=; for x; do case "$x" in --file=*) f="${x#--file=}";; *) a+=("$x");; esac; done\n%s pg_dump "${a[@]}" > "$f"\n' "$X" > "$WB/pg_dump"
  printf '#!/bin/bash\nexec %s pg_restore "$@"\n' "$X" > "$WB/pg_restore"
  chmod +x "$WB"/*; export PG_BIN="$WB"
fi
psql -X -q -At -d postgres -c 'select 1' >/dev/null 2>&1 || { echo "SKIP backup drill tests: no local Postgres via PG* env"; exit 0; }
TMP="$(mktemp -d)"; SRC=drill_src_test
trap 'rm -rf "${WB:-/nonexistent}"; dropdb --if-exists $SRC 2>/dev/null; dropdb --if-exists drill_t1 2>/dev/null; dropdb --if-exists drill_keep 2>/dev/null; rm -rf "$TMP"' EXIT
fail=0
ok() { echo "ok   $1"; }; bad() { echo "FAIL $1: $2"; fail=1; }
dropdb --if-exists $SRC; createdb $SRC
psql -X -q -v ON_ERROR_STOP=1 -d $SRC <<'SQL' >/dev/null
create extension vector;
create table _prisma_migrations (id text primary key, migration_name text, finished_at timestamptz);
insert into _prisma_migrations values ('1','20261101000000_init',now()-interval '1 day'),('2','20261103180000_meeting_status',now());
create table organizations (id text primary key);
create table meetings (id text primary key, "organizationId" text references organizations, embedding vector(3));
alter table meetings enable row level security; alter table meetings force row level security;
create policy org on meetings using ("organizationId" = current_setting('app.org', true));
insert into organizations select 'o'||g from generate_series(1,3) g;
insert into meetings select 'm'||g, 'o'||(1+g%3), '[1,2,3]' from generate_series(1,25) g;
SQL
out="$(scripts/db-backup.sh --db $SRC --out "$TMP" 2>&1)"; rc=$?
DUMP="$(ls "$TMP"/*.dump 2>/dev/null | head -1)"; META="${DUMP%.dump}.meta"
if [ $rc -eq 0 ] && [ -s "$DUMP" ] && grep -q '^rows.meetings=25$' "$META" && grep -q '^latest_migration=20261103180000_meeting_status$' "$META" \
  && grep -q '^rls_forced_tables=1$' "$META" && [ "$(stat -c %a "$DUMP")" = 600 ]; then ok "backup writes dump + meta (0600)"; else bad "backup" "rc=$rc $out"; fi
out="$(scripts/db-restore-drill.sh --dump "$DUMP" --target drill_t1 2>&1)"; rc=$?
[ $rc -eq 0 ] && [[ "$out" == *"drill: PASS"* && "$out" == *"PASS rows meetings (25)"* && "$out" == *"PASS pgvector"* ]] && ok "drill PASS on a good dump" || bad "drill pass" "rc=$rc $out"
[ -z "$(psql -X -At -d postgres -c "select 1 from pg_database where datname='drill_t1'")" ] && ok "scratch db dropped" || bad "drop" "drill_t1 remains"
out="$(scripts/db-restore-drill.sh --dump "$DUMP" --target drill_keep --keep 2>&1)"; rc=$?
[ $rc -eq 0 ] && [ -n "$(psql -X -At -d postgres -c "select 1 from pg_database where datname='drill_keep'")" ] && ok "--keep keeps scratch db" || bad "keep" "$out"
out="$(scripts/db-restore-drill.sh --dump "$DUMP" --target drill_keep 2>&1)"; rc=$?
[ $rc -eq 4 ] && [[ "$out" == *"already exists"* ]] && ok "refuses an existing target" || bad "existing" "rc=$rc $out"
out="$(scripts/db-restore-drill.sh --dump "$DUMP" --target $SRC 2>&1)"; rc=$?
[ $rc -eq 4 ] && ok "refuses a non-drill_ target (source db)" || bad "non-drill" "rc=$rc $out"
out="$(PGHOST=db.example.com scripts/db-restore-drill.sh --dump "$DUMP" 2>&1)"; rc=$?
[ $rc -eq 4 ] && [[ "$out" == *"not local"* ]] && ok "refuses a remote PGHOST" || bad "remote" "rc=$rc $out"
cp "$META" "$TMP/m.bak"; sed -i 's/^rows.meetings=25$/rows.meetings=26/' "$META"
out="$(scripts/db-restore-drill.sh --dump "$DUMP" --target drill_t1 2>&1)"; rc=$?
[ $rc -eq 1 ] && [[ "$out" == *"FAIL rows meetings"* ]] && ok "row-count drift fails the drill" || bad "rows drift" "rc=$rc $out"
cp "$TMP/m.bak" "$META"; sed -i 's/^sha256=.*/sha256=deadbeef/' "$META"
out="$(scripts/db-restore-drill.sh --dump "$DUMP" --target drill_t1 2>&1)"; rc=$?
[ $rc -eq 1 ] && [[ "$out" == *"checksum mismatch"* ]] && ok "checksum mismatch fails before restore" || bad "checksum" "rc=$rc $out"
out="$(scripts/db-backup.sh --db 'x;drop' 2>&1)"; rc=$?
[ $rc -eq 2 ] && ok "backup rejects a non-identifier db name" || bad "db name" "rc=$rc"
[ $fail -eq 0 ] && echo "ALL BACKUP DRILL TESTS PASSED" || echo "BACKUP DRILL TESTS FAILED"
exit $fail

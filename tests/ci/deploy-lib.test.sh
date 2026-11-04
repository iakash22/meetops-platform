#!/usr/bin/env bash
# Tests for the deploy target interface (scripts/deploy-lib.sh) and its wiring through scripts/deploy.sh.
# Uses a stub target, stub pnpm and temp files only; never runs gates, prisma against a DB, or a real deploy.
# Usage: bash tests/ci/deploy-lib.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit
ROOT="$PWD"; HEAD="$(git rev-parse HEAD)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
check() { # name rc-want substring -- runs "$@" in a subshell that sources the lib
  local name="$1" want_rc="$2" want="$3"; shift 3
  local out rc; out="$(bash -c ". '$ROOT/scripts/deploy-lib.sh'; $*" 2>&1)"; rc=$?
  if { [ "$want_rc" = 0 ] && [ $rc -eq 0 ]; } || { [ "$want_rc" != 0 ] && [ $rc -ne 0 ]; }; then
    [[ "$out" == *"$want"* ]] && { echo "ok   $name"; return; }
  fi
  echo "FAIL $name (rc=$rc): $out"; fail=1
}
umask 077
printf 'cred\n' > "$TMP/cred"; printf 'postgresql://u:p@db.internal:5432/meetops\n' > "$TMP/db"
printf 'mysql://x\n' > "$TMP/baddb"; printf 'x\n' > "$TMP/open"; chmod 644 "$TMP/open"; : > "$TMP/empty"
ln -s "$TMP/cred" "$TMP/credlink"
STUB_TARGET='DEPLOY_KNOWN_TARGETS+=(stub-k8s); deploy_target_stub_k8s() { echo "stub deploy $1 $2 cred=$3"; [ -z "${STUB_FAIL:-}" ]; };'
OK_ENV="DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/cred DEPLOY_DATABASE_URL_FILE=$TMP/db"

check "unset target = none"          0 "none"            'deploy_validate_target; echo $DEPLOY_TARGET_NAME'
check "unknown target refused"       1 "unknown DEPLOY_TARGET 'k8s'" 'DEPLOY_TARGET=k8s deploy_validate_target'
check "bad target syntax refused"    1 "must match"      'DEPLOY_TARGET="../x" deploy_validate_target'
check "raw DEPLOY_CREDENTIALS refused" 1 "not accepted"  'DEPLOY_CREDENTIALS=s3cr3t deploy_validate_target'
check "known target w/o function"    1 "no deploy_target_ghost" 'DEPLOY_KNOWN_TARGETS+=(ghost); DEPLOY_TARGET=ghost deploy_validate_target'
check "real target needs cred file"  1 "DEPLOY_CREDENTIALS_FILE is required" "$STUB_TARGET DEPLOY_TARGET=stub-k8s deploy_validate_target"
check "relative cred path refused"   1 "absolute"        "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=cred deploy_validate_target"
check "symlink cred refused"         1 "symlink"         "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/credlink deploy_validate_target"
check "world-readable cred refused"  1 "chmod 600"       "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/open deploy_validate_target"
check "empty cred refused"           1 "is empty"        "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/empty deploy_validate_target"
check "missing db url file"          1 "DEPLOY_DATABASE_URL_FILE is required" "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/cred deploy_validate_target"
check "non-postgres url refused"     1 "postgres://"     "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/cred DEPLOY_DATABASE_URL_FILE=$TMP/baddb deploy_validate_target"
check "valid real target accepted"   0 "stub-k8s"        "$STUB_TARGET $OK_ENV; export DEPLOY_TARGET DEPLOY_CREDENTIALS_FILE DEPLOY_DATABASE_URL_FILE; deploy_validate_target; echo \$DEPLOY_TARGET_NAME"

# deploy_run ordering with stub pnpm (records argv and whether DATABASE_URL reached it; never prints the URL).
BIN="$TMP/bin"; mkdir "$BIN"
printf '#!/bin/bash\necho "pnpm $*" >> "%s/calls"; [ -n "$DATABASE_URL" ] && echo "url-set" >> "%s/calls"; [ -z "${PNPM_FAIL:-}" ]\n' "$TMP" "$TMP" > "$BIN/pnpm"
chmod +x "$BIN/pnpm"
RUN="$STUB_TARGET export $OK_ENV; deploy_validate_target; rec() { echo MARKER >> $TMP/calls; }; deploy_run"
check "none: placeholder, no marker" 0 "no staging marker" "deploy_validate_target; rec() { echo MARKER; }; deploy_run staging $HEAD $BIN:/usr/bin:/bin rec"
: > "$TMP/calls"
check "staging: migrate->rollout->marker" 0 "Deployed sha-$HEAD to staging" "$RUN staging $HEAD $BIN:/usr/bin:/bin rec"
if [ "$(tr '\n' '|' < "$TMP/calls")" = "pnpm --filter @meetops/database exec prisma migrate deploy|url-set|MARKER|" ]; then echo "ok   call order"; else echo "FAIL call order: $(cat "$TMP/calls")"; fail=1; fi
: > "$TMP/calls"
check "production: no marker"        0 "to production"   "$RUN production $HEAD $BIN:/usr/bin:/bin rec"
grep -q MARKER "$TMP/calls" && { echo "FAIL production wrote marker"; fail=1; } || echo "ok   production writes no marker"
: > "$TMP/calls"
check "migrate failure stops rollout" 1 "nothing was rolled out" "export PNPM_FAIL=1; $RUN staging $HEAD $BIN:/usr/bin:/bin rec"
grep -q MARKER "$TMP/calls" && { echo "FAIL marker after migrate failure"; fail=1; } || echo "ok   no marker after migrate failure"
: > "$TMP/calls"
check "rollout failure: no marker"   1 "no staging marker recorded" "export STUB_FAIL=1; $RUN staging $HEAD $BIN:/usr/bin:/bin rec"
grep -q MARKER "$TMP/calls" && { echo "FAIL marker after rollout failure"; fail=1; } || echo "ok   no marker after rollout failure"
out="$(bash -c ". '$ROOT/scripts/deploy-lib.sh'; $RUN staging $HEAD $BIN:/usr/bin:/bin rec" 2>&1)"
[[ "$out" == *"db.internal"* || "$out" == *"u:p@"* ]] && { echo "FAIL database url printed"; fail=1; } || echo "ok   database url never printed"

# Wiring through the hardened wrapper (env -i allowlist): preflight validates the target.
PF=(env DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy staging")
o="$("${PF[@]}" DEPLOY_TARGET=k8s scripts/deploy.sh --non-interactive staging </dev/null 2>&1)"; rc=$?
[ $rc -ne 0 ] && [[ "$o" == *"unknown DEPLOY_TARGET 'k8s'"* ]] && echo "ok   wrapper refuses unknown target" || { echo "FAIL wrapper unknown ($rc): $o"; fail=1; }
o="$("${PF[@]}" DEPLOY_CREDENTIALS=x scripts/deploy.sh --non-interactive staging </dev/null 2>&1)"; rc=$?
[ $rc -ne 0 ] && [[ "$o" == *"not accepted"* ]] && echo "ok   wrapper refuses raw credentials" || { echo "FAIL wrapper raw cred ($rc): $o"; fail=1; }
o="$("${PF[@]}" scripts/deploy.sh --non-interactive staging </dev/null 2>&1)"; rc=$?
[ $rc -eq 0 ] && [[ "$o" == *"PREFLIGHT OK (target: none)"* ]] && echo "ok   wrapper default target none" || { echo "FAIL wrapper none ($rc): $o"; fail=1; }

# ---- TOCTOU: one open, checks and reads through the fd -------------------------------------------------------------
WW="$TMP/ww"; mkdir "$WW"; chmod 777 "$WW"; printf 'cred\n' > "$WW/cred"; chmod 600 "$WW/cred"
check "world-writable parent dir refused" 1 "parent dir is group/world-writable" "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$WW/cred deploy_validate_target"
SW="$TMP/swap"; mkdir "$SW"; printf 'original-cred\n' > "$SW/cred"; printf 'postgresql://orig@h/db\n' > "$SW/db"
SWAP_TARGET='DEPLOY_KNOWN_TARGETS+=(swap); deploy_target_swap() { printf "evil\n" > "'"$SW"'/cred.new"; mv "'"$SW"'/cred.new" "'"$SW"'/cred"; echo "target read: $(cat "$3") via $3"; };'
printf '#!/bin/bash\necho "url=$DATABASE_URL" >> "%s/swapcalls"; printf "postgresql://evil@h/db\\n" > "%s/db"\n' "$TMP" "$SW" > "$BIN/pnpm"
check "target reads the validated fd, not the swapped path" 0 "target read: original-cred via /dev/fd/7" \
  "$SWAP_TARGET export DEPLOY_TARGET=swap DEPLOY_CREDENTIALS_FILE=$SW/cred DEPLOY_DATABASE_URL_FILE=$SW/db; deploy_validate_target; rec() { :; }; deploy_run staging $HEAD $BIN:/usr/bin:/bin rec"
grep -q 'url=postgresql://orig@h/db' "$TMP/swapcalls" && echo "ok   migrate uses the URL read once from the fd" || { echo "FAIL db url: $(cat "$TMP/swapcalls")"; fail=1; }
ln -sf "$TMP/cred" "$TMP/cred2link"
check "symlinked file refused (lstat)" 1 "must not be a symlink" "$STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/cred2link deploy_validate_target"
check "fifo refused" 1 "" "mkfifo $TMP/fifo; chmod 600 $TMP/fifo; $STUB_TARGET DEPLOY_TARGET=stub-k8s DEPLOY_CREDENTIALS_FILE=$TMP/fifo timeout 5 bash -c 'deploy_validate_target' || exit 1"

# ---- DEPLOY_CREDENTIALS value never crosses env -i (argv) -----------------------------------------------------------
FAKE="$TMP/fake"; mkdir -p "$FAKE/scripts"; cp scripts/deploy.sh "$FAKE/scripts/"
cat > "$FAKE/scripts/deploy-impl.sh" <<IMPL
#!/bin/bash
tr '\\0' '\\n' < /proc/\$\$/environ > "$TMP/impl-environ"; tr '\\0' ' ' < /proc/\$\$/cmdline > "$TMP/impl-argv"
IMPL
chmod +x "$FAKE/scripts/deploy-impl.sh" "$FAKE/scripts/deploy.sh"
DEPLOY_CREDENTIALS='s3cr3t-VALUE-xyz' "$FAKE/scripts/deploy.sh" staging </dev/null >/dev/null 2>&1
if [ -s "$TMP/impl-environ" ] && ! grep -q 's3cr3t-VALUE-xyz' "$TMP/impl-environ" "$TMP/impl-argv" && grep -qx 'DEPLOY_CREDENTIALS_SET=1' "$TMP/impl-environ" && ! grep -q '^DEPLOY_CREDENTIALS=' "$TMP/impl-environ"; then
  echo "ok   credential value never passed through env -i argv/env (only DEPLOY_CREDENTIALS_SET=1)"
else echo "FAIL credential leak: $(cat "$TMP/impl-environ" "$TMP/impl-argv" 2>&1)"; fail=1; fi
grep -nE 'DEPLOY_CREDENTIALS="\$\{DEPLOY_CREDENTIALS' scripts/deploy.sh && { echo "FAIL deploy.sh forwards the raw value"; fail=1; } || echo "ok   deploy.sh has no raw DEPLOY_CREDENTIALS forward"
[ $fail -eq 0 ] && echo "ALL DEPLOY-LIB TESTS PASSED" || echo "DEPLOY-LIB TESTS FAILED"
exit $fail

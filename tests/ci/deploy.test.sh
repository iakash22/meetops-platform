#!/usr/bin/env bash
# Shell tests for scripts/deploy.sh pre-gate checks. Never reaches local-gates or deploy.
# Usage: bash tests/ci/deploy.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit
HEAD="$(git rev-parse HEAD)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/state"; mkdir -m 700 "$STATE"
FORGED="$TMP/forged"; mkdir -m 700 "$FORGED"; touch "$FORGED/staging-$HEAD"
fail=0
expect() { # name, expected-substring, cmd...
  local name="$1" want="$2"; shift 2
  local out; out="$("$@" </dev/null 2>&1)"; local rc=$?
  if [ $rc -ne 0 ] && [[ "$out" == *"$want"* ]]; then echo "ok   $name"
  else echo "FAIL $name (rc=$rc): $out"; fail=1; fi
}
expect "usage on bad env"        "Usage:"              bash scripts/deploy.sh prod
expect "short sha rejected"      "40 lowercase hex"    bash scripts/deploy.sh staging abc123
expect "uppercase sha rejected"  "40 lowercase hex"    bash scripts/deploy.sh staging "$(echo "$HEAD" | tr a-f A-F)"
expect "sha must equal HEAD"     "does not match HEAD" bash scripts/deploy.sh staging 0000000000000000000000000000000000000000
expect "non-tty needs flag"      "--non-interactive"   bash scripts/deploy.sh staging
expect "flag needs DEPLOY_CONFIRM" "DEPLOY_CONFIRM"    bash scripts/deploy.sh --non-interactive staging
expect "wrong DEPLOY_CONFIRM"    "DEPLOY_CONFIRM"      env DEPLOY_CONFIRM="deploy staging" bash scripts/deploy.sh --non-interactive production
expect "prod needs staging gate" "staging gate"        env DEPLOY_CONFIRM="deploy production" bash scripts/deploy.sh --non-interactive production
expect_ok() { # name, expected-substring, cmd...
  local name="$1" want="$2"; shift 2
  local out; out="$("$@" </dev/null 2>&1)"; local rc=$?
  if [ $rc -eq 0 ] && [[ "$out" == *"$want"* ]]; then echo "ok   $name"
  else echo "FAIL $name (rc=$rc): $out"; fail=1; fi
}
PF=(env DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production")
# Forged marker via the old env override must be ignored (no test-state override => fixed dir).
expect "forged marker (env dir) ignored" "staging gate" env DEPLOY_STATE_DIR="$FORGED" XDG_STATE_HOME="$FORGED" HOME="$FORGED" \
  DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production" bash scripts/deploy.sh --non-interactive production
expect "missing state dir"       "missing or a symlink" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$TMP/nope" bash scripts/deploy.sh --non-interactive production
ln -s "$STATE" "$TMP/linkdir"
expect "symlinked state dir"     "missing or a symlink" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$TMP/linkdir" bash scripts/deploy.sh --non-interactive production
expect "no marker"               "has not been deployed" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" bash scripts/deploy.sh --non-interactive production
ln -s "$FORGED/staging-$HEAD" "$STATE/staging-$HEAD"
expect "symlink marker rejected" "has not been deployed" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" bash scripts/deploy.sh --non-interactive production
rm "$STATE/staging-$HEAD"; touch "$STATE/staging-$HEAD"
chmod 777 "$STATE"
expect "world-writable dir"      "group/world-writable" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" bash scripts/deploy.sh --non-interactive production
chmod 720 "$STATE"
expect "group-writable dir"      "group/world-writable" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" bash scripts/deploy.sh --non-interactive production
chmod 700 "$STATE"
expect_ok "valid marker passes"  "PREFLIGHT OK"         "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" bash scripts/deploy.sh --non-interactive production
expect_ok "staging preflight"    "PREFLIGHT OK"         env DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy staging" bash scripts/deploy.sh --non-interactive staging
expect "build-images extra args" "Usage:"               bash scripts/build-images.sh --push extra
exit $fail

#!/usr/bin/env bash
# Shell tests for scripts/deploy.sh pre-gate checks (scripts are run directly, as documented). Never reaches local-gates or deploy.
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
expect "usage on bad env"        "Usage:"              scripts/deploy.sh prod
expect "short sha rejected"      "40 lowercase hex"    scripts/deploy.sh staging abc123
expect "uppercase sha rejected"  "40 lowercase hex"    scripts/deploy.sh staging "$(echo "$HEAD" | tr a-f A-F)"
expect "sha must equal HEAD"     "does not match HEAD" scripts/deploy.sh staging 0000000000000000000000000000000000000000
expect "non-tty needs flag"      "--non-interactive"   scripts/deploy.sh staging
expect "flag needs DEPLOY_CONFIRM" "DEPLOY_CONFIRM"    scripts/deploy.sh --non-interactive staging
expect "wrong DEPLOY_CONFIRM"    "DEPLOY_CONFIRM"      env DEPLOY_CONFIRM="deploy staging" scripts/deploy.sh --non-interactive production
expect "prod needs staging gate" "staging gate"        env DEPLOY_CONFIRM="deploy production" scripts/deploy.sh --non-interactive production
expect_ok() { # name, expected-substring, cmd...
  local name="$1" want="$2"; shift 2
  local out; out="$("$@" </dev/null 2>&1)"; local rc=$?
  if [ $rc -eq 0 ] && [[ "$out" == *"$want"* ]]; then echo "ok   $name"
  else echo "FAIL $name (rc=$rc): $out"; fail=1; fi
}
PF=(env DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production")
# Forged marker via the old env override must be ignored (no test-state override => fixed dir).
expect "forged marker (env dir) ignored" "staging gate" env DEPLOY_STATE_DIR="$FORGED" XDG_STATE_HOME="$FORGED" HOME="$FORGED" \
  DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production" scripts/deploy.sh --non-interactive production
expect "missing state dir"       "missing or a symlink" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$TMP/nope" scripts/deploy.sh --non-interactive production
ln -s "$STATE" "$TMP/linkdir"
expect "symlinked state dir"     "symlink in state dir path" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$TMP/linkdir" scripts/deploy.sh --non-interactive production
expect "no marker"               "has not been deployed" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" scripts/deploy.sh --non-interactive production
ln -s "$FORGED/staging-$HEAD" "$STATE/staging-$HEAD"
expect "symlink marker rejected" "has not been deployed" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" scripts/deploy.sh --non-interactive production
rm "$STATE/staging-$HEAD"; touch "$STATE/staging-$HEAD"
chmod 777 "$STATE"
expect "world-writable dir"      "group/world-writable" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" scripts/deploy.sh --non-interactive production
chmod 720 "$STATE"
expect "group-writable dir"      "group/world-writable" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" scripts/deploy.sh --non-interactive production
chmod 700 "$STATE"
# Fake getent first on PATH pointing at a temp home with a 700 state dir and a pre-made marker.
FAKE="$TMP/fakehome"; mkdir -p "$FAKE/.local/state/meetops-deploy" "$TMP/bin"
chmod 700 "$FAKE/.local/state/meetops-deploy"; touch "$FAKE/.local/state/meetops-deploy/staging-$HEAD"
printf '#!/bin/sh\necho "x:x:%s:%s::%s:/bin/sh"\n' "$(id -u)" "$(id -g)" "$FAKE" > "$TMP/bin/getent"
for b in id stat git; do printf '#!/bin/sh\nexec /usr/bin/%s "$@"\n' "$b" > "$TMP/bin/$b"; done
chmod +x "$TMP/bin/"*
expect "fake getent on PATH"     "staging gate"         env PATH="$TMP/bin:$PATH" DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production" \
  scripts/deploy.sh --non-interactive production
mkdir "$TMP/real"; chmod 700 "$TMP/real"; ln -s "$TMP/real" "$TMP/alias"; mkdir -m 700 "$TMP/real/sd"; touch "$TMP/real/sd/staging-$HEAD"
expect "symlink in path"         "symlink in state dir path" "${PF[@]}" DEPLOY_TEST_STATE_DIR="$TMP/alias/sd" scripts/deploy.sh --non-interactive production
# bash-level env attacks must not neutralise abort/exit.
printf 'exit(){ :; }\nabort(){ :; }\n' > "$TMP/bashenv"
mkdir "$TMP/fb"; printf '#!/bin/sh\necho FAKEBASH; exit 0\n' > "$TMP/fb/bash"; chmod +x "$TMP/fb/bash"
expect "exported BASH_FUNC_exit" "staging gate" env 'BASH_FUNC_exit%%=() { :; }' 'BASH_FUNC_abort%%=() { :; }' \
  DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production" scripts/deploy.sh --non-interactive production
expect "BASH_FUNC_exit on impl"  "staging gate" env 'BASH_FUNC_exit%%=() { :; }' 'BASH_FUNC_abort%%=() { :; }' \
  DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production" scripts/deploy-impl.sh --non-interactive production
expect "BASH_ENV exit override"  "staging gate" env BASH_ENV="$TMP/bashenv" ENV="$TMP/bashenv" \
  DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production" scripts/deploy.sh --non-interactive production
expect "fake bash on PATH"       "staging gate" env PATH="$TMP/fb:$PATH" \
  DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy production" scripts/deploy.sh --non-interactive production
expect "fake bash: build-images" "Usage:" env PATH="$TMP/fb:$PATH" scripts/build-images.sh --bogus
expect_ok "valid marker passes"  "PREFLIGHT OK"         "${PF[@]}" DEPLOY_TEST_STATE_DIR="$STATE" scripts/deploy.sh --non-interactive production
expect_ok "staging preflight"    "PREFLIGHT OK"         env DEPLOY_PREFLIGHT_ONLY=1 DEPLOY_CONFIRM="deploy staging" scripts/deploy.sh --non-interactive staging
expect "build-images extra args" "Usage:"               scripts/build-images.sh --push extra
exit $fail

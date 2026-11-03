#!/usr/bin/env bash
# Shell tests for scripts/deploy.sh pre-gate checks. Never reaches local-gates or deploy.
# Usage: bash tests/ci/deploy.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
HEAD="$(git rev-parse HEAD)"
STATE="$(mktemp -d)"; trap 'rm -rf "$STATE"' EXIT
export DEPLOY_STATE_DIR="$STATE"
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
exit $fail

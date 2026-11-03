#!/usr/bin/env bash
# Manual deploy entrypoint (PLACEHOLDER: no deploy target exists yet).
# Usage: scripts/deploy.sh [--non-interactive] <staging|production> [image-sha]
# Requires an interactive TTY confirmation (read from /dev/tty) for every environment.
# Non-interactive runs must pass --non-interactive AND set DEPLOY_CONFIRM="deploy <env>".
# Production requires a prior successful staging deploy of the same sha (staging gate), recorded
# as a marker in a FIXED state dir: <passwd home of the current uid>/.local/state/meetops-deploy.
# The dir is NOT configurable via env (DEPLOY_STATE_DIR/XDG_STATE_HOME/HOME are ignored), so a
# caller cannot point the gate at a forged marker. Marker must be a regular non-symlink file owned
# by the current user, in a non-symlink dir owned by the user that is not group/world-writable.
# Threat model: protects against a caller/CI env or another local user forging the staging proof;
# it does NOT protect against someone already running as this user (they can write the marker).
# DEPLOY_PREFLIGHT_ONLY=1 (tests): stop with exit 0 right after the pre-gate checks, before any
# gate or deploy; only in that mode is DEPLOY_TEST_STATE_DIR honoured.
# [image-sha] must be the full 40-char HEAD sha (default: HEAD).
# Aborts unless `pnpm local-gates`, gitleaks and scripts/audit-gate.mjs all pass on a clean tree.
set -euo pipefail
cd "$(dirname "$0")/.."

NON_INTERACTIVE=0
if [ "${1:-}" = "--non-interactive" ]; then NON_INTERACTIVE=1; shift; fi
ENV_NAME="${1:-}"
case "$ENV_NAME" in staging|production) ;; *)
  echo "Usage: scripts/deploy.sh [--non-interactive] <staging|production> [image-sha]" >&2; exit 2;; esac
abort() { echo "ABORT: $*" >&2; exit 1; }
PASSWD_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
[ -n "$PASSWD_HOME" ] || abort "cannot resolve home dir for uid $(id -u)"
STATE_DIR="$PASSWD_HOME/.local/state/meetops-deploy"
PREFLIGHT_ONLY=0
if [ "${DEPLOY_PREFLIGHT_ONLY:-}" = 1 ]; then
  PREFLIGHT_ONLY=1
  [ -n "${DEPLOY_TEST_STATE_DIR:-}" ] && STATE_DIR="$DEPLOY_TEST_STATE_DIR"
fi
check_state_dir() {
  [ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] || abort "staging gate: state dir $STATE_DIR missing or a symlink"
  [ "$(stat -c %u "$STATE_DIR")" = "$(id -u)" ] || abort "staging gate: state dir not owned by current user"
  (( 8#$(stat -c %a "$STATE_DIR") & 8#022 )) && abort "staging gate: state dir is group/world-writable"
  return 0
}
HEAD_SHA="$(git rev-parse HEAD)"
SHA="${2:-$HEAD_SHA}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || abort "sha must be exactly 40 lowercase hex characters"
[ "$SHA" = "$HEAD_SHA" ] || abort "sha $SHA does not match HEAD $HEAD_SHA; check out that commit first"
if [ "$NON_INTERACTIVE" = 1 ]; then
  [ "${DEPLOY_CONFIRM:-}" = "deploy $ENV_NAME" ] || abort "--non-interactive requires DEPLOY_CONFIRM='deploy $ENV_NAME'"
else
  [ -t 0 ] || abort "interactive terminal required (stdin is not a TTY); use --non-interactive explicitly"
fi
if [ "$ENV_NAME" = production ]; then
  check_state_dir
  MARKER="$STATE_DIR/staging-$SHA"
  [ -f "$MARKER" ] && [ ! -L "$MARKER" ] || abort "staging gate: sha $SHA has not been deployed to staging (no regular marker file)"
  [ "$(stat -c %u "$MARKER")" = "$(id -u)" ] || abort "staging gate: marker not owned by current user"
fi
if [ "$PREFLIGHT_ONLY" = 1 ]; then echo "PREFLIGHT OK"; exit 0; fi
[ -z "$(git status --porcelain)" ] || abort "working tree is dirty"

echo "==> gate: pnpm local-gates"
pnpm local-gates || abort "pnpm local-gates failed"
echo "==> gate: gitleaks"
gitleaks detect --source . --redact --no-banner || abort "gitleaks found leaks"
echo "==> gate: audit-gate"
env -u AUDIT_GATE_NOW node scripts/audit-gate.mjs || abort "audit-gate failed"

if [ "$NON_INTERACTIVE" = 0 ]; then
  [ -t 0 ] || abort "interactive terminal required"
  printf "Deploy sha-%s to %s? Type 'deploy %s': " "$SHA" "$ENV_NAME" "$ENV_NAME" > /dev/tty
  IFS= read -r ans < /dev/tty || abort "no confirmation read"
  [ "$ans" = "deploy $ENV_NAME" ] || abort "not confirmed"
fi

echo "All gates passed."
echo "PLACEHOLDER: would deploy ghcr.io/iakash22/meetops-platform/{api,worker,web,realtime}:sha-$SHA to $ENV_NAME."
echo "Needed when a real target exists (provide via env/secret manager, never in the repo):"
echo "  DEPLOY_TARGET       deploy endpoint (cluster API, host, or platform app id)"
echo "  DEPLOY_CREDENTIALS  deploy credential (short-lived/OIDC preferred)"
echo "  DATABASE_URL        to run 'prisma migrate deploy' before rollout"
echo "Nothing was deployed, so no staging marker is recorded."
# When a real target exists, call record_staging ONLY after the deploy command succeeds:
#   real_deploy_command && { [ "$ENV_NAME" = staging ] && record_staging; }
record_staging() {
  umask 077; mkdir -p -m 700 "$STATE_DIR"; check_state_dir
  date -u +%FT%TZ > "$STATE_DIR/staging-$SHA"
  echo "Recorded staging gate for $SHA in $STATE_DIR."
}

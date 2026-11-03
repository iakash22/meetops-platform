#!/usr/bin/env bash
# Manual deploy entrypoint (PLACEHOLDER: no deploy target exists yet).
# Usage: scripts/deploy.sh [--non-interactive] <staging|production> [image-sha]
# Requires an interactive TTY confirmation (read from /dev/tty) for every environment.
# Non-interactive runs must pass --non-interactive AND set DEPLOY_CONFIRM="deploy <env>".
# Production requires a prior successful staging run of the same sha (staging gate), recorded
# under DEPLOY_STATE_DIR (default: ${XDG_STATE_HOME:-$HOME/.local/state}/meetops-deploy).
# [image-sha] must be the full 40-char HEAD sha (default: HEAD).
# Aborts unless `pnpm local-gates`, gitleaks and scripts/audit-gate.mjs all pass on a clean tree.
set -euo pipefail
cd "$(dirname "$0")/.."

NON_INTERACTIVE=0
if [ "${1:-}" = "--non-interactive" ]; then NON_INTERACTIVE=1; shift; fi
ENV_NAME="${1:-}"
case "$ENV_NAME" in staging|production) ;; *)
  echo "Usage: scripts/deploy.sh [--non-interactive] <staging|production> [image-sha]" >&2; exit 2;; esac
STATE_DIR="${DEPLOY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/meetops-deploy}"
abort() { echo "ABORT: $*" >&2; exit 1; }
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
  [ -f "$STATE_DIR/staging-$SHA" ] || abort "staging gate: sha $SHA has not been deployed to staging"
fi
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
echo "Nothing was deployed."
if [ "$ENV_NAME" = staging ]; then
  mkdir -p "$STATE_DIR" && date -u +%FT%TZ > "$STATE_DIR/staging-$SHA"
  echo "Recorded staging gate for $SHA in $STATE_DIR."
fi

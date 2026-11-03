#!/usr/bin/env bash
# Manual deploy entrypoint (PLACEHOLDER: no deploy target exists yet).
# Usage: scripts/deploy.sh <staging|production> [image-sha]
# Requires an interactive TTY confirmation for every environment.
# [image-sha] must be the full 40-char HEAD sha (default: HEAD).
# Aborts unless `pnpm local-gates`, gitleaks and scripts/audit-gate.mjs all pass on a clean tree.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_NAME="${1:-}"
case "$ENV_NAME" in staging|production) ;; *)
  echo "Usage: scripts/deploy.sh <staging|production> [image-sha]" >&2; exit 2;; esac
abort() { echo "ABORT: $*" >&2; exit 1; }
HEAD_SHA="$(git rev-parse HEAD)"
SHA="${2:-$HEAD_SHA}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || abort "sha must be exactly 40 lowercase hex characters"
[ "$SHA" = "$HEAD_SHA" ] || abort "sha $SHA does not match HEAD $HEAD_SHA; check out that commit first"
[ -t 0 ] || abort "interactive terminal required (stdin is not a TTY)"
[ -z "$(git status --porcelain)" ] || abort "working tree is dirty"

echo "==> gate: pnpm local-gates"
pnpm local-gates || abort "pnpm local-gates failed"
echo "==> gate: gitleaks"
gitleaks detect --source . --redact --no-banner || abort "gitleaks found leaks"
echo "==> gate: audit-gate"
env -u AUDIT_GATE_NOW node scripts/audit-gate.mjs || abort "audit-gate failed"

[ -t 0 ] || abort "interactive terminal required"
printf "Deploy sha-%s to %s? Type 'deploy %s': " "$SHA" "$ENV_NAME" "$ENV_NAME" > /dev/tty
IFS= read -r ans < /dev/tty || abort "no confirmation read"
[ "$ans" = "deploy $ENV_NAME" ] || abort "not confirmed"

echo "All gates passed."
echo "PLACEHOLDER: would deploy ghcr.io/iakash22/meetops-platform/{api,worker,web,realtime}:sha-$SHA to $ENV_NAME."
echo "Needed when a real target exists (provide via env/secret manager, never in the repo):"
echo "  DEPLOY_TARGET       deploy endpoint (cluster API, host, or platform app id)"
echo "  DEPLOY_CREDENTIALS  deploy credential (short-lived/OIDC preferred)"
echo "  DATABASE_URL        to run 'prisma migrate deploy' before rollout"
echo "Nothing was deployed."

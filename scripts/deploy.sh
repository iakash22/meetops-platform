#!/usr/bin/env bash
# Manual deploy entrypoint (PLACEHOLDER: no deploy target exists yet).
# Usage: scripts/deploy.sh <staging|production> [image-sha]
# Aborts unless `pnpm local-gates`, gitleaks and scripts/audit-gate.mjs all pass on a clean tree.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_NAME="${1:-}"
case "$ENV_NAME" in staging|production) ;; *)
  echo "Usage: scripts/deploy.sh <staging|production> [image-sha]" >&2; exit 2;; esac
SHA="${2:-$(git rev-parse HEAD)}"

abort() { echo "ABORT: $*" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || abort "working tree is dirty"

echo "==> gate: pnpm local-gates"
pnpm local-gates || abort "pnpm local-gates failed"
echo "==> gate: gitleaks"
gitleaks detect --source . --redact --no-banner || abort "gitleaks found leaks"
echo "==> gate: audit-gate"
node scripts/audit-gate.mjs || abort "audit-gate failed"

if [ "$ENV_NAME" = production ]; then
  read -r -p "Deploy sha-$SHA to PRODUCTION? Type 'deploy production': " ans
  [ "$ans" = "deploy production" ] || abort "not confirmed"
fi

echo "All gates passed."
echo "PLACEHOLDER: would deploy ghcr.io/iakash22/meetops-platform/{api,worker,web,realtime}:sha-$SHA to $ENV_NAME."
echo "Needed when a real target exists (provide via env/secret manager, never in the repo):"
echo "  DEPLOY_TARGET       deploy endpoint (cluster API, host, or platform app id)"
echo "  DEPLOY_CREDENTIALS  deploy credential (short-lived/OIDC preferred)"
echo "  DATABASE_URL        to run 'prisma migrate deploy' before rollout"
echo "Nothing was deployed."

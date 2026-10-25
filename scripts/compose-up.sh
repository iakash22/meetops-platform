#!/usr/bin/env sh
# Start the local dev stack: infra (compose.dev.yml) + apps (compose.app.yml).
# compose.app.yml is not standalone; always merge both files. LOCAL DEV ONLY.
# Extra args go to `docker compose` before `up`, e.g.:
#   scripts/compose-up.sh --profile ollama --profile local-stt --profile realtime
# Set COMPOSE_CMD=config to validate instead of starting.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
[ -f .env ] || { echo "missing .env (cp .env.example .env and edit)" >&2; exit 1; }
cmd="${COMPOSE_CMD:-up -d --build}"
if docker compose version >/dev/null 2>&1; then dc="docker compose"; else dc="docker-compose"; fi
# shellcheck disable=SC2086
exec $dc --env-file .env \
  -f infra/compose/compose.dev.yml -f infra/compose/compose.app.yml "$@" $cmd

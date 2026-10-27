#!/usr/bin/env bash
# Start dev Redis + MinIO (silo fork) as host-network containers, for boxes
# without the docker compose plugin. Credentials are read from .env (falls back
# to .env.example dev-only values); nothing is hardcoded here.
# Usage: scripts/dev-services.sh [up|down|status]
set -euo pipefail
cd "$(dirname "$0")/.."
DOCKER=${DOCKER:-docker}
ENV_FILE=.env; [ -f "$ENV_FILE" ] || ENV_FILE=.env.example
set -a; . "./$ENV_FILE"; set +a
REDIS_IMG=redis:7.4.11-alpine
MINIO_IMG=pgsty/silo:RELEASE.2026-10-18T00-00-00Z@sha256:2636fc4155d9a7e41ff58cdb65ddd13ba9304e67184e13c25bc5cb34016269d7
RP=${REDIS_PORT:-6379}; MP=${MINIO_API_PORT:-9000}; MC=${MINIO_CONSOLE_PORT:-9001}
busy() { ss -ltn | awk '{print $4}' | grep -qE "[:.]$1\$"; }
case "${1:-up}" in
  up)
    for p in $RP $MP $MC; do busy "$p" && { echo "port $p already in use; aborting" >&2; exit 1; }; done
    $DOCKER run -d --name techy-redis --network host --restart unless-stopped "$REDIS_IMG" \
      redis-server --bind 127.0.0.1 --port "$RP" --requirepass "$REDIS_PASSWORD"
    $DOCKER run -d --name techy-minio --network host --restart unless-stopped \
      -e MINIO_ROOT_USER="$STORAGE_ACCESS_KEY_ID" -e MINIO_ROOT_PASSWORD="$STORAGE_SECRET_ACCESS_KEY" \
      -v techy-minio-data:/data "$MINIO_IMG" server /data --address "127.0.0.1:$MP" --console-address "127.0.0.1:$MC"
    ;;
  down) $DOCKER rm -f techy-redis techy-minio ;;
  status)
    $DOCKER ps --filter name=techy- --format '{{.Names}} {{.Status}}'
    REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -p "$RP" ping
    curl -fsS -o /dev/null -w 'minio live: %{http_code}\n' "http://127.0.0.1:$MP/minio/health/live" ;;
  *) echo "usage: $0 [up|down|status]" >&2; exit 2 ;;
esac

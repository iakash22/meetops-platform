#!/usr/bin/env sh
# Generate random LOCAL DEV compose secrets into infra/compose/secrets/*.txt
# (gitignored). Existing files are kept unless --force. Prints file names only.
#   --from-env  take values from ./.env (POSTGRES_PASSWORD, MEETOPS_*_DB_PASSWORD,
#               REDIS_PASSWORD, STORAGE_SECRET_ACCESS_KEY) so host-run dev URLs in
#               .env keep matching the containers; implies --force.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/infra/compose/secrets"
force="${1:-}"
from_env() { # $1 = var name; value from .env without sourcing it
  sed -n "s/^$1=//p" "$root/.env" | tail -n 1 | sed 's/^"//; s/"$//'
}
umask 077
mkdir -p "$dir"
for name in postgres_password meetops_app_db_password meetops_migrator_db_password redis_password minio_root_password; do
  f="$dir/$name.txt"
  if [ "$force" = "--from-env" ]; then
    case "$name" in
      postgres_password) var=POSTGRES_PASSWORD ;;
      meetops_app_db_password) var=MEETOPS_APP_DB_PASSWORD ;;
      meetops_migrator_db_password) var=MEETOPS_MIGRATOR_DB_PASSWORD ;;
      redis_password) var=REDIS_PASSWORD ;;
      minio_root_password) var=STORAGE_SECRET_ACCESS_KEY ;;
    esac
    v="$(from_env "$var")"
    [ -n "$v" ] || { echo "missing $var in .env" >&2; exit 1; }
    printf '%s' "$v" > "$f"; echo "wrote  $f (from .env $var)"; continue
  fi
  if [ -s "$f" ] && [ "$force" != "--force" ]; then echo "keep   $f"; continue; fi
  # URL-safe (hex) so the value can be embedded in connection URLs unescaped.
  od -An -tx1 -N24 /dev/urandom | tr -d ' \n' > "$f"
  echo "wrote  $f"
done
# Containers run as non-root (node uid 1000, postgres uid 999): compose bind-mounts
# these files, so they must be readable inside. The directory itself stays 0700.
chmod 0700 "$dir"; chmod 0644 "$dir"/*.txt
echo "Host-run dev (pnpm dev) reads .env; use --from-env to keep both in sync."

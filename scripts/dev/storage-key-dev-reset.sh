#!/usr/bin/env bash
# Dev-only wipe + reseed for the org/ -> organizations/{organizationId}/ key change (PR #82).
# Run ONLY after #82 is merged, ONLY against local dev, ONLY with Akash's direct approval.
# Default is dry-run. Destructive mode needs BOTH:
#   MEETOPS_ALLOW_DEV_WIPE=yes-wipe-dev   (env guard)
#   --apply --confirm-dev-wipe=<STORAGE_BUCKET>  (flags)
# Credentials are read only from STORAGE_* and DATABASE_URL; never printed.
set -euo pipefail

APPLY=0; CONFIRM=""
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --confirm-dev-wipe=*) CONFIRM="${a#*=}" ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

die() { echo "REFUSING: $*" >&2; exit 1; }
: "${DATABASE_URL:?DATABASE_URL not set}"
: "${STORAGE_BUCKET:?STORAGE_BUCKET not set}"
: "${STORAGE_ENDPOINT:?STORAGE_ENDPOINT not set}"
: "${STORAGE_ACCESS_KEY_ID:?STORAGE_ACCESS_KEY_ID not set}"
: "${STORAGE_SECRET_ACCESS_KEY:?STORAGE_SECRET_ACCESS_KEY not set}"

# --- dev target checks (all must pass) ---
[ "${NODE_ENV:-}" = "development" ] || die "NODE_ENV must be 'development'"
[ "${STORAGE_PROVIDER:-}" = "minio" ] || die "STORAGE_PROVIDER must be 'minio' (local compose)"
case "$STORAGE_ENDPOINT" in
  http://localhost:*|http://127.0.0.1:*|http://minio:*) ;;
  *) die "STORAGE_ENDPOINT is not a local MinIO endpoint" ;;
esac
case "$STORAGE_BUCKET" in *-dev) ;; *) die "STORAGE_BUCKET must end in -dev" ;; esac
db_host="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^@]*@)?([^:/?]+).*#\2#')"
case "$db_host" in localhost|127.0.0.1|postgres) ;; *) die "DATABASE_URL host is not local" ;; esac
echo "target: bucket=$STORAGE_BUCKET endpoint=$STORAGE_ENDPOINT db_host=$db_host (credentials not shown)"

command -v mc >/dev/null || die "MinIO client 'mc' not found on PATH"
export MC_HOST_meetopsdev
MC_HOST_meetopsdev="$(printf '%s' "$STORAGE_ENDPOINT" | sed -E "s#^(https?://)#\1${STORAGE_ACCESS_KEY_ID}:${STORAGE_SECRET_ACCESS_KEY}@#")"

count() { mc ls --recursive "meetopsdev/$STORAGE_BUCKET/$1" 2>/dev/null | wc -l | tr -d ' '; }
echo "objects: total=$(count '') org/=$(count org/) organizations/=$(count organizations/)"

if [ "$APPLY" -ne 1 ]; then
  echo "DRY-RUN: would remove all objects in $STORAGE_BUCKET (bucket kept), run prisma migrate reset --force, then db:seed."
  exit 0
fi
[ "${MEETOPS_ALLOW_DEV_WIPE:-}" = "yes-wipe-dev" ] || die "set MEETOPS_ALLOW_DEV_WIPE=yes-wipe-dev"
[ "$CONFIRM" = "$STORAGE_BUCKET" ] || die "--confirm-dev-wipe must equal the bucket name"

echo "1/3 emptying bucket objects (bucket itself is kept)"
mc rm --recursive --force "meetopsdev/$STORAGE_BUCKET/" >/dev/null
echo "    remaining objects: $(count '')"
echo "2/3 resetting dev database via prisma migrate reset (applies all migrations)"
pnpm --filter @meetops/database exec prisma migrate reset --force --skip-seed
echo "3/3 seeding"
pnpm --filter @meetops/database db:seed
echo "done. Now upload a file via the app and run: $0 (dry-run) to see organizations/ count > 0 and org/ = 0"

#!/usr/bin/env bash
# Build per-app images on the box, generate an SBOM for each, and (optionally) push to GHCR.
# Usage: scripts/build-images.sh [--push]
# With --push, logs in to GHCR via --password-stdin. Token source (never argv, never echoed):
#   GHCR_TOKEN_FILE=<path to a file holding the token>, or the token piped on stdin.
#   GHCR_USER defaults to iakash22. Token needs only packages:write. Logs out on exit.
# Requires docker (buildx) and syft.
set -euo pipefail
cd "$(dirname "$0")/.."

APPS=(api worker web realtime)
PUSH=0
case "$#:${1:-}" in
  0:) ;;
  1:--push) PUSH=1 ;;
  *) echo "Usage: scripts/build-images.sh [--push]" >&2; exit 2 ;;
esac
REGISTRY="${REGISTRY:-ghcr.io}"
REPO="${IMAGE_REPO:-iakash22/meetops-platform}"
SHA="$(git rev-parse HEAD)"
OUT="dist/images/$SHA"

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty; images must map to a committed SHA." >&2; exit 1
fi
command -v docker >/dev/null || { echo "ERROR: docker not found" >&2; exit 1; }
command -v syft >/dev/null || { echo "ERROR: syft not found (https://github.com/anchore/syft)" >&2; exit 1; }
mkdir -p "$OUT"

if [ "$PUSH" = 1 ]; then
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  GHCR_USER="${GHCR_USER:-iakash22}"
  if [ -n "${GHCR_TOKEN_FILE:-}" ]; then
    [ -r "$GHCR_TOKEN_FILE" ] || { echo "ERROR: GHCR_TOKEN_FILE not readable" >&2; exit 1; }
    docker login ghcr.io -u "$GHCR_USER" --password-stdin < "$GHCR_TOKEN_FILE"
  elif [ ! -t 0 ]; then
    docker login ghcr.io -u "$GHCR_USER" --password-stdin
  else
    echo "ERROR: --push needs the token on stdin or in GHCR_TOKEN_FILE" >&2; exit 1
  fi
fi

for app in "${APPS[@]}"; do
  ref="$REGISTRY/$REPO/$app:sha-$SHA"
  echo "==> build $ref"
  docker build --network host -f "infra/docker/Dockerfile.$app" \
    --label "org.opencontainers.image.revision=$SHA" \
    --label "org.opencontainers.image.source=https://github.com/$REPO" -t "$ref" .
  echo "==> sbom $app"
  syft "docker:$ref" -o "spdx-json=$OUT/$app.spdx.json"
  if [ "$PUSH" = 1 ]; then
    echo "==> push $ref"
    docker push "$ref"
  fi
done
echo "Done. SBOMs in $OUT/. Pushed: $([ "$PUSH" = 1 ] && echo yes || echo no)."

#!/usr/bin/env bash
# Build per-app images on the box, generate an SBOM for each, and (optionally) push to GHCR.
# Usage: scripts/build-images.sh [--push]
# Push needs a prior `docker login ghcr.io` (token with write:packages) done interactively;
# this script never reads or prints credentials. Requires docker (buildx) and syft.
set -euo pipefail
cd "$(dirname "$0")/.."

APPS=(api worker web realtime)
PUSH=0; [ "${1:-}" = "--push" ] && PUSH=1
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

#!/usr/bin/env bash
# CycloneDX SBOMs for a release (P9 item #11): one for the npm/pnpm workspace, one for the desktop cargo crate.
# Usage: scripts/sbom.sh [--out DIR] [--only npm|cargo]
#
# This repo adds NO SBOM dependency (no devDependency, no lockfile change). The script uses whichever tool is
# already installed on the machine and fails clearly (exit 3) when none is:
#   npm   : syft (preferred; reads pnpm-lock.yaml)   or  cdxgen
#   cargo : cargo-cyclonedx (`cargo cyclonedx`)      or  syft (reads Cargo.lock)
# Output: $OUT/meetops-npm.cdx.json and $OUT/meetops-cargo.cdx.json (default OUT=sbom/<short-sha>), plus
# a SHA256SUMS file. Nothing is uploaded. Tool lookup honours SBOM_PATH (tests) before PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="" ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --only) ONLY="${2:?--only needs npm or cargo}"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "sbom: unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$ONLY" in ""|npm|cargo) ;; *) echo "sbom: --only must be npm or cargo" >&2; exit 2 ;; esac
[ -n "${SBOM_PATH:-}" ] && PATH="$SBOM_PATH:$PATH"
SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
OUT="${OUT:-sbom/$SHA}"
CRATE_DIR=apps/desktop/src-tauri
have() { command -v "$1" >/dev/null 2>&1; }
missing() {
  cat >&2 <<MSG
sbom: no CycloneDX generator found for $1.
  Install one of these on the release machine (not as a repo dependency):
$2
  Then re-run scripts/sbom.sh. No SBOM was written for $1.
MSG
  exit 3
}
check_json() { # file: must be CycloneDX JSON with a components array
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    if(d.bomFormat!=="CycloneDX"||!Array.isArray(d.components)){console.error("sbom: "+process.argv[1]+" is not a CycloneDX BOM");process.exit(4)}
    console.log("sbom: "+process.argv[1]+" ("+d.specVersion+", "+d.components.length+" components)")' "$1"
}
mkdir -p "$OUT"
npm_sbom() {
  local f="$OUT/meetops-npm.cdx.json"
  if have syft; then syft scan "dir:." --exclude './**/node_modules/**' --exclude "./$CRATE_DIR/**" \
      --source-name meetops-npm --source-version "$SHA" -o "cyclonedx-json=$f" -q
  elif have cdxgen; then cdxgen -t pnpm -r -o "$f" --project-name meetops-npm --project-version "$SHA" .
  else missing npm "    - syft  (https://github.com/anchore/syft)  e.g. brew install syft
    - cdxgen (https://github.com/CycloneDX/cdxgen)  e.g. a global npm install outside this repo"; fi
  check_json "$f"
}
cargo_sbom() {
  local f="$OUT/meetops-cargo.cdx.json"
  if have cargo-cyclonedx; then
    (cd "$CRATE_DIR" && cargo cyclonedx --format json --override-filename meetops-cargo.cdx >/dev/null)
    mv "$CRATE_DIR/meetops-cargo.cdx.json" "$f"
  elif have syft; then syft scan "file:$CRATE_DIR/Cargo.lock" --source-name meetops-cargo --source-version "$SHA" \
      -o "cyclonedx-json=$f" -q
  else missing cargo "    - cargo-cyclonedx  (cargo install cargo-cyclonedx --locked)
    - syft             (https://github.com/anchore/syft)"; fi
  check_json "$f"
}
[ "$ONLY" != cargo ] && npm_sbom
[ "$ONLY" != npm ] && cargo_sbom
(cd "$OUT" && sha256sum ./*.cdx.json > SHA256SUMS)
echo "sbom: wrote $OUT"

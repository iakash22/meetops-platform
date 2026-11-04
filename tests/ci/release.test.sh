#!/usr/bin/env bash
# Shell tests for scripts/sbom.sh and scripts/release-version.mjs. Uses stub tools and a throwaway git repo;
# never installs anything or touches the real working tree.  Usage: bash tests/ci/release.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   $1"; }
bad() { echo "FAIL $1: $2"; fail=1; }
run() { out="$("$@" 2>&1)"; rc=$?; }

# ---- sbom.sh --------------------------------------------------------------------------------------------------
EMPTY="$TMP/empty-bin"; mkdir "$EMPTY"
for t in bash node git sha256sum mkdir mv sed dirname cat; do ln -s "$(command -v $t)" "$EMPTY/$t"; done
run env -i HOME="$TMP" PATH="$EMPTY" "$(command -v bash)" "$ROOT/scripts/sbom.sh" --out "$TMP/o1" --only npm
[ $rc -eq 3 ] && [[ "$out" == *"no CycloneDX generator found for npm"* && "$out" == *syft* ]] && ok "npm: no tool -> exit 3 + install hint" || bad "npm no tool" "rc=$rc $out"
run env -i HOME="$TMP" PATH="$EMPTY" "$(command -v bash)" "$ROOT/scripts/sbom.sh" --out "$TMP/o1" --only cargo
[ $rc -eq 3 ] && [[ "$out" == *"for cargo"* && "$out" == *cargo-cyclonedx* ]] && ok "cargo: no tool -> exit 3 + install hint" || bad "cargo no tool" "rc=$rc $out"
run bash "$ROOT/scripts/sbom.sh" --only rust
[ $rc -eq 2 ] && ok "bad --only rejected" || bad "--only" "rc=$rc"
run bash "$ROOT/scripts/sbom.sh" --bogus
[ $rc -eq 2 ] && ok "unknown arg rejected" || bad "unknown arg" "rc=$rc"

STUB="$TMP/stub-bin"; mkdir "$STUB"
cat > "$STUB/syft" <<'S'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in cyclonedx-json=*) f="${a#cyclonedx-json=}";; esac; done
echo "$*" > "$f.args"
printf '{"bomFormat":"CycloneDX","specVersion":"1.6","components":[{"name":"x"}]}' > "$f"
S
chmod +x "$STUB/syft"
run env SBOM_PATH="$STUB" bash "$ROOT/scripts/sbom.sh" --out "$TMP/o2"
if [ $rc -eq 0 ] && [ -s "$TMP/o2/meetops-npm.cdx.json" ] && [ -s "$TMP/o2/meetops-cargo.cdx.json" ] \
   && grep -q meetops-npm.cdx.json "$TMP/o2/SHA256SUMS" && grep -q 'Cargo.lock' "$TMP/o2/meetops-cargo.cdx.json.args" \
   && grep -q 'node_modules' "$TMP/o2/meetops-npm.cdx.json.args"; then ok "syft stub: both SBOMs + SHA256SUMS"
else bad "syft stub" "rc=$rc $out"; fi
printf '#!/usr/bin/env bash\nfor a; do case "$a" in cyclonedx-json=*) echo "{}" > "${a#cyclonedx-json=}";; esac; done\n' > "$STUB/syft"
run env SBOM_PATH="$STUB" bash "$ROOT/scripts/sbom.sh" --out "$TMP/o3" --only npm
[ $rc -eq 4 ] && [[ "$out" == *"not a CycloneDX BOM"* ]] && ok "invalid tool output fails (exit 4)" || bad "invalid output" "rc=$rc $out"

# ---- release-version.mjs --------------------------------------------------------------------------------------
R="$TMP/repo"; mkdir -p "$R/apps/extension" "$R/apps/desktop/src-tauri"; cd "$R" || exit 1
git init -q; git config user.email t@example.invalid; git config user.name t; git config commit.gpgsign false
for f in package.json apps/extension/package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json; do
  printf '{\n  "name": "x",\n  "version": "0.0.0"\n}\n' > "$f"; done
c() { git commit -q --allow-empty -m "$1" ${2:+-m "$2"}; }
c "chore: init"
RV=(env RELEASE_DATE=2026-11-04 node "$ROOT/scripts/release-version.mjs")
run "${RV[@]}"
[ $rc -eq 1 ] && [[ "$out" == *"nothing to release"* ]] && ok "no releasable commits -> exit 1" || bad "nothing" "rc=$rc $out"
c "fix(api): handle x"; c "feat(web): add y"; c "not conventional"
run "${RV[@]}"
[ $rc -eq 0 ] && [[ "$out" == *"0.0.0 -> 0.1.0"* && "$out" == *"### Features"* && "$out" == *"**web:** add y"* && "$out" != *"not conventional"* ]] \
  && ok "dry run: first release 0.1.0 with sections" || bad "dry run" "rc=$rc $out"
grep -q '"version": "0.0.0"' package.json && [ ! -e CHANGELOG.md ] && ok "dry run writes nothing" || bad "dry run wrote" ""
run "${RV[@]}" --write
if [ $rc -eq 0 ] && grep -q '"version": "0.1.0"' apps/desktop/src-tauri/tauri.conf.json apps/extension/package.json \
   && grep -q '^## 0.1.0 (2026-11-04)' CHANGELOG.md; then ok "--write syncs 4 files + CHANGELOG"; else bad "--write" "rc=$rc $out"; fi
git add -A; c "chore(release): 0.1.0"; git tag v0.1.0
c "fix: z"; run "${RV[@]}"; [[ "$out" == *"0.1.0 -> 0.1.1"* ]] && ok "fix -> patch since tag" || bad "patch" "$out"
c "feat: w"; run "${RV[@]}"; [[ "$out" == *"0.1.0 -> 0.2.0"* ]] && ok "feat -> minor" || bad "minor" "$out"
c "refactor!: drop v" ; run "${RV[@]}"; [[ "$out" == *"0.1.0 -> 0.2.0"* && "$out" == *"Breaking changes"* ]] && ok "breaking on 0.x -> minor" || bad "0.x breaking" "$out"
run "${RV[@]}" --as 0.0.9; [ $rc -eq 2 ] && [[ "$out" == *"not greater"* ]] && ok "--as must increase" || bad "--as" "rc=$rc $out"
run "${RV[@]}" --as 1.0.0 --write
[ $rc -eq 0 ] && [ "$(grep -c '^## ' CHANGELOG.md)" = 2 ] && head -3 CHANGELOG.md | grep -q '^# Changelog' && ok "--as 1.0.0 prepends under header" || bad "--as write" "rc=$rc $out"
git add -A; c "chore(release): 1.0.0"; git tag v1.0.0
c "feat: q" "BREAKING CHANGE: api"; run "${RV[@]}"; [[ "$out" == *"1.0.0 -> 2.0.0"* ]] && ok "BREAKING footer on 1.x -> major" || bad "major" "$out"
run "${RV[@]}" --nope; [ $rc -eq 2 ] && ok "unknown arg rejected" || bad "rv unknown" "rc=$rc"
cd "$ROOT" || exit 1
[ $fail -eq 0 ] && echo "ALL RELEASE SCRIPT TESTS PASSED" || echo "RELEASE SCRIPT TESTS FAILED"
exit $fail

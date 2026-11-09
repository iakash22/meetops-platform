# Release mechanics: versioning, changelog, SBOM

P9 items #11 (SBOM) and #12 (release checklist, `docs/p9/release-checklist.md` §0). Both scripts are local, add no
dependencies, never commit, tag, push or upload, and are tested by `bash tests/ci/release.test.sh`.

## Versioning and changelog — `scripts/release-version.mjs`

One product version, kept in the root `package.json` (all apps were `0.0.0`; `packages/*` keep their own versions).

```bash
node scripts/release-version.mjs            # dry run: next version + changelog section since the last v* tag
node scripts/release-version.mjs --write    # bump versions and prepend CHANGELOG.md
node scripts/release-version.mjs --as 1.0.0 --write   # force a version (must be greater than the current one)
```

- Range: latest `v*` tag (or `--from <ref>`) to `HEAD`, merge commits excluded. Non-conventional subjects are skipped.
- Bump: `BREAKING CHANGE:` footer or `type!:` → major (minor while `0.x`), `feat` → minor, `fix`/`perf`/`revert` →
  patch. Nothing releasable → exit 1. The first release from `0.0.0` is `0.1.0`.
- `--write` syncs the version into `package.json`, `apps/extension/package.json` (store manifest),
  `apps/desktop/package.json` and `apps/desktop/src-tauri/tauri.conf.json` (the version Tauri ships).
  It does **not** touch `apps/desktop/src-tauri/Cargo.toml` (changing it rewrites `Cargo.lock`) or `pnpm-lock.yaml`.
- Then: review the diff, commit `chore(release): x.y.z` on a `chore/` branch, PR → `integration/phase-1`, and after
  Akash merges to `main`, tag `vX.Y.Z` on that `main` commit (only Akash merges `main`).

## SBOM — `scripts/sbom.sh`

```bash
scripts/sbom.sh                       # both SBOMs into sbom/<sha>/ (gitignored)
scripts/sbom.sh --only npm --out /tmp/sbom
```

Outputs CycloneDX JSON: `meetops-npm.cdx.json` (pnpm workspace, from `pnpm-lock.yaml`), `meetops-cargo.cdx.json`
(desktop crate, from `Cargo.lock`) and `SHA256SUMS`. Each file is checked to be a CycloneDX BOM with a
`components` array (exit 4 otherwise).

**Tool needed (not installed on the box, and deliberately not a repo dependency):** the script uses whichever is on
`PATH` and exits **3** with install hints when none is:

| Ecosystem | Preferred                                                    | Alternative                                     |
| --------- | ------------------------------------------------------------ | ----------------------------------------------- |
| npm/pnpm  | [`syft`](https://github.com/anchore/syft)                    | [`cdxgen`](https://github.com/CycloneDX/cdxgen) |
| cargo     | `cargo-cyclonedx` (`cargo install cargo-cyclonedx --locked`) | `syft`                                          |

`syft` alone covers both. Installing it on the release machine is an owner decision (it is a binary download, not
an npm package). Attach the SBOM files and `SHA256SUMS` to the release; licence review can read the same files.

## Upgrade note: realtime proxy trust (#455)

When deploying a build that includes the realtime TRUST_PROXY change (#455):

- **Set `TRUST_PROXY`** to an IP/CIDR allowlist that includes nginx (required in production;
  hop counts fail startup). The same variable is read by the API.
- **Delete `REALTIME_TRUST_PROXY_HOPS`** from staging/production env (removed; a non-zero value
  fails realtime startup). Replace it with `TRUST_PROXY`.
- Compose caution: one `TRUST_PROXY` value is passed to both API and realtime containers.

See [environment-variables.md](../00-getting-started/environment-variables.md) and
[cicd.md](../devops/cicd.md#deploy-env-realtime-trust_proxy-after-455).

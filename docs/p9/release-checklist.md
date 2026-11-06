# Release checklist

Status: draft (P9 item #12, `docs/p9/remaining-work.md`). One section per artefact. Security items live in the
pre-release security checklist owned by Tester & Security (PR #391, `docs/p9/pre-release-security-checklist.md`);
this list links to it instead of repeating it. Items marked **needs-owner** are blocked on Akash.

## 0. Every release

- [ ] Release tag cut from the commit Akash merged into `main` (only Akash merges into `main`).
- [ ] `pnpm local-gates` green on that exact SHA (install, build, size, lint, typecheck, test, gitleaks); paste the
      output into the release notes. Remote CI is not usable, so the local gate is the gate.
- [ ] `node scripts/audit-gate.mjs` reviewed; no new high advisories without a written exception.
- [ ] Tester & Security PASS on the exact SHA, and the pre-release security checklist (#391) is complete.
- [ ] Version bump and changelog entry from the Conventional Commits since the last tag:
      `node scripts/release-version.mjs --write` (`docs/13-ops/release.md`).
- [ ] SBOM generated for the release (P9 item #11): `scripts/sbom.sh` (needs `syft`, or `cdxgen` +
      `cargo-cyclonedx`, on the release machine; `docs/13-ops/release.md`).
- [ ] Migrations reviewed: forward-only, compatible with the previous app version for one release, and tested on a
      restored copy of production data (`docs/16-runbooks/backup-restore.md`).
- [ ] Fresh backup / PITR point confirmed **before** deploy.
- [ ] Rollback plan written: previous image tags, migration compatibility, feature flags to turn off.
- [ ] Feature flags set explicitly (e.g. `TASK_SYNC_ENABLED`, `MEDIA_STORAGE_ENABLED`).

## 1. Web

- [ ] `pnpm --filter @meetops/web build` and `pnpm size` within the bundle budget.
- [ ] Production `VITE_*` values point at the production API origin; no dev URLs.
- [ ] Smoke test after deploy: sign up, sign in, create an org, upload a recording, see transcript and summary.

## 2. API, worker and realtime images

- [ ] Images built from the tagged SHA (`infra/docker`), tagged with version and SHA; previous tags kept.
- [ ] Production env validated at startup (`loadConfig`, `loadAIEnv`); secrets from the secret manager (ADR-016,
      **needs-owner**), never baked into images.
- [ ] `pnpm db:migrate` (deploy mode) run once, before the new API starts.
- [ ] `/health` and `/ready` green; `/metrics` scraped; alert rules active (P9 item #13).
- [ ] Worker queues drain normally; no rise in failed jobs for 30 minutes after deploy.
- [ ] Rollback: redeploy the previous tags; migrations stay (they are backwards compatible).

## 3. Browser extension (Chrome Web Store, Firefox AMO)

- [ ] Manifest version bumped; production API origin and extension id allowlist set.
- [ ] Store listing, privacy disclosures and screenshots current (**needs-owner**: publisher accounts).
- [ ] Package built from the tagged SHA and submitted; review status tracked.
- [ ] Pairing (ADR-005) smoke-tested against production.

## 4. Desktop (Tauri)

- [ ] Real bundle id replaces `ai.meetops.desktop.todo-owner` (**needs-owner**).
- [ ] macOS signed with Developer ID and notarized; Windows code-signed (**needs-owner**: certificates).
- [ ] Update feed points at the new version; the previous version stays available for rollback.
- [ ] Sign-in (ADR-012), offline recording and upload smoke-tested on each OS.

## 5. Mobile (Expo / React Native)

- [ ] Real bundle ids replace `com.example.meetops`; EAS credentials set (**needs-owner**).
- [ ] Native Kotlin/Swift code compiled and the device checklists in `docs/mobile/` passed on real devices.
- [ ] App Store privacy labels and the Play data-safety form match what the app records (**needs-owner**).
- [ ] Builds submitted via EAS; staged rollout on Play, phased release on iOS.

## 6. After release

- [ ] Tag pushed; release notes published with the gate output and known issues.
- [ ] Watch 5xx rate, latency, queue depth and `/ready` for 24 hours.
- [ ] Update `docs/PHASE_STATUS.md`.

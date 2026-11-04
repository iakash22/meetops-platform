# P9 dependency audit

Run 3 Nov 2026 (IST) on `integration/phase-1` @ `78d8968b` with `pnpm audit --json` (pnpm 9.12.3, lockfile only, no install).
Totals: **0 critical, 2 high, 10 moderate, 2 low** (14 findings, 7 distinct packages).

## Dependabot state

- **Alerts API:** `GET /repos/.../dependabot/alerts` returns _Resource not accessible by personal access token_. The agent token lacks Dependabot alerts read, so GitHub's alert list is **not** reconciled here (owner action: grant `security_events`/Dependabot alerts read, or paste the alert list).
- **Open Dependabot PRs:** none.
- **Stale Dependabot branches** (all PRs closed; delete the branches):

  | Branch                                                                    | PR   | State                          | Notes                                                                                                              |
  | ------------------------------------------------------------------------- | ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
  | `dependabot/github_actions/integration/phase-1/github-actions-004c418426` | #121 | merged 25 Oct                  | 0 ahead; safe to delete                                                                                            |
  | `dependabot/npm_and_yarn/npm_and_yarn-2548c40aa2`                         | #113 | closed, unmerged (base `main`) | zod 3.25.76 → 4.6.6, **major**, 1521 behind; do not revive                                                         |
  | `dependabot/npm_and_yarn/npm_and_yarn-6ea542fd51`                         | #44  | closed, unmerged (base `main`) | vitest 2→4, fastify, vite; **major**, 2350 behind; obsolete (integration already has fastify ^5.12.7, vite ^7.3.7) |

  No Dependabot PR matches any current advisory, so every fix below needs a hand-made lockfile PR.

## Fix list

Reachability: **runtime** = shipped in an API/worker/web/realtime image or app bundle; **mobile-build** = Expo/Metro/Jest toolchain for `apps/mobile` (runs on dev/CI machines, not on devices or servers); **dev** = lint/test/build tooling only.

| #   | Package (installed)                      | Advisory                                                                | Sev      | Pulled in by                               | Reach                     | Fixed in               | Fix type                                           | Recommendation                                                                                                                                                                                     |
| --- | ---------------------------------------- | ----------------------------------------------------------------------- | -------- | ------------------------------------------ | ------------------------- | ---------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | image-size 1.2.1                         | GHSA-5p2g-fcmc-qvqq / CVE-2025-71329 (JXL/HEIF infinite loop DoS)       | high     | `metro@0.81.5` (Expo SDK 52)               | mobile-build              | 2.0.3                  | major of a transitive; Metro pins `^1`             | `pnpm.overrides` `metro>image-size: 2.0.3` only if Metro asset build still passes; else accept until Expo SDK upgrade. Not reachable from untrusted input (only bundles our own assets).           |
| 2   | image-size 1.2.1                         | GHSA-w3rx-r6r6-pgpr / CVE-2025-71330 (ICNS loop DoS)                    | high     | same                                       | mobile-build              | 2.0.3                  | same                                               | Same fix as #1, one PR.                                                                                                                                                                            |
| 3   | ajv 8.11.0                               | GHSA-2g4f-4pwh-qvx6 / CVE-2025-69873 (ReDoS with `$data`)               | moderate | `expo-dev-launcher@5.0.35`                 | mobile-build (dev client) | 8.18.0                 | lockfile-only (minor within ^8)                    | Override `ajv@<8.18: ^8.18.0`. API's Fastify ajv is already 8.20.0 and does not use `$data`.                                                                                                       |
| 4   | uuid 10.0.0 / 8.3.2 / 7.0.3              | GHSA-w5hq-g745-h8pq / CVE-2026-41907 (v3/v5/v6 buf bounds)              | moderate | Expo toolchain (`@expo/*`, `xcode`), jest  | mobile-build/dev          | 11.1.1                 | major for 7/8/10 consumers                         | Low risk (we don't pass `buf`). Override only 10.x→11.1.1 if tests pass; otherwise accept-with-note. Check no runtime package imports `uuid` (they use `node:crypto.randomUUID`).                  |
| 5   | glob 10.5.0 / 13.0.6                     | GHSA-3g3m-2fjr-6pw4 / CVE-2026-118773 (AbortSignal bypass)              | moderate | Expo config, jest, rimraf-style tooling    | dev                       | 14.0.2                 | 13→14 major; 10→14 major                           | Accept; dev-only, no untrusted patterns. Re-check after Expo upgrade.                                                                                                                              |
| 6   | minimatch 3.1.5 / 5.1.9 / 9.0.9 / 10.2.6 | GHSA-g3hv-75wg-m249 / CVE-2026-118764 (globparts DoS)                   | moderate | eslint, jest, glob, Expo                   | dev                       | 11.0.1                 | major for all                                      | Accept; dev-only. Patterns come from our config, not users.                                                                                                                                        |
| 7   | esbuild 0.27.7                           | GHSA-g7r4-m6w7-qqqr (arbitrary file read via dev server on **Windows**) | low      | `vite@7.3.7` (web, desktop, extension/WXT) | dev (dev server)          | 0.28.1                 | lockfile-only if vite range allows; else vite bump | Owner's machine is Windows (`E:\Project\...`), so **do fix**: add override `esbuild@0.27: ^0.28.1` or move vite to a release using 0.28; until then never run `vite --host` on untrusted networks. |
| 8   | deepmerge 4.3.1                          | GHSA-gcqx-w48m-w2h4 / CVE-2026-93753 (prototype poisoning)              | low      | `@expo/config-plugins`, jest-config        | mobile-build/dev          | **no patched release** | n/a                                                | Accept; inputs are our own config files. Track upstream.                                                                                                                                           |

### Recommended order

1. **One lockfile PR** (`chore/deps-audit-overrides`, coordinated with the coordinator's single-lockfile-branch window): overrides for esbuild ≥0.28.1 (#7) and ajv ≥8.18.0 (#3). Gate: full `pnpm -w build`, web bundle-size check, mobile `expo export` smoke.
2. **Try** image-size 2.0.3 override for Metro (#1, #2) in the same PR; drop it if `expo export` breaks.
3. Accept-with-note: #4, #5, #6, #8 (dev/mobile-build only, no untrusted input). Record in the release checklist risk register; revisit at the Expo SDK 53+ upgrade.
4. Delete the three stale Dependabot branches (owner/coordinator action).
5. Owner: grant Dependabot alerts read so this list can be reconciled against GitHub's alerts (earlier push notice said 3 high / 4 moderate / 1 low on `main`).
6. Wire the existing `scripts/audit-gate.mjs` into CI to fail on **new** high/critical findings, with an allowlist file for the accepted items above (each entry with an expiry date).

No server image (api/worker/realtime) or web bundle package has an open advisory. `pnpm audit --prod` still reports 2 high / 8 moderate / 1 low, because `expo`/`metro` are production dependencies of `apps/mobile`; they run at bundle time (and `expo-dev-launcher` only in dev-client builds), not in the release app.

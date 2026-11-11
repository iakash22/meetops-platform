# Plan: upgrade apps/mobile to Expo SDK 55 / React Native 0.83 (RE-03, RE-04)

Status: proposal. Needs Maddy's Expo/RN decision (AR-5). Owner: Mobile, with DevOps for the lockfile slot and the audit gate.
Baseline: `integration/phase-1` @ `e4aceac` (merge of #342, 31 Oct 2026 20:49 IST).
Risk exceptions: RE-03 (`node-forge`) and RE-04 (`image-size`) are both **closed** (RE-04 on 11 Nov 2026 through the
#412 override and metro patch; see `docs/12-security/risk-exceptions.md`). This upgrade no longer has a gate deadline.
Version and advisory facts below were checked against the npm registry, the GitHub Advisory Database and the Expo
release notes on 1 Nov 2026 (IST). Re-check them before the lockfile PR.

## 0. Summary

- **RE-04 no longer needs this upgrade** (update 11 Nov 2026: #412 overrides image-size to `^2.0.3` and patches
  metro 0.81.5, so the lockfile resolves only 2.0.4 and the gate rows are removed). Original reasoning: `image-size@1.2.1` (GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr, both high, fixed in
  2.0.3) reaches us only through `react-native@0.76.9` → `@react-native/community-cli-plugin@0.76.9` → `metro@0.81.5`.
  Metro dropped `image-size` in **0.83.8** (2026-08-19). The oldest Expo SDK that pins a Metro without it is **SDK 55**.
- **RE-03 does not need this upgrade.** Root `pnpm.overrides` already forces `node-forge@<1.4.2` to `1.4.2` (b9521567,
  28 Oct). GitHub lists no advisory affecting 1.4.2. `pnpm audit` on the baseline reports no `node-forge` finding, so the
  RE-03 row in the gate is dormant. Remove it in a docs + gate PR (no lockfile change). See §7.
- **New blocker, not fixed by any SDK we can take on Node 20:** GHSA-qr28-fpjm-wq7f (CVE-2026-118664, **high**,
  published 29 Oct 2026), `decode-uri-component <=0.5.0`, fixed in 0.5.1. It comes in through `apps/mobile` →
  `query-string@7.1.3`. `scripts/audit-gate.mjs` **fails on the baseline today** because of it. See §3.4.
- Target: `expo ~55.0.32`, `react-native 0.83.10`, `react 19.2.0`. One lockfile PR, about 4.5–7 engineer-days including
  device checks. It needs Node `>=20.19.4` (the box has 20.19.2).

## 1. Inventory (baseline)

| Package (apps/mobile)                     | Declared    | SDK 55 bundled (`expo@55.0.32` `bundledNativeModules.json`)   |
| ----------------------------------------- | ----------- | ------------------------------------------------------------- |
| `expo`                                    | `~52.0.49`  | `~55.0.32`                                                    |
| `react-native`                            | `0.76.9`    | `0.83.10`                                                     |
| `react` / `react-dom`                     | `18.3.1`    | `19.2.0`                                                      |
| `expo-audio`                              | `~0.3.5`    | `~55.0.18`                                                    |
| `expo-file-system`                        | `~18.0.12`  | `~55.0.26`                                                    |
| `expo-router`                             | `~4.0.22`   | `~55.0.18`                                                    |
| `expo-constants` / `-crypto` / `-linking` | 17 / 14 / 7 | `~55.0.17` / `~55.0.19` / `~55.0.17`                          |
| `expo-secure-store` / `-status-bar`       | 14 / 2      | `~55.0.18` / `~55.0.6`                                        |
| `expo-dev-client`                         | `~5.0.20`   | `~55.0.41`                                                    |
| `react-native-screens`                    | `~4.4.0`    | `~4.23.0`                                                     |
| `react-native-safe-area-context`          | `4.12.0`    | `~5.6.2`                                                      |
| `@react-native-community/netinfo`         | `11.4.1`    | `11.5.2`                                                      |
| `jest-expo`                               | `~52.0.6`   | `~55.0.22` (depends on `react-test-renderer@19.2.0`)          |
| `react-test-renderer`                     | `18.3.1`    | `19.2.0` (match React)                                        |
| `@testing-library/react-native`           | `^12.9.0`   | `^13.3.3` (13.x allows React 19; 14.x needs Node `^22.13`)    |
| `query-string`                            | `^7.1.3`    | kept: `expo-router@55` still depends on `query-string ^7.1.3` |

Also in scope: four local Expo modules in `apps/mobile/modules` (`backup-exclusion`, `chunk-crypto`, `live-activity`,
`recording-service`; Swift and Kotlin, all on the Expo Modules API through `requireOptionalNativeModule`), two config
plugins (`withRecordingCompliance`, `withLiveActivity`), the `targets/RecordingLiveActivity` widget, and root
`package.json` items that are tied to `@expo/cli@0.22.28`:

- `pnpm.patchedDependencies["@expo/cli@0.22.28"]` (tar 7 default-export patch);
- `pnpm.overrides["@expo/cli>tar"]`, `["@expo/plist>@xmldom/xmldom"]` and `["@expo/metro-config>postcss"]`.

## 2. Target version and why

| SDK | RN      | React  | Metro used                                                     | `image-size` gone?                             | Node engines (RN)                 | Verdict                                                      |
| --- | ------- | ------ | -------------------------------------------------------------- | ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| 53  | 0.79.6  | 19.0.0 | RN plugin `^0.82` (all 0.82.x depend on `image-size ^1.0.2`)   | no                                             | `>=18`                            | does not clear RE-04                                         |
| 54  | 0.81.5  | 19.1.0 | `@expo/metro ~54.2.0` pins `metro 0.83.3`                      | no                                             | `>=20.19.4`                       | does not clear RE-04                                         |
| 55  | 0.83.10 | 19.2.0 | `@expo/metro ~55.1.2` pins `metro 0.83.8`; RN plugin `^0.83.6` | **yes**                                        | `>=20.19.4`                       | **recommended**                                              |
| 56  | 0.85.3  | 19.2.3 | `@expo/metro ~56.0.2` pins `metro 0.84.5`                      | yes                                            | `^20.19.4 \|\| ^22.13 \|\| ^24.3` | fallback; iOS minimum goes to 16.4                           |
| 57  | 0.86.3  | 19.2.3 | `metro 0.84.5`                                                 | yes                                            | same as 56                        | follow-up; Hermes v1 regressions are called out in its notes |
| 58  | 0.88.1  | 19.3.0 | `metro 0.87.1`                                                 | yes, and `expo-router@58` drops `query-string` | `^22.13 \|\| ^24.3`               | blocked: the team toolchain is Node 20                       |

Why SDK 55:

- It is the smallest jump that removes `image-size` (Metro 0.83.8+). It is still patched: `expo@55.0.32` was
  published 21 Oct 2026, and the `sdk-55` dist-tag points to it.
- It stays on Node 20 (Expo lists `^20.19.4` as supported for SDK 55) and on iOS 15.1 minimum, which matches our
  podspecs (`s.platforms = { :ios => '15.1' }`).
- SDK 56+ adds an iOS 16.4 minimum and a bigger RN jump. Nothing in RE-03/RE-04 needs it. Plan SDK 56/57 as a separate,
  unhurried upgrade after RE-04 is closed.
- SDK 58 is the only option that also drops `query-string`/`decode-uri-component`, but RN 0.88 requires Node 22. That
  is a repo-wide toolchain change (CI matrix, engines `>=20.19 <25`, corepack images), so it is out of scope here.

Expo recommends upgrading one SDK at a time. We will make a single lockfile PR from 52 to 55, but work through the
53 → 54 → 55 breaking-change lists in order as separate commits on the branch (§4).

## 3. Breaking changes that affect apps/mobile

Checked against the SDK 53, 54 and 55 release notes and our code at `e4aceac`.

### 3.1 Must change

1. **New Architecture is mandatory (SDK 55 drops the Legacy Architecture; `newArchEnabled` is removed).**
   `app.config.ts` does not set `newArchEnabled`, and SDK 52 defaults it to off when it is absent, so every native
   build we have tested so far ran on the **legacy** architecture. Our four local modules use the Expo Modules API,
   which supports the New Architecture. Even so, the foreground service (`recording-service`), Keystore/CryptoKit
   (`chunk-crypto`), backup exclusion and the Live Activity must be re-tested on device. Nothing in JS calls
   `NativeModules` directly (checked with `rg`).
2. **`expo-file-system` default export changed (SDK 54).** The legacy API now lives at `expo-file-system/legacy`.
   We use the legacy API (`documentDirectory`, `cacheDirectory`, `getInfoAsync`, `readAsStringAsync`,
   `writeAsStringAsync`, `makeDirectoryAsync`, `readDirectoryAsync`, `deleteAsync`) through
   `src/record/expoAudio.ts` (`require('expo-file-system')`, twice), `src/record/fileChunkStore.ts` and
   `src/record/recorderFiles.ts`. Change both requires to `require('expo-file-system/legacy')`.
   `expo-file-system@55.0.26` still exports `./legacy`, although the SDK 54 notes say Expo plans to remove it. Moving to
   the object API is a follow-up before SDK 56.
3. **`expo-audio` 0.3 → 55.x.** `src/record/expoAudio.ts` builds the recorder directly with
   `new a.AudioModule.AudioRecorder({...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: false})` and calls
   `setAudioModeAsync({ allowsRecording, playsInSilentMode, shouldPlayInBackground, interruptionMode: 'doNotMix' })`,
   `getRecordingPermissionsAsync` and `requestRecordingPermissionsAsync`. The SDK 55 notes add background recording
   and "reworked Android foreground service handling". Two things to check:
   - Re-type-check the direct `AudioModule.AudioRecorder` constructor and the audio-mode keys.
   - Make sure expo-audio's own foreground service does not clash with `modules/recording-service`. If it adds a
     service through its config plugin, keep ours and leave expo-audio's background-recording option off.
4. **React 18 → 19.2.** Bump `react`, `react-dom`, `react-test-renderer` to `19.2.0`, `@types/react` to `~19.2`, and
   `@testing-library/react-native` to `^13.3.3`. `react-test-renderer` is deprecated in React 19 but is still what
   `jest-expo@55` uses, so the tests keep working. The `act()` usage in `record`, `ui` and `uploads-screen` tests is
   compatible, but expect new "not wrapped in act" warnings.
5. **Remove the `@expo/cli@0.22.28` patch and the `@expo/cli>tar` override.** `@expo/cli@55.0.37` no longer
   depends on `tar`. pnpm 9 fails the install if a `patchedDependencies` entry matches nothing, so remove the entry
   and `patches/@expo__cli@0.22.28.patch` in the same PR. Keep `@expo/plist>@xmldom/xmldom ^0.8.15` (`@expo/plist@0.5.4`
   still allows `^0.8.8`) and `@expo/metro-config>postcss ^8.5.18` (55.0.27 asks for `^8.5.14`), then re-check both
   with `pnpm why`.
6. **Node `>=20.19.4`.** RN 0.83 and `@react-native/*@0.83` declare `node >= 20.19.4`. The box runs 20.19.2. Raise root
   `engines.node` to `>=20.19.4 <25` and confirm CI's `node-version: 20` resolves to 20.19.4 or newer.
7. **Android edge-to-edge is always on (SDK 54, Android 16 target).** `RecordingBanner` already uses
   `useSafeAreaInsets()`. Check that the tab bar and the auth screens do not draw under the system bars.
   `<StatusBar style="light" />` in `app/_layout.tsx` uses no deprecated props.

### 3.2 Check, probably no code change

- `expo-router` 4 → 55 (v5/v6 changes; `reset` → `resetOnFocus` is only for headless tabs, which we do not use). We use
  `Stack`, `Tabs`, `Link`, `Redirect`, `useRouter`, `useLocalSearchParams` and `useGlobalSearchParams`.
  `experiments.typedRoutes` stays `false`.
- `react-native-safe-area-context` 4 → 5 and `react-native-screens` 4.4 → 4.23 (Fabric-only paths).
- Metro 0.83 moved internals from `metro/src/*` to `metro/private/*`. Our `metro.config.js` only uses
  `expo/metro-config`. Keep `unstable_enablePackageExports` and the monorepo `watchFolders`/`nodeModulesPaths`.
  `experiments.autolinkingModuleResolution` is on by default in monorepos in SDK 55.
- `babel-preset-expo` 55 with `enableBabelRuntime: false` (still supported). SDK 54 turns on
  `experimentalImportSupport` by default. Watch `bundle:check` for ESM/CJS interop errors.
- Swift 6 language mode in `ExpoModulesCore` 55. Our Swift modules (`ChunkCryptoModule`, `LiveActivityModule`,
  `BackupExclusionModule`) may hit strict-concurrency errors under Xcode 26, which SDK 55 requires.
- `app.config.ts` is now transpiled with the project's TypeScript. `release-config.test.ts` covers the output.
- Unhandled promise rejections are logged as errors (SDK 54). Expect them to show up in dev builds.
- `jest.config.js` `transformIgnorePatterns` and the `@meetops/contracts` mapper are unchanged.

### 3.3 Not affected

`expo-av` (not used), `notification` app config (not used), JSC (we use Hermes), Reanimated (not a dependency),
`SafeAreaView` from RN (not used).

### 3.4 `decode-uri-component` (GHSA-qr28-fpjm-wq7f): separate from this upgrade

- Path: `apps/mobile` → `query-string@7.1.3` → `decode-uri-component@0.2.2`. The only fix is `0.5.1`, which is
  ESM-only (`"type": "module"`). `query-string@7` `require()`s it. `query-string` latest (10.0.0) needs Node 22.
- `expo-router` 55, 56 and 57 all still depend on `query-string ^7.1.3`, so no SDK we can take on Node 20 removes it.
- `apps/mobile/src` does not import `query-string` (it is a direct dependency only because expo-router 4 did not
  declare it; see `apps/mobile/README.md`). Dropping it would not remove the transitive copy.

Options, for Security and Maddy to choose from. All of them are outside this plan.

- (a) A time-boxed RE-05 exception, with the reason "mobile JS bundle; inputs are our own route params".
- (b) A pnpm patch of `query-string@7.1.3` that inlines a fixed decoder (a lockfile change, so it needs a slot).
- (c) Wait for SDK 58 and Node 22.

Until one of these lands, `audit` fails on every PR.

## 4. Ordered steps

All in **one lockfile PR** (`chore(mobile): upgrade to Expo SDK 55`) after the lockfile slot is granted. Make separate
commits so a reviewer can follow them:

1. Branch from the then-current `integration/phase-1`. Confirm that `pnpm audit` and `node scripts/audit-gate.mjs`
   show only RE-04 (and RE-05/qr28 if it has not been resolved yet).
2. Root: raise `engines.node` to `>=20.19.4 <25`. Remove the `@expo/cli@0.22.28` patch, its patch file and the
   `@expo/cli>tar` override.
3. In `apps/mobile`, run `pnpm dlx expo@55 install expo@~55.0.32 --fix`, or set the §1 versions by hand. Then run
   `pnpm install` once from the root. **Do not delete `pnpm-lock.yaml`.** Let pnpm update only the changed importers.
4. Run `npx expo-doctor@latest` and fix what it reports (duplicate native modules, peer ranges).
5. Code changes from §3.1:
   - change the `expo-file-system/legacy` imports;
   - fix the `expo-audio` types and audio mode;
   - bump React 19 and the testing-library versions;
   - fix any remaining type errors.
6. Native: `npx expo prebuild --clean`, then local or EAS **development** builds for Android and iOS (Xcode 26).
7. Device checklist (§5), and fix anything it finds.
8. Gate PR, same branch: delete the RE-04 rows from `scripts/audit-gate.mjs` and mark RE-04 closed in
   `docs/12-security/risk-exceptions.md`. Do the same for RE-03 if it has not already gone in its own PR.
9. Update `apps/mobile/README.md` (version notes, overrides list) and `docs/mobile/plan.md`.

## 5. Test and verification

- `pnpm --filter @meetops/mobile typecheck`, `lint` and `test` (`jest --ci && pnpm run bundle:check`, which exports
  both platforms through Metro).
- `pnpm why image-size` returns nothing. `pnpm why metro` shows only `0.83.8` or newer. `pnpm why node-forge` shows only
  `1.4.2` (`@expo/cli@55` still depends on `node-forge ^1.3.3`, so the override keeps working).
- `node scripts/audit-gate.mjs` passes with RE-04 removed.
- Device checklist on one Android (API 34+) and one iOS (17+) device. Use `docs/mobile/*-device-build-checklist.md`
  and `e2e/record-consent.yaml` (Maestro).
  - Sign in, sign out, org switch; the secure-store token survives a restart.
  - Consent, mic permission, and the Android 13+ notification permission prompt.
  - Record, pause, background, resume and stop. The Android foreground service notification shows and stops. The iOS
    Live Activity starts, updates and ends.
  - Chunk encryption self-test passes, chunks are sealed on disk, and the files are excluded from backup.
  - Upload queue: offline, then online (netinfo), and a retry.
  - Deep links (`deep-link.test.tsx` cases) on device.
  - Edge-to-edge layout on Android 15/16.
- `gitleaks` over the branch, plus the full turbo `lint typecheck test build` with `--concurrency=2`.

## 6. Lockfile sequencing

Only one lockfile PR at a time. The order in `meetops-reports/dependency-triage.md` §6.3 puts the Expo bump last
(Z → #7 → D3b′ → D5 → D4 → D6 → Expo). Two findings change that:

- RE-01 (`braces`) no longer needs a lockfile change, because GHSA-vfj7-8cjw-p6xm was **withdrawn** on 23 Oct 2026. See
  `docs/plans/tailwind4-migration.md`. D4 (Tailwind 4) therefore has no deadline.
- RE-04 has a hard date (24 Nov). The Expo PR needs about 2 days of review and device time after it is built.

Proposed order: finish whichever lockfile PR currently holds the slot, then **Expo SDK 55 next**, ahead of D4/D6. Ask
the coordinator for the slot by **10 Nov 2026** at the latest. If the decode-uri-component fix is option (b), it is a
lockfile change too, so either fold it into the Expo PR or run it straight after.

## 7. RE-03: close without a lockfile change

- GHSA-86w9-cpqp-85rv affects `node-forge <= 1.4.0`. `node-forge` 1.4.1 and 1.4.2 were published on 27 Oct 2026.
- The lockfile on `e4aceac` resolves every path (extension `@devicefarmer/adbkit`, mobile `@expo/cli`, RN
  `selfsigned@2.4.1`) to `node-forge@1.4.2`, and `pnpm audit` reports no `node-forge` finding.
- Action: a docs + gate PR removes the RE-03 row (`versions: ['1.4.0']`) and marks RE-03 closed in
  `docs/12-security/risk-exceptions.md`. Keep the `node-forge@<1.4.2` override until the extension (wxt 0.21) and
  mobile (SDK 55) upgrades have each been checked with `pnpm why node-forge`.

## 8. Rollback

- Before merge: close the PR. Nothing else on `integration/phase-1` depends on it.
- After merge: `git revert -m 1 <merge-sha>` (a plain revert, no force push). That restores `pnpm-lock.yaml`,
  `package.json`, the patch file and the gate rows together. The revert is itself a lockfile PR, so tell the
  coordinator.
- If it is reverted after 24 Nov, RE-04 has to be re-excepted with a new expiry (Security sign-off). Do not edit the
  expired row in place.
- Builds: development and preview channels in `eas.json`. Keep the last SDK 52 dev build installed on the test devices
  until the checklist passes. Do not publish an OTA update from the SDK 55 runtime to an SDK 52 binary; the runtime
  versions differ.

## 9. Estimate

| Work                                                           | Engineer-days |
| -------------------------------------------------------------- | ------------- |
| Version bump, lockfile, expo-doctor, removing the patch        | 0.5           |
| Code changes (file-system legacy, expo-audio, React 19, types) | 1–1.5         |
| Native builds (prebuild, Xcode 26, Swift 6 fixes, Gradle)      | 1–2           |
| Device checklist on both platforms, and fixes                  | 1.5–2         |
| Gate/docs updates, review rounds                               | 0.5–1         |
| **Total**                                                      | **4.5–7**     |

## 10. Risks

| Risk                                                                                   | Mitigation                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| First New Architecture build exposes native-module bugs (foreground service, Keystore) | Start the native build on day 1. The modules are small and already on the Expo Modules API.   |
| expo-audio's reworked foreground service clashes with `recording-service`              | Keep expo-audio background recording off. Device-test background capture on Android 14+.      |
| Swift 6 strict concurrency errors in local modules                                     | Fix with `@MainActor`/`Sendable`, or lower the module's Swift language mode in its podspec.   |
| `pnpm install` churns unrelated importers                                              | Review the lockfile diff by importer. Only `apps/mobile` and root should change.              |
| RE-04 deadline missed                                                                  | Ask for the slot by 10 Nov. Fallback: a Security-approved extension of RE-04 with a new date. |
